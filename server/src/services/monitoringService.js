const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=758fd668-8d79-4538-9ae4-3741a4c877e8', 'confirmed');
        this.ws = null;
        this.isMonitoring = false;
        this.subscriptions = new Map(); // Map<subscriptionId, address>
        this.processedSignatures = new Set();
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0
        };
    }

    async startMonitoring() {
        if (this.isMonitoring) {
            console.log(`[${new Date().toISOString()}] ⚠️ Monitoring is already running`);
            return;
        }

        console.log(`[${new Date().toISOString()}] 🚀 Starting wallet monitoring...`);
        this.isMonitoring = true;

        await this.initializeWebSocket();
        await this.subscribeToWallets();
    }

    async initializeWebSocket() {
        const WEBHOOK_URL = process.env.WEBHOOK_URL || 'ws://45.134.108.167:5006/ws';

        this.ws = new WebSocket(WEBHOOK_URL);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Solana WebSocket at ${WEBHOOK_URL}`);
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] 📥 WebSocket message received:`, JSON.stringify(message, null, 2));

                if (message.method === 'accountNotification' && message.params) {
                    const { subscription, result } = message.params;
                    const address = this.subscriptions.get(subscription);
                    if (!address) {
                        console.warn(`[${new Date().toISOString()}] No address found for subscription ${subscription}`);
                        return;
                    }
                    const wallet = await this.db.getWalletByAddress(address);
                    if (!wallet) {
                        console.warn(`[${new Date().toISOString()}] Wallet ${address} not found in database`);
                        return;
                    }
                    await this.processAccountUpdate(wallet);
                } else if (message.result && message.id && this.subscriptions.has(message.id)) {
                    // Store the subscription ID returned by the server
                    const address = this.subscriptions.get(message.id);
                    this.subscriptions.set(message.result, address);
                    this.subscriptions.delete(message.id);
                    console.log(`[${new Date().toISOString()}] ✅ Subscription confirmed for wallet ${address.slice(0, 8)}... with ID ${message.result}`);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket message:`, error.message);
                this.stats.errors++;
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
            this.stats.errors++;
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}] WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isMonitoring = false;
            setTimeout(() => {
                console.log(`[${new Date().toISOString()}] Attempting to reconnect to WebSocket...`);
                this.initializeWebSocket().then(() => this.subscribeToWallets());
            }, 5000);
        });
    }

    async subscribeToWallets() {
        try {
            const wallets = await this.db.getActiveWallets();
            console.log(`[${new Date().toISOString()}] 🔍 Subscribing to ${wallets.length} wallets...`);
            this.stats.totalWallets = wallets.length;

            for (const wallet of wallets) {
                await this.subscribeToWallet(wallet.address);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallets:`, error.message);
            this.stats.errors++;
        }
    }

    async subscribeToWallet(address) {
        if ([...this.subscriptions.values()].includes(address)) {
            console.log(`[${new Date().toISOString()}] Wallet ${address.slice(0, 8)}... already subscribed`);
            return;
        }

        try {
            new PublicKey(address); // Validate address
            const subscriptionId = Date.now();
            const subscriptionMessage = {
                jsonrpc: '2.0',
                id: subscriptionId,
                method: 'accountSubscribe',
                params: [address, { commitment: 'confirmed', encoding: 'jsonParsed' }]
            };

            this.ws.send(JSON.stringify(subscriptionMessage));
            console.log(`[${new Date().toISOString()}] 📡 Sent subscription request for wallet: ${address.slice(0, 8)}... with ID ${subscriptionId}`);
            this.subscriptions.set(subscriptionId, address);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${address}:`, error.message);
            this.stats.errors++;
        }
    }

    async unsubscribeFromWallet(address) {
        const subscriptionId = [...this.subscriptions.entries()].find(([id, addr]) => addr === address)?.[0];
        if (!subscriptionId) {
            console.log(`[${new Date().toISOString()}] Wallet ${address.slice(0, 8)}... not subscribed`);
            return;
        }

        try {
            const unsubscribeMessage = {
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'accountUnsubscribe',
                params: [subscriptionId]
            };
            this.ws.send(JSON.stringify(unsubscribeMessage));
            console.log(`[${new Date().toISOString()}] 📴 Unsubscribed from wallet: ${address.slice(0, 8)}...`);
            this.subscriptions.delete(subscriptionId);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from wallet ${address}:`, error.message);
            this.stats.errors++;
        }
    }

    async processAccountUpdate(wallet) {
        try {
            const pubkey = new PublicKey(wallet.address);
            const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 1 });
            if (signatures.length === 0) {
                console.log(`[${new Date().toISOString()}] No new transactions for wallet ${wallet.address.slice(0, 8)}...`);
                return;
            }

            const sig = signatures[0];
            if (this.processedSignatures.has(sig.signature)) {
                return;
            }

            const txData = await this.processTransaction(sig, wallet);
            if (txData) {
                this.processedSignatures.add(sig.signature);
                if (txData.type === 'buy') {
                    this.stats.totalBuyTransactions++;
                } else if (txData.type === 'sell') {
                    this.stats.totalSellTransactions++;
                }
                await this.db.updateWalletStats(wallet.id);
                console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${sig.signature} for wallet ${wallet.address.slice(0, 8)}...`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing account update for wallet ${wallet.address}:`, error.message);
            this.stats.errors++;
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
                    tokensChanged: tokenChanges.length
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
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
            console.error(`[${new Date().toISOString()}] ❌ Error saving token operation for ${tokenChange.mint}:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name);
            console.log(`[${new Date().toISOString()}] ✅ Added wallet for monitoring: ${name || address.slice(0, 8)}...`);
            if (this.isMonitoring) {
                await this.subscribeToWallet(address);
            }
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (wallet) {
                await this.unsubscribeFromWallet(address);
                const transactions = await this.db.getRecentTransactions(24 * 7);
                const walletSignatures = transactions
                    .filter(tx => tx.wallet_address === address)
                    .map(tx => tx.signature);
                walletSignatures.forEach(sig => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet and associated data: ${address.slice(0, 8)}...`);
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
            subscribedWallets: this.subscriptions.size,
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
            console.error(`[${new Date().toISOString()}] ❌ Error getting detailed stats:`, error.message);
            return this.getStatus();
        }
    }

    async close() {
        this.stopMonitoring();
        await this.db.close();
        await redis.quit();
    }

    stopMonitoring() {
        if (this.ws) {
            for (const address of this.subscriptions.values()) {
                this.unsubscribeFromWallet(address);
            }
            this.ws.close();
            this.ws = null;
        }
        this.isMonitoring = false;
        console.log(`[${new Date().toISOString()}] ⏹️ Monitoring stopped`);
    }
}

module.exports = WalletMonitoringService;