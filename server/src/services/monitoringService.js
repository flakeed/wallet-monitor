const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const Database = require('../database/connection');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');

class WalletMonitoringService {
constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        this.isMonitoring = false;
        this.processedSignatures = new Set();
        this.webhookUrl = process.env.WEBHOOK_URL;
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0
        };
        this.ws = null; 
        this.connectWebSocket(); 
    }

connectWebSocket() {
        if (!this.webhookUrl || !this.webhookUrl.startsWith('ws://') && !this.webhookUrl.startsWith('wss://')) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid WebSocket URL: ${this.webhookUrl}`);
            return;
        }

        this.ws = new WebSocket(this.webhookUrl);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to WebSocket: ${this.webhookUrl}`);
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
            this.stats.errors++;
        });

        this.ws.on('close', () => {
            console.warn(`[${new Date().toISOString()}] WebSocket closed, attempting to reconnect in 5 seconds...`);
            setTimeout(() => this.connectWebSocket(), 5000);
        });
    }

    async sendWebhookNotification(wallet, txData) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket not connected, cannot send notification for ${txData.signature}`);
            this.stats.errors++;
            return;
        }

        const payload = {
            walletAddress: wallet.address,
            walletName: wallet.name || null,
            signature: txData.signature,
            transactionType: txData.type,
            solAmount: txData.solAmount,
            usdAmount: txData.usdAmount,
            tokensChanged: txData.tokensChanged,
            timestamp: new Date(txData.blockTime * 1000).toISOString(),
            tokens: txData.tokenChanges || []
        };

        try {
            console.log(`[${new Date().toISOString()}] Sending WebSocket notification for ${txData.signature}`);
            this.ws.send(JSON.stringify(payload));
            console.log(`[${new Date().toISOString()}] ✅ WebSocket notification sent for transaction ${txData.signature}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error sending WebSocket notification for ${txData.signature}:`, error.message);
            this.stats.errors++;
        }
    }

    async close() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.isMonitoring = false;
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
            console.log(`[${new Date().toISOString()}] ✅ WebSocket connection closed`);
        }
        await this.db.close();
        await redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Monitoring service and Redis connection closed`);
    }

    async startMonitoring() {
        if (this.isMonitoring) {
            console.log('⚠️ Monitoring is already running');
            return;
        }

        console.log('🚀 Starting wallet monitoring via Solana node webhooks...');
        this.isMonitoring = true;

        this.monitoringInterval = setInterval(async () => {
            await this.performMonitoringCycle();
        }, 60000);
    }

    async performMonitoringCycle() {
        const scanStartTime = Date.now();
        let processedSignatures = 0;
        let errors = 0;

        try {
            const wallets = await this.db.getActiveWallets();
            console.log(`🔍 Backup scanning ${wallets.length} wallets...`);

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
                console.log(`✅ Backup scan completed: ${processedSignatures} new transactions in ${scanDuration}ms`);
            }
        } catch (error) {
            console.error('❌ Error in backup monitoring cycle:', error.message);
            this.stats.errors++;
        }
    }

    async processWebhook(data) {
        try {
            if (!data || !data.signature || !data.accountKeys) {
                console.warn('⚠️ Invalid webhook data received:', data);
                return;
            }

            const signature = data.signature;
            const accountAddresses = data.accountKeys;
            const blockTime = data.blockTime || Math.floor(Date.now() / 1000);

            const wallet = await this.findWalletInEvent(accountAddresses);
            if (!wallet) {
                console.warn(`⚠️ No monitored wallet found in webhook: ${signature}`);
                return;
            }

            if (this.processedSignatures.has(signature)) {
                console.log(`⚠️ Transaction ${signature} already processed`);
                return;
            }

            const txData = await this.processTransaction({ signature, blockTime }, wallet);
            if (txData) {
                this.processedSignatures.add(signature);
                if (txData.type === 'buy') {
                    this.stats.totalBuyTransactions++;
                } else if (txData.type === 'sell') {
                    this.stats.totalSellTransactions++;
                }

                await this.sendWebhookNotification(wallet, txData);
            }
        } catch (error) {
            console.error('❌ Error processing webhook:', error.message);
            this.stats.errors++;
        }
    }

    async findWalletInEvent(accountAddresses) {
        const wallets = await this.db.getActiveWallets();
        return wallets.find(wallet => accountAddresses.includes(wallet.address));
    }

    async sendWebhookNotification(wallet, txData) {
        if (!this.webhookUrl) {
            console.warn('⚠️ Webhook URL not set, skipping notification');
            return;
        }

        const payload = {
            walletAddress: wallet.address,
            walletName: wallet.name || null,
            signature: txData.signature,
            transactionType: txData.type,
            solAmount: txData.solAmount,
            usdAmount: txData.usdAmount,
            tokensChanged: txData.tokensChanged,
            timestamp: new Date(txData.blockTime * 1000).toISOString(),
            tokens: txData.tokenChanges || []
        };

        const maxRetries = 3;
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                console.log(`[${new Date().toISOString()}] Sending webhook for ${txData.signature} (attempt ${attempt + 1})`);
                await axios.post(this.webhookUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...(process.env.WEBHOOK_AUTH_HEADER && {
                            'Authorization': process.env.WEBHOOK_AUTH_HEADER
                        })
                    },
                    timeout: 5000
                });
                console.log(`✅ Webhook sent for transaction ${txData.signature}`);
                return;
            } catch (error) {
                attempt++;
                if (error.response?.status === 429) {
                    const delay = Math.pow(2, attempt) * 1000; 
                    console.warn(`[${new Date().toISOString()}] Webhook rate limit (429) for ${txData.signature}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`❌ Error sending webhook for ${txData.signature}:`, error.message);
                    this.stats.errors++;
                    return;
                }
            }
        }

        console.error(`❌ Failed to send webhook for ${txData.signature} after ${maxRetries} attempts`);
        this.stats.errors++;
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

                    await this.sendWebhookNotification(wallet, txData);
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

            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0
            });

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
                    ON CONFLICT (signature) DO NOTHING
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

                if (!result.rows[0]) {
                    return null;
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
                    tokensChanged: tokenChanges.length,
                    blockTime: sig.blockTime,
                    tokenChanges
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
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.isMonitoring = false;
        }
        await this.db.close();
        await redis.quit();
        console.log('✅ Monitoring service and Redis connection closed');
    }
}

module.exports = WalletMonitoringService;