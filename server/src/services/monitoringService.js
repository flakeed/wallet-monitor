const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.isMonitoring = false;
        this.processedSignatures = new Set();
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0,
            startTime: Date.now(),
        };
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.isProcessingQueue = false;
        this.queueKey = 'webhook:queue';
        this.batchSize = 400;
        console.log(`[${new Date().toISOString()}] 🔧 MonitoringService initialized`);
    }

    startMonitoring() {
        console.log('⚠️ Legacy monitoring is deprecated. Use WebSocket service instead.');
        this.isMonitoring = false;
    }

    stopMonitoring() {
        this.isMonitoring = false;
        console.log('⏹️ Legacy monitoring stopped');
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
    
        while (true) {
            const requestData = await this.redis.lpop(this.queueKey, this.batchSize);
            if (!requestData || requestData.length === 0) break;
    
            const requests = requestData.map((data) => {
                try {
                    return JSON.parse(data);
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, error.message);
                    return null;
                }
            }).filter((req) => req !== null);
    
            if (requests.length === 0) continue;
    
            console.log(`[${new Date().toISOString()}] 🔄 Processing batch of ${requests.length} signatures`);
    
            const batchResults = await Promise.all(
                requests.map(async (request) => {
                    const { signature, walletAddress, blockTime } = request;
                    try {
                        const wallet = await this.db.getWalletByAddress(walletAddress);
                        if (!wallet) {
                            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
                            return null;
                        }
    
                        const txData = await this.processTransaction({ signature, blockTime }, wallet);
                        if (txData) {
                            console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature}`);
                            return {
                                signature,
                                walletAddress,
                                walletName: wallet.name,
                                groupId: wallet.group_id,
                                groupName: wallet.group_name,
                                transactionType: txData.type,
                                solAmount: txData.solAmount,
                                tokens: txData.tokensChanged.map((tc) => ({
                                    mint: tc.mint,
                                    amount: tc.rawChange / Math.pow(10, tc.decimals),
                                    symbol: tc.symbol,
                                    name: tc.name,
                                })),
                                timestamp: new Date(blockTime * 1000).toISOString(),
                            };
                        }
                        return null;
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${signature}:`, error.message);
                        return null;
                    }
                })
            );
    
            const successfulTxs = batchResults.filter((tx) => tx !== null);
            if (successfulTxs.length > 0) {
                const pipeline = this.redis.pipeline();
                successfulTxs.forEach((tx) => {
                    pipeline.publish('transactions', JSON.stringify(tx));
                });
                await pipeline.exec();
            }
        }
    
        this.isProcessingQueue = false;
        const queueLength = await this.redis.llen(this.queueKey);
        if (queueLength > 0) {
            setImmediate(() => this.processQueue());
        }
    }

    async processWebhookMessage(message) {
        const { signature, walletAddress, blockTime } = message;
        const requestId = require('uuid').v4();
        await this.redis.lpush(this.queueKey, JSON.stringify({
            requestId,
            signature,
            walletAddress,
            blockTime,
            timestamp: Date.now(),
        }));
        console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature}`);

        if (!this.isProcessingQueue) {
            setImmediate(() => this.processQueue());
        }
    }

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }
    
            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1',
                [sig.signature]
            );
            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed`);
                return null;
            }
    
            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            });
    
            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature}`);
                return null;
            }
    
            // ✅ ИСПРАВЛЕНО: Сначала анализируем токены, потом определяем тип транзакции
            const tokenChanges = await this.analyzeTokenChanges(tx.meta);
            if (tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
                return null;
            }
    
            // ✅ ИСПРАВЛЕНО: Определяем тип на основе токенов, а не только SOL
            const { transactionType, solAmount } = this.determineTransactionType(tx.meta, tokenChanges);
            
            if (!transactionType) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - could not determine transaction type`);
                return null;
            }
    
            console.log(`[${new Date().toISOString()}] ✅ Detected ${transactionType} transaction ${sig.signature}: ${solAmount} SOL, ${tokenChanges.length} tokens`);
    
            return await this.db.withTransaction(async (client) => {
                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        sol_spent, sol_received
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;
                const result = await client.query(query, [
                    wallet.id,
                    sig.signature,
                    new Date(sig.blockTime * 1000).toISOString(),
                    transactionType,
                    transactionType === 'buy' ? solAmount : 0,
                    transactionType === 'sell' ? solAmount : 0,
                ]);
    
                const transaction = result.rows[0];
                const tokenSavePromises = tokenChanges.map((tokenChange) =>
                    this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
                );
                await Promise.all(tokenSavePromises);
    
                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    tokensChanged: tokenChanges,
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            return null;
        }
    }

    determineTransactionType(meta, tokenChanges) {
        const solChange = (meta.postBalances[0] - meta.preBalances[0]) / 1e9;
        
        // Анализируем направление токенов
        const tokensBought = tokenChanges.filter(tc => tc.change > 0).length;
        const tokensSold = tokenChanges.filter(tc => tc.change < 0).length;
        
        let transactionType = null;
        let solAmount = 0;
        
        // ✅ ИСПРАВЛЕНО: Определяем тип на основе токенов И SOL
        if (tokensBought > 0 && tokensSold === 0) {
            // Купили токены - это BUY
            transactionType = 'buy';
            solAmount = Math.abs(solChange);
        } else if (tokensSold > 0 && tokensBought === 0) {
            // Продали токены - это SELL  
            transactionType = 'sell';
            solAmount = Math.max(0, solChange);
        } else if (tokensBought > 0 && tokensSold > 0) {
            // Свап - определяем по SOL изменению
            if (solChange < 0) {
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
            } else {
                transactionType = 'sell';
                solAmount = solChange;
            }
        } else {
            // Не можем определить тип
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not determine transaction type: SOL change ${solChange}, tokens bought ${tokensBought}, sold ${tokensSold}`);
            return { transactionType: null, solAmount: 0 };
        }
        
        // ✅ ИСПРАВЛЕНО: Убираем строгий порог, но проверяем разумность
        if (solAmount < 0.000001) {
            solAmount = 0.000001; // Минимальная сумма для записи
        }
        
        return { transactionType, solAmount };
    }

    async analyzeTokenChanges(meta) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
        const mints = new Set();
    
        // Собираем все изменения токенов
        for (const post of meta.postTokenBalances || []) {
            const pre = meta.preTokenBalances?.find((p) => 
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );
            
            if (!pre || post.mint === WRAPPED_SOL_MINT) continue;
    
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            // ✅ ИСПРАВЛЕНО: Регистрируем ВСЕ изменения токенов, не фильтруем по типу
            if (rawChange !== 0) {
                mints.add(post.mint);
            }
        }
    
        if (mints.size === 0) {
            return [];
        }
    
        // Получаем метаданные токенов
        const tokenInfos = await this.batchFetchTokenMetadata([...mints]);
        
        for (const post of meta.postTokenBalances || []) {
            const pre = meta.preTokenBalances?.find((p) => 
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );
            
            if (!pre || post.mint === WRAPPED_SOL_MINT) continue;
    
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            if (rawChange !== 0) {
                const tokenInfo = tokenInfos.get(post.mint) || {
                    symbol: 'Unknown',
                    name: 'Unknown Token',
                    decimals: post.uiTokenAmount.decimals,
                };
    
                tokenChanges.push({
                    mint: post.mint,
                    rawChange: rawChange,  // Может быть отрицательным или положительным
                    change: rawChange / Math.pow(10, post.uiTokenAmount.decimals), // UI amount
                    decimals: post.uiTokenAmount.decimals,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                });
            }
        }
    
        return tokenChanges;
    }

    async batchFetchTokenMetadata(mints) {
        const tokenInfos = new Map();
        const uncachedMints = [];
        const pipeline = this.redis.pipeline();

        for (const mint of mints) {
            pipeline.get(`token:${mint}`);
        }
        const results = await pipeline.exec();

        results.forEach(([err, cachedToken], index) => {
            if (!err && cachedToken) {
                tokenInfos.set(mints[index], JSON.parse(cachedToken));
            } else {
                uncachedMints.push(mints[index]);
            }
        });

        if (uncachedMints.length > 0) {
            const batchSize = 10;
            for (let i = 0; i < uncachedMints.length; i += batchSize) {
                const batch = uncachedMints.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(async (mint) => {
                        const tokenInfo = await fetchTokenMetadata(mint, this.connection);
                        return { mint, tokenInfo };
                    })
                );
                const pipeline = this.redis.pipeline();
                batchResults.forEach(({ mint, tokenInfo }) => {
                    if (tokenInfo) {
                        tokenInfos.set(mint, tokenInfo);
                        pipeline.set(`token:${mint}`, JSON.stringify(tokenInfo), 'EX', 24 * 60 * 60);
                    }
                });
                await pipeline.exec();
            }
        }

        return tokenInfos;
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
            if (!tokenInfo) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No metadata for token ${tokenChange.mint}`);
                return;
            }

            const tokenUpsertQuery = `
                INSERT INTO tokens (mint, symbol, name, decimals) 
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;
            const tokenResult = await client.query(tokenUpsertQuery, [
                tokenChange.mint,
                tokenInfo.symbol,
                tokenInfo.name,
                tokenInfo.decimals,
            ]);

            const tokenId = tokenResult.rows[0].id;
            const amount = tokenChange.rawChange / Math.pow(10, tokenChange.decimals);

            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error saving token operation:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null, groupId = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name, groupId);
            console.log(`[${new Date().toISOString()}] ✅ Added wallet: ${name || address.slice(0, 8)}... to group ${groupId || 'none'}`);
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
                    .filter((tx) => tx.wallet_address === address)
                    .map((tx) => tx.signature);
                walletSignatures.forEach((sig) => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet: ${address.slice(0, 8)}...`);
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async removeAllWallets(groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🗑️ Removing all wallets from monitoring service${groupId ? ` for group ${groupId}` : ''}`);
            const transactions = await this.db.getRecentTransactions(24 * 7, 400, null, groupId);
            const allSignatures = transactions.map((tx) => tx.signature);
            allSignatures.forEach((sig) => this.processedSignatures.delete(sig));
            if (!groupId) {
                this.processedSignatures.clear();
            }
            await this.db.removeAllWallets(groupId);
            console.log(`[${new Date().toISOString()}] ✅ All wallets removed from monitoring service${groupId ? ` for group ${groupId}` : ''}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets from monitoring service:`, error.message);
            throw error;
        }
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            processedSignatures: this.processedSignatures.size,
            rpcEndpoint: this.connection.rpcEndpoint,
            stats: {
                ...this.stats,
                uptime: Date.now() - this.stats.startTime,
            },
        };
    }

    async getDetailedStats(groupId = null) {
        try {
            const dbStats = await this.db.getMonitoringStats(groupId);
            const topTokens = await this.db.getTopTokens(5, null, groupId);
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens,
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async close() {
        this.stopMonitoring();
        await this.redis.quit();
        await this.db.close();
        console.log(`[${new Date().toISOString()}] ✅ Monitoring service closed`);
    }
}

module.exports = WalletMonitoringService;