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
        const startTime = Date.now();
        
        try {
            console.log(`[${new Date().toISOString()}] 🔄 Starting to process transaction ${sig.signature} for wallet ${wallet.address.slice(0,8)}...`);
            
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }
    
            // Проверяем существование транзакции
            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1',
                [sig.signature]
            );
            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed`);
                return null;
            }
    
            console.log(`[${new Date().toISOString()}] 📡 Fetching transaction from blockchain: ${sig.signature}`);
            
            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            });
    
            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature}`);
                return null;
            }
    
            console.log(`[${new Date().toISOString()}] ⚖️ Analyzing balances for ${sig.signature}`);
            console.log(`Pre-balance: ${tx.meta.preBalances[0] / 1e9} SOL, Post-balance: ${tx.meta.postBalances[0] / 1e9} SOL`);
            
            // Анализируем токены СНАЧАЛА
            console.log(`[${new Date().toISOString()}] 🪙 Analyzing token changes for ${sig.signature}`);
            const tokenChanges = await this.analyzeTokenChanges(tx.meta);
            
            console.log(`[${new Date().toISOString()}] 📊 Found ${tokenChanges.length} token changes:`);
            tokenChanges.forEach((tc, i) => {
                console.log(`  ${i+1}. ${tc.symbol} (${tc.mint.slice(0,8)}...): ${tc.change > 0 ? '+' : ''}${tc.change}`);
            });
    
            if (tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
                return null;
            }
    
            // ИСПРАВЛЕННАЯ ЛОГИКА определения типа транзакции
            console.log(`[${new Date().toISOString()}] 🔍 Determining transaction type for ${sig.signature}`);
    
            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            console.log(`[${new Date().toISOString()}] 💰 SOL change: ${solChange} SOL`);
    
            let transactionType, solAmount;
    
            // ✅ ИСПРАВЛЕНО: Более точная логика определения типа
            if (solChange < -0.000001) {
                // SOL уменьшилось = потратили SOL = BUY
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
                console.log(`[${new Date().toISOString()}] ✅ BUY: Spent ${solAmount} SOL`);
                
            } else if (solChange > 0.000001) {
                // SOL увеличилось = получили SOL = SELL  
                transactionType = 'sell';
                solAmount = solChange;
                console.log(`[${new Date().toISOString()}] ✅ SELL: Received ${solAmount} SOL`);
                
            } else {
                // Минимальное изменение SOL - определяем по токенам
                const tokensBought = tokenChanges.filter(tc => tc.change > 0); // Получили токены
                const tokensSold = tokenChanges.filter(tc => tc.change < 0);   // Потеряли токены
                
                console.log(`[${new Date().toISOString()}] 🔍 Minimal SOL change (${solChange}). Tokens: +${tokensBought.length}, -${tokensSold.length}`);
                
                if (tokensBought.length > 0 && tokensSold.length === 0) {
                    // Только получили токены = BUY
                    transactionType = 'buy';
                    solAmount = 0.000001;
                    console.log(`[${new Date().toISOString()}] ✅ BUY: Got ${tokensBought.length} tokens (minimal SOL)`);
                    
                } else if (tokensSold.length > 0 && tokensBought.length === 0) {
                    // Только потеряли токены = SELL
                    transactionType = 'sell'; 
                    solAmount = 0.000001;
                    console.log(`[${new Date().toISOString()}] ✅ SELL: Lost ${tokensSold.length} tokens (minimal SOL)`);
                    
                } else if (tokensBought.length > 0 && tokensSold.length > 0) {
                    // Свап - берем тот тип, где больше токенов изменилось
                    const buyVolume = tokensBought.reduce((sum, t) => sum + Math.abs(t.change), 0);
                    const sellVolume = tokensSold.reduce((sum, t) => sum + Math.abs(t.change), 0);
                    
                    if (buyVolume >= sellVolume) {
                        transactionType = 'buy';
                        console.log(`[${new Date().toISOString()}] ✅ SWAP->BUY: Buy volume ${buyVolume} >= Sell volume ${sellVolume}`);
                    } else {
                        transactionType = 'sell';
                        console.log(`[${new Date().toISOString()}] ✅ SWAP->SELL: Sell volume ${sellVolume} > Buy volume ${buyVolume}`);
                    }
                    solAmount = Math.abs(solChange) || 0.000001;
                    
                } else {
                    console.log(`[${new Date().toISOString()}] ❓ Cannot determine transaction type for ${sig.signature}`);
                    return null;
                }
            }
    
            console.log(`[${new Date().toISOString()}] 💾 Starting database transaction for ${sig.signature}`);
    
            // Сохраняем в базу данных
            const result = await this.db.withTransaction(async (client) => {
                try {
                    console.log(`[${new Date().toISOString()}] 📝 Inserting transaction record for ${sig.signature}`);
                    
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
                    console.log(`[${new Date().toISOString()}] ✅ Transaction record created with ID: ${transaction.id}`);
    
                    console.log(`[${new Date().toISOString()}] 🪙 Saving ${tokenChanges.length} token operations`);
                    
                    // Сохраняем токены по одному с обработкой ошибок
                    for (let i = 0; i < tokenChanges.length; i++) {
                        const tokenChange = tokenChanges[i];
                        try {
                            console.log(`[${new Date().toISOString()}] 💾 Saving token ${i+1}/${tokenChanges.length}: ${tokenChange.symbol}`);
                            await this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType);
                            console.log(`[${new Date().toISOString()}] ✅ Token ${tokenChange.symbol} saved successfully`);
                        } catch (tokenError) {
                            console.error(`[${new Date().toISOString()}] ❌ Error saving token ${tokenChange.symbol}:`, tokenError.message);
                            throw tokenError; // Прерываем транзакцию
                        }
                    }
    
                    console.log(`[${new Date().toISOString()}] ✅ All token operations saved for ${sig.signature}`);
    
                    return {
                        signature: sig.signature,
                        type: transactionType,
                        solAmount,
                        tokensChanged: tokenChanges,
                    };
                } catch (dbError) {
                    console.error(`[${new Date().toISOString()}] ❌ Database transaction error for ${sig.signature}:`, dbError.message);
                    throw dbError;
                }
            });
    
            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] 🎉 Successfully processed transaction ${sig.signature} in ${duration}ms`);
            
            return result;
    
        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature} after ${duration}ms:`, error.message);
            console.error(`Full error:`, error);
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
        console.log(`[${new Date().toISOString()}] 🔍 Processing token: ${tokenChange.mint}, transaction type: ${transactionType}`);
        
        // ✅ ИСПРАВЛЕНО: operation_type должен соответствовать transaction_type!
        // Если транзакция buy - все токены в ней считаются купленными
        // Если транзакция sell - все токены в ней считаются проданными
        const operationType = transactionType; // Просто используем тип транзакции!
        
        // Для количества берем абсолютное значение
        const amount = Math.abs(tokenChange.change);
        
        console.log(`[${new Date().toISOString()}] 📊 Token: ${tokenChange.symbol}, operation: ${operationType}, amount: ${amount}`);

        // Получаем или создаем запись токена
        const tokenInfo = {
            symbol: tokenChange.symbol || 'Unknown',
            name: tokenChange.name || 'Unknown Token',
            decimals: tokenChange.decimals || 6
        };

        console.log(`[${new Date().toISOString()}] 💾 Upserting token metadata: ${tokenInfo.symbol}`);

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
        console.log(`[${new Date().toISOString()}] ✅ Token record created/updated with ID: ${tokenId}`);
        
        console.log(`[${new Date().toISOString()}] 💾 Creating token operation: ${operationType} ${amount} ${tokenInfo.symbol}`);
        
        const operationQuery = `
            INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        
        const operationResult = await client.query(operationQuery, [
            transactionId, 
            tokenId, 
            amount, 
            operationType  // ✅ Теперь правильно!
        ]);
        
        console.log(`[${new Date().toISOString()}] ✅ Token operation created with ID: ${operationResult.rows[0].id}`);
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error saving token operation for ${tokenChange.mint}:`, error.message);
        console.error(`Token data:`, {
            mint: tokenChange.mint,
            symbol: tokenChange.symbol,
            change: tokenChange.change,
            transactionId,
            transactionType,
            operationType: transactionType
        });
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