const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const WebSocket = require('ws');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
        this.isMonitoring = false;
        this.monitoringInterval = null;
        this.processedSignatures = new Set();
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0
        };
        this.websocket = null;
        this.websocketUrl = 'ws://45.134.108.167:5006/ws';
        this.apiUrl = 'http://45.134.108.167:5005';
        this.reconnectInterval = 5000; 
    }

    async startMonitoring() {
        if (this.isMonitoring) {
            console.log('⚠️ Monitoring is already running');
            return;
        }

        console.log('🚀 Starting wallet monitoring...');
        this.isMonitoring = true;

        this.startWebSocket();

        this.monitoringInterval = setInterval(async () => {
            await this.performMonitoringCycle();
        }, 30000);

        await this.performMonitoringCycle();
    }

    startWebSocket() {
        this.websocket = new WebSocket(this.websocketUrl);

        this.websocket.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to WebSocket: ${this.websocketUrl}`);
        });

        this.websocket.on('message', async (data) => {
            try {
                const webhookData = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] 📥 Received webhook:`, webhookData);
                await redis.lpush('webhook:log', JSON.stringify(webhookData)); 
                await this.processWebhook(webhookData);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error processing webhook:`, error.message);
                this.stats.errors++;
            }
        });

        this.websocket.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
            this.stats.errors++;
        });

        this.websocket.on('close', () => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket disconnected. Reconnecting in ${this.reconnectInterval}ms...`);
            setTimeout(() => this.startWebSocket(), this.reconnectInterval);
        });
    }

    async processWebhook(webhookData) {
        const { signature, walletAddress, blockTime } = webhookData;

        if (!signature || !walletAddress || !blockTime) {
            console.warn(`[${new Date().toISOString()}] Invalid webhook data:`, webhookData);
            return;
        }

        const wallet = await this.db.getWalletByAddress(walletAddress);
        if (!wallet) {
            console.log(`[${new Date().toISOString()}] Wallet ${walletAddress} not monitored, skipping`);
            return;
        }

        if (this.processedSignatures.has(signature)) {
            console.log(`[${new Date().toISOString()}] Transaction ${signature} already processed, skipping`);
            return;
        }

        const processedTx = await this.processTransaction(
            { signature, blockTime, transactionData: webhookData.transactionData },
            wallet
        );

        if (processedTx) {
            this.processedSignatures.add(signature);
            console.log(`[${new Date().toISOString()}] ✅ Processed webhook transaction ${signature} for wallet ${walletAddress}`);
            if (processedTx.type === 'buy') {
                this.stats.totalBuyTransactions++;
            } else if (processedTx.type === 'sell') {
                this.stats.totalSellTransactions++;
            }
            await this.db.updateWalletStats(wallet.id);
        }
    }

    async fetchTransactionFromHelius(signature) {
        try {
            const response = await axios.get(`${this.apiUrl}/transaction/${signature}`, {
                timeout: 10000
            });
            const tx = response.data;

            return {
                meta: {
                    preBalances: tx.preBalances || [],
                    postBalances: tx.postBalances || [],
                    preTokenBalances: tx.preTokenBalances || [],
                    postTokenBalances: tx.postTokenBalances || []
                },
                blockTime: tx.blockTime,
                transaction: tx.transaction || {}
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error fetching transaction ${signature} from Helius:`, error.message);
            return null;
        }
    }

    async performMonitoringCycle() {
        const scanStartTime = Date.now();
        let processedSignatures = 0;
        let errors = 0;

        try {
            const wallets = await this.db.getActiveWallets();
            console.log(`🔍 Scanning ${wallets.length} wallets...`);

            for (const wallet of wallets) {
                try {
                    const result = await this.checkWalletTransactions(wallet);
                    processedSignatures += result.newTransactions;
                } catch (error) {
                    console.error(`❌ Error checking wallet ${wallet.address}:`, error.message);
                    errors++;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            const scanDuration = Date.now() - scanStartTime;

            this.stats.totalScans++;
            this.stats.totalWallets = wallets.length;
            this.stats.errors += errors;
            this.stats.lastScanDuration = scanDuration;

            await this.db.addMonitoringStats(
                processedSignatures,
                wallets.length,
                scanDuration,
                errors
            );

            if (processedSignatures > 0) {
                console.log(`✅ Scan completed: ${processedSignatures} new transactions in ${scanDuration}ms`);
            }

        } catch (error) {
            console.error('❌ Error in monitoring cycle:', error.message);
            this.stats.errors++;
        }
    }

    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }
        this.isMonitoring = false;
        console.log('⏹️ Monitoring stopped');
    }

    async checkWalletTransactions(wallet) {
        try {
            const pubkey = new PublicKey(wallet.address);

            const signatures = await this.connection.getSignaturesForAddress(pubkey, {
                limit: 10
            });

            let newTransactionsCount = 0;

            for (const sig of signatures) {
                if (this.processedSignatures.has(sig.signature)) {
                    continue;
                }

                const txData = await this.processTransaction(sig, wallet);
                if (txData) {
                    newTransactionsCount++;
                    this.processedSignatures.add(sig.signature);
                    
                    if (txData.type === 'buy') {
                        this.stats.totalBuyTransactions++;
                    } else if (txData.type === 'sell') {
                        this.stats.totalSellTransactions++;
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 300));
            }

            if (newTransactionsCount > 0) {
                console.log(`✅ ${wallet.name || wallet.address.slice(0, 8)}...: ${newTransactionsCount} new transactions`);
                await this.db.updateWalletStats(wallet.id);
            }

            return { newTransactions: newTransactionsCount };

        } catch (error) {
            console.error(`❌ Error checking wallet ${wallet.address}:`, error.message);
            throw error;
        }
    }

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                return null;
            }

            let tx = sig.transactionData;
            if (!tx) {
                tx = await this.fetchTransactionFromHelius(sig.signature);
                if (!tx) {
                    tx = await this.connection.getParsedTransaction(sig.signature, {
                        maxSupportedTransactionVersion: 0
                    });
                }
            }

            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                return null;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            
            let transactionType, solAmount;
            if (solChange < 0) {
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

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    usdAmount,
                    tokensChanged: tokenChanges.length
                };
            });

        } catch (error) {
            console.error(`❌ Error processing transaction ${sig.signature}:`, error.message);
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

    async addWallet(address, name = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name);
            console.log(`✅ Added wallet for monitoring: ${name || address.slice(0, 8)}...`);
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (wallet) {
                const transactions = await this.db.getRecentTransactions(24 * 7);
                const walletSignatures = transactions
                    .filter(tx => tx.wallet_address === address)
                    .map(tx => tx.signature);
                walletSignatures.forEach(sig => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`🗑️ Removed wallet and associated data: ${address.slice(0, 8)}...`);
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            processedSignatures: this.processedSignatures.size,
            stats: {
                ...this.stats,
                uptime: this.isMonitoring ? Date.now() - (this.stats.startTime || Date.now()) : 0
            }
        };
    }

    async getDetailedStats() {
        try {
            const dbStats = await this.db.getMonitoringStats();
            const topTokens = await this.db.getTopTokens(5);
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async close() {
        this.stopMonitoring();
        await this.db.close();
        await redis.quit();
    }
}

module.exports = WalletMonitoringService;