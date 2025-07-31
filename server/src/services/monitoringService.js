const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');
const WebhookService = require('./WebhookService');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
        this.webhookService = new WebhookService();
        this.isMonitoring = false;
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0,
            startTime: null
        };
    }

    async startMonitoring() {
        if (this.isMonitoring) {
            console.log('⚠️ Monitoring is already running');
            return;
        }

        console.log('🚀 Starting wallet monitoring with webhooks...');
        this.isMonitoring = true;
        this.stats.startTime = Date.now();

        try {
            await this.webhookService.initialize();
            console.log('✅ Webhook monitoring started successfully');
        } catch (error) {
            console.error('❌ Failed to start webhook monitoring:', error.message);
            this.isMonitoring = false;
            throw error;
        }
    }

    stopMonitoring() {
        if (!this.isMonitoring) {
            console.log('⚠️ Monitoring is not running');
            return;
        }

        console.log('⏹️ Stopping monitoring...');
        this.webhookService.close();
        this.isMonitoring = false;
        console.log('✅ Monitoring stopped');
    }

    async addWallet(address, name = null) {
        try {
            new PublicKey(address);
            
            const wallet = await this.webhookService.addWallet(address, name);
            
            this.stats.totalWallets++;
            
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            await this.webhookService.removeWallet(address);
            
            this.stats.totalWallets = Math.max(0, this.stats.totalWallets - 1);
            
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    getStatus() {
        const webhookStatus = this.webhookService.getStatus();
        
        return {
            isMonitoring: this.isMonitoring,
            webhook: {
                isConnected: webhookStatus.isConnected,
                activeWallets: webhookStatus.activeWallets,
                processedSignatures: webhookStatus.processedSignatures,
                reconnectAttempts: webhookStatus.reconnectAttempts
            },
            stats: {
                ...this.stats,
                uptime: this.stats.startTime ? Date.now() - this.stats.startTime : 0,
                webhookStats: webhookStatus.stats
            }
        };
    }

    async getDetailedStats() {
        try {
            const webhookStats = await this.webhookService.getDetailedStats();
            const dbStats = await this.db.getMonitoringStats();
            const topTokens = await this.db.getTopTokens(5);
            
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens,
                webhook: webhookStats
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async manualSyncWallet(walletAddress, limit = 10) {
        try {
            console.log(`🔄 Manual sync for wallet ${walletAddress.slice(0, 8)}...`);
            
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            const pubkey = new PublicKey(walletAddress);
            const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit });

            let processedCount = 0;
            for (const sig of signatures) {
                try {
                    const txData = await this.processTransactionManually(sig, wallet);
                    if (txData) {
                        processedCount++;
                    }
                } catch (error) {
                    console.error(`❌ Error processing transaction ${sig.signature}:`, error.message);
                }
                
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            console.log(`✅ Manual sync completed: ${processedCount} transactions processed`);
            return { processedCount, totalChecked: signatures.length };

        } catch (error) {
            console.error(`❌ Error in manual sync for ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async processTransactionManually(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                return null;
            }

            const existingTx = await this.db.getTransactionBySignature(sig.signature);
            if (existingTx) {
                console.log(`ℹ️ Transaction already exists: ${sig.signature.slice(0, 8)}...`);
                return null;
            }

            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                return null;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            
            let transactionType, solAmount;
            if (solChange < -0.001) {
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
            } else if (solChange > 0.001) {
                transactionType = 'sell';
                solAmount = solChange;
            } else {
                return null;
            }

            const tokenChanges = this.analyzeTokenChanges(tx.meta, transactionType);
            if (tokenChanges.length === 0) {
                return null;
            }

            return await this.db.withTransaction(async (client) => {
                const solPrice = await fetchHistoricalSolPrice(new Date(sig.blockTime * 1000));
                const usdAmount = solPrice * solAmount;

                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        ${transactionType === 'buy' ? 'sol_spent, usd_spent' : 'sol_received, usd_received'}
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;

                let result;
                try {
                    result = await client.query(query, [
                        wallet.id,
                        sig.signature,
                        new Date(sig.blockTime * 1000).toISOString(),
                        transactionType,
                        solAmount,
                        usdAmount
                    ]);
                } catch (error) {
                    if (error.code === '23505') {
                        return null;
                    }
                    throw error;
                }

                const transaction = result.rows[0];

                for (const tokenChange of tokenChanges) {
                    await this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType);
                }

                await this.db.updateWalletStats(wallet.id);

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    usdAmount,
                    tokensChanged: tokenChanges.length
                };
            });

        } catch (error) {
            console.error(`❌ Error processing transaction manually ${sig.signature}:`, error.message);
            return null;
        }
    }

    analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];

        (meta.postTokenBalances || []).forEach((post) => {
            const pre = meta.preTokenBalances?.find(p =>
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );

            if (!pre) return;
            if (post.mint === WRAPPED_SOL_MINT) return;

            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            if (transactionType === 'buy' && rawChange <= 0) return;
            if (transactionType === 'sell' && rawChange >= 0) return;

            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange),
                decimals: post.uiTokenAmount.decimals,
            });
        });

        return tokenChanges;
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
            if (!tokenInfo) {
                return;
            }

            const tokenUpsertQuery = `
                INSERT INTO tokens (mint, symbol, name, logo_uri, decimals) 
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;

            const tokenResult = await client.query(tokenUpsertQuery, [
                tokenChange.mint,
                tokenInfo.symbol,
                tokenInfo.name,
                tokenInfo.logoURI,
                tokenInfo.decimals
            ]);

            const tokenId = tokenResult.rows[0].id;
            const amount = tokenChange.rawChange / Math.pow(10, tokenChange.decimals);

            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;

            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);

        } catch (error) {
            console.error(`❌ Error saving token operation for ${tokenChange.mint}:`, error.message);
            throw error;
        }
    }

    async getWalletInfoFromNode(address) {
        return await this.webhookService.getWalletInfoFromNode(address);
    }

    async getNodeStats() {
        return await this.webhookService.getNodeStats();
    }

    async close() {
        console.log('🛑 Shutting down monitoring service...');
        this.stopMonitoring();
        await this.db.close();
        await redis.quit();
    }
}

module.exports = WalletMonitoringService;