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

    async fetchTransactionWithRetry(signature, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[${new Date().toISOString()}] 🔄 Fetching transaction ${signature} (attempt ${attempt}/${maxRetries})`);
                
                // Пробуем разные уровни commitment и версии
                const options = {
                    maxSupportedTransactionVersion: 0, // Поддержка versioned transactions
                    commitment: 'confirmed',
                };
    
                const tx = await this.connection.getParsedTransaction(signature, options);
                
                if (!tx) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Transaction ${signature} not found (attempt ${attempt})`);
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    return null;
                }
    
                // Проверяем успешность транзакции
                if (tx.meta?.err) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Transaction ${signature} failed:`, tx.meta.err);
                    return null;
                }
    
                console.log(`[${new Date().toISOString()}] ✅ Successfully fetched transaction ${signature}`);
                console.log(`[${new Date().toISOString()}] 📊 Transaction info:`);
                console.log(`  - Version: ${tx.version || 'legacy'}`);
                console.log(`  - Status: ${tx.meta?.err ? 'Failed' : 'Success'}`);
                console.log(`  - Fee: ${(tx.meta?.fee || 0) / 1e9} SOL`);
                console.log(`  - Account keys: ${tx.transaction?.message?.accountKeys?.length || 0}`);
                console.log(`  - Instructions: ${tx.transaction?.message?.instructions?.length || 0}`);
                console.log(`  - Pre-token balances: ${tx.meta?.preTokenBalances?.length || 0}`);
                console.log(`  - Post-token balances: ${tx.meta?.postTokenBalances?.length || 0}`);
    
                return tx;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error fetching transaction ${signature} (attempt ${attempt}):`, error.message);
                
                if (attempt < maxRetries) {
                    console.log(`[${new Date().toISOString()}] ⏳ Waiting before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }
        
        console.error(`[${new Date().toISOString()}] ❌ Failed to fetch transaction ${signature} after ${maxRetries} attempts`);
        return null;
    }
    
    // Улучшенная функция для анализа изменений токенов в versioned transactions
    async analyzeTokenChangesVersioned(meta, transactionType, accountKeys) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
        const mints = new Set();
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing versioned transaction token changes`);
        
        if (!meta.preTokenBalances || !meta.postTokenBalances) {
            console.log(`[${new Date().toISOString()}] ⚠️ No token balance data in transaction`);
            return [];
        }
    
        // Создаем карту изменений токенов по аккаунтам
        const tokenBalanceChanges = new Map();
    
        // Обрабатываем pre-balances
        for (const preBalance of meta.preTokenBalances) {
            const key = `${preBalance.mint}-${preBalance.accountIndex}`;
            if (!tokenBalanceChanges.has(key)) {
                tokenBalanceChanges.set(key, {
                    mint: preBalance.mint,
                    accountIndex: preBalance.accountIndex,
                    owner: preBalance.owner,
                    preAmount: preBalance.uiTokenAmount.amount,
                    preUiAmount: preBalance.uiTokenAmount.uiAmount,
                    decimals: preBalance.uiTokenAmount.decimals,
                    postAmount: '0',
                    postUiAmount: 0
                });
            } else {
                const existing = tokenBalanceChanges.get(key);
                existing.preAmount = preBalance.uiTokenAmount.amount;
                existing.preUiAmount = preBalance.uiTokenAmount.uiAmount;
            }
        }
    
        // Обрабатываем post-balances
        for (const postBalance of meta.postTokenBalances) {
            const key = `${postBalance.mint}-${postBalance.accountIndex}`;
            if (!tokenBalanceChanges.has(key)) {
                tokenBalanceChanges.set(key, {
                    mint: postBalance.mint,
                    accountIndex: postBalance.accountIndex,
                    owner: postBalance.owner,
                    preAmount: '0',
                    preUiAmount: 0,
                    decimals: postBalance.uiTokenAmount.decimals,
                    postAmount: postBalance.uiTokenAmount.amount,
                    postUiAmount: postBalance.uiTokenAmount.uiAmount
                });
            } else {
                const existing = tokenBalanceChanges.get(key);
                existing.postAmount = postBalance.uiTokenAmount.amount;
                existing.postUiAmount = postBalance.uiTokenAmount.uiAmount;
            }
        }
    
        console.log(`[${new Date().toISOString()}] 📊 Found ${tokenBalanceChanges.size} token balance changes`);
    
        // Анализируем каждое изменение
        for (const [key, change] of tokenBalanceChanges) {
            if (change.mint === WRAPPED_SOL_MINT) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping WSOL`);
                continue;
            }
    
            const rawChange = Number(change.postAmount) - Number(change.preAmount);
            const uiChange = Number(change.postUiAmount) - Number(change.preUiAmount);
    
            console.log(`[${new Date().toISOString()}] 🪙 Token ${change.mint}:`);
            console.log(`  - Account Index: ${change.accountIndex}`);
            console.log(`  - Owner: ${change.owner}`);
            console.log(`  - Raw change: ${rawChange}`);
            console.log(`  - UI change: ${uiChange}`);
            console.log(`  - Decimals: ${change.decimals}`);
    
            // Проверяем правильность изменения для типа транзакции
            if (transactionType === 'buy' && rawChange > 0) {
                mints.add(change.mint);
                console.log(`[${new Date().toISOString()}] ✅ Valid BUY: token balance increased`);
            } else if (transactionType === 'sell' && rawChange < 0) {
                mints.add(change.mint);
                console.log(`[${new Date().toISOString()}] ✅ Valid SELL: token balance decreased`);
            } else {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping: change direction doesn't match transaction type`);
            }
        }
    
        if (mints.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found`);
            return [];
        }
    
        // Получаем метаданные токенов
        const tokenInfos = await this.batchFetchTokenMetadata([...mints]);
    
        // Создаем финальный список изменений
        for (const [key, change] of tokenBalanceChanges) {
            if (!mints.has(change.mint)) continue;
    
            const rawChange = Number(change.postAmount) - Number(change.preAmount);
            const tokenInfo = tokenInfos.get(change.mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: change.decimals,
            };
    
            tokenChanges.push({
                mint: change.mint,
                rawChange: Math.abs(rawChange),
                decimals: change.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol}`);
        }
    
        return tokenChanges;
    }

    async processTransaction(sig, wallet) {
    try {
        if (!sig.signature || !sig.blockTime) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
            return null;
        }

        // Проверяем, не обработана ли уже эта транзакция
        const existingTx = await this.db.pool.query(
            'SELECT id FROM transactions WHERE signature = $1',
            [sig.signature]
        );
        if (existingTx.rows.length > 0) {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed`);
            return null;
        }

        console.log(`[${new Date().toISOString()}] 🔍 Processing transaction ${sig.signature} for wallet ${wallet.address}`);

        const tx = await this.fetchTransactionWithRetry(sig.signature);

        if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature} - missing metadata`);
            return null;
        }

        // Находим индекс кошелька в accountKeys
        const walletPubkey = wallet.address;
        let walletIndex = -1;
        
        if (tx.transaction.message.accountKeys) {
            walletIndex = tx.transaction.message.accountKeys.findIndex(
                (key) => key.pubkey.toString() === walletPubkey
            );
        }

        if (walletIndex === -1) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
            return null;
        }

        // Анализируем изменение SOL баланса для конкретного кошелька
        const preBalance = tx.meta.preBalances[walletIndex] || 0;
        const postBalance = tx.meta.postBalances[walletIndex] || 0;
        const solChange = (postBalance - preBalance) / 1e9;

        console.log(`[${new Date().toISOString()}] 💰 SOL balance change for ${walletPubkey}:`);
        console.log(`  - Pre: ${(preBalance / 1e9).toFixed(6)} SOL`);
        console.log(`  - Post: ${(postBalance / 1e9).toFixed(6)} SOL`);
        console.log(`  - Change: ${solChange.toFixed(6)} SOL`);

        let transactionType, solAmount;
        
        if (solChange < -0.001) {
            // SOL уменьшился - это покупка токенов
            transactionType = 'buy';
            solAmount = Math.abs(solChange);
            console.log(`[${new Date().toISOString()}] 🛒 Detected BUY transaction: spent ${solAmount.toFixed(6)} SOL`);
        } else if (solChange > 0.001) {
            // SOL увеличился - это продажа токенов
            transactionType = 'sell';
            solAmount = solChange;
            console.log(`[${new Date().toISOString()}] 💸 Detected SELL transaction: received ${solAmount.toFixed(6)} SOL`);
        } else {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange.toFixed(6)}`);
            return null;
        }

        // Анализируем изменения токенов (с поддержкой versioned transactions)
        let tokenChanges;
        if (tx.version === 0 || tx.version === 'legacy') {
            tokenChanges = await this.analyzeTokenChangesVersioned(tx.meta, transactionType, tx.transaction.message.accountKeys);
        } else {
            tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType);
        }
        
        if (tokenChanges.length === 0) {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
            
            // ДОПОЛНИТЕЛЬНАЯ ДИАГНОСТИКА
            console.log(`[${new Date().toISOString()}] 🔍 Debug info for ${sig.signature}:`);
            console.log(`  - Pre-token balances: ${JSON.stringify(tx.meta.preTokenBalances?.slice(0, 3) || [])}`);
            console.log(`  - Post-token balances: ${JSON.stringify(tx.meta.postTokenBalances?.slice(0, 3) || [])}`);
            console.log(`  - Instructions: ${tx.transaction.message.instructions?.length || 0}`);
            
            // Показываем программы, которые были вызваны
            if (tx.transaction.message.instructions) {
                tx.transaction.message.instructions.forEach((instruction, index) => {
                    const programId = tx.transaction.message.accountKeys[instruction.programIdIndex]?.pubkey?.toString();
                    console.log(`  - Instruction ${index}: Program ${programId}`);
                });
            }
            
            return null;
        }

        console.log(`[${new Date().toISOString()}] ✅ Found ${tokenChanges.length} token changes, saving transaction`);

        // Сохраняем транзакцию в базе данных
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
            
            // Сохраняем операции с токенами
            const tokenSavePromises = tokenChanges.map((tokenChange) =>
                this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
            );
            await Promise.all(tokenSavePromises);

            console.log(`[${new Date().toISOString()}] ✅ Successfully saved transaction ${sig.signature} with ${tokenChanges.length} token operations`);

            return {
                signature: sig.signature,
                type: transactionType,
                solAmount,
                tokensChanged: tokenChanges,
            };
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
        console.error(`[${new Date().toISOString()}] ❌ Stack trace:`, error.stack);
        return null;
    }
}

    async analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
        const mints = new Set();
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing token changes for ${transactionType} transaction`);
        console.log(`Pre-token balances: ${meta.preTokenBalances?.length || 0}, Post-token balances: ${meta.postTokenBalances?.length || 0}`);
    
        // Собираем все изменения токенов
        for (const post of meta.postTokenBalances || []) {
            const pre = meta.preTokenBalances?.find((p) => 
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );
            
            // Пропускаем если нет начального баланса или это WSOL
            if (!pre || post.mint === WRAPPED_SOL_MINT) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping token ${post.mint} (${!pre ? 'no pre-balance' : 'WSOL'})`);
                continue;
            }
    
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            const uiChange = Number(post.uiTokenAmount.uiAmount) - Number(pre.uiTokenAmount.uiAmount);
            
            console.log(`[${new Date().toISOString()}] 🪙 Token ${post.mint}:`);
            console.log(`  - Raw change: ${rawChange}`);
            console.log(`  - UI change: ${uiChange}`);
            console.log(`  - Decimals: ${post.uiTokenAmount.decimals}`);
    
            // ИСПРАВЛЕННАЯ ЛОГИКА: проверяем правильное направление изменений
            if (transactionType === 'buy') {
                // При покупке баланс токенов должен УВЕЛИЧИТЬСЯ (rawChange > 0)
                if (rawChange <= 0) {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping buy token ${post.mint} - balance decreased or unchanged`);
                    continue;
                }
            } else if (transactionType === 'sell') {
                // При продаже баланс токенов должен УМЕНЬШИТЬСЯ (rawChange < 0)
                if (rawChange >= 0) {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping sell token ${post.mint} - balance increased or unchanged`);
                    continue;
                }
            }
    
            // Добавляем mint для получения метаданных
            mints.add(post.mint);
            
            console.log(`[${new Date().toISOString()}] ✅ Valid ${transactionType} token change detected for ${post.mint}`);
        }
    
        if (mints.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found for ${transactionType} transaction`);
            return [];
        }
    
        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mints.size} tokens`);
        const tokenInfos = await this.batchFetchTokenMetadata([...mints]);
    
        // Создаем финальный список изменений токенов
        for (const post of meta.postTokenBalances || []) {
            const pre = meta.preTokenBalances?.find((p) => 
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );
            
            if (!pre || post.mint === WRAPPED_SOL_MINT || !mints.has(post.mint)) {
                continue;
            }
    
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            const tokenInfo = tokenInfos.get(post.mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: post.uiTokenAmount.decimals,
            };
    
            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange), // Всегда положительное значение
                decimals: post.uiTokenAmount.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${Math.abs(rawChange)} raw units)`);
        }
    
        console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} token changes`);
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