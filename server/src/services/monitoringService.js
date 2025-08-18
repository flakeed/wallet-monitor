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
        this.recentlyProcessed = new Set();
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
        this.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
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

    async getSolPrice() {
        const cacheKey = 'sol_price_usd';
        const cachedPrice = await redis.get(cacheKey);
        if (cachedPrice) {
            return parseFloat(cachedPrice);
        }

        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const solPrice = parseFloat(bestPair.priceUsd || 150);
                await redis.set(cacheKey, solPrice.toString(), 'EX', 300); // Кэш на 5 минут
                return solPrice;
            }
            return 150; // Fallback
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
            return 150; // Fallback
        }
    }

    async getUsdcToSolRate() {
        const cacheKey = 'usdc_to_sol_rate';
        const cachedRate = await redis.get(cacheKey);
        if (cachedRate) {
            return parseFloat(cachedRate);
        }

        try {
            const solPrice = await this.getSolPrice(); // Цена SOL в USD
            const usdcPrice = 1.0; // USDC всегда ~1 USD
            const rate = usdcPrice / solPrice; // Сколько SOL за 1 USDC
            await redis.set(cacheKey, rate.toString(), 'EX', 300); // Кэш на 5 минут
            console.log(`[${new Date().toISOString()}] 💱 USDC to SOL rate: ${rate.toFixed(6)} SOL per USDC (SOL price: $${solPrice})`);
            return rate;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating USDC/SOL rate:`, error.message);
            return 0.0067; // Fallback rate (~$150 SOL price)
        }
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
                
                const options = {
                    maxSupportedTransactionVersion: 0,
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
    
                if (tx.meta?.err) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Transaction ${signature} failed:`, tx.meta.err);
                    return null;
                }
    
                console.log(`[${new Date().toISOString()}] ✅ Successfully fetched transaction ${signature}`);
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

    async processTransaction(txInfo, wallet) {
        try {
            const { signature, blockTime } = txInfo;
            
            console.log(`[${new Date().toISOString()}] 🔄 Processing transaction ${signature} for wallet ${wallet.address.slice(0, 8)}...`);
            
            const transaction = await this.fetchTransactionWithRetry(signature);
            if (!transaction) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Could not fetch transaction ${signature}`);
                return null;
            }

            const { meta, transaction: tx } = transaction;
            if (!meta || !tx) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction structure for ${signature}`);
                return null;
            }

            // Анализируем изменения SOL и USDC балансов
            const solAndUsdcChanges = await this.analyzeSolAndUsdcChanges(meta, tx, wallet.address);
            if (!solAndUsdcChanges) {
                console.log(`[${new Date().toISOString()}] ⏭️ No significant SOL/USDC changes for transaction ${signature}`);
                return null;
            }

            const { transactionType, totalSolAmount } = solAndUsdcChanges;
            
            // Анализируем изменения токенов
            const tokensChanged = await this.analyzeTokenChanges(meta, transactionType, wallet.address);
            if (tokensChanged.length === 0) {
                console.log(`[${new Date().toISOString()}] ⏭️ No token changes for ${transactionType} transaction ${signature}`);
                return null;
            }

            console.log(`[${new Date().toISOString()}] 📊 Transaction ${signature} analysis:`);
            console.log(`  - Type: ${transactionType}`);
            console.log(`  - Total SOL amount: ${totalSolAmount.toFixed(6)} SOL`);
            console.log(`  - Tokens changed: ${tokensChanged.length}`);

            // Сохраняем в базу данных
            await this.db.withTransaction(async (client) => {
                const addTransactionQuery = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        sol_spent, sol_received
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (signature, wallet_id) DO NOTHING
                    RETURNING id
                `;
                
                const txResult = await client.query(addTransactionQuery, [
                    wallet.id,
                    signature,
                    new Date(blockTime * 1000),
                    transactionType,
                    transactionType === 'buy' ? totalSolAmount : 0,
                    transactionType === 'sell' ? totalSolAmount : 0,
                ]);

                if (txResult.rows.length === 0) {
                    console.log(`[${new Date().toISOString()}] ⏭️ Transaction ${signature} already exists, skipping`);
                    return null;
                }

                const transactionId = txResult.rows[0].id;

                // Сохраняем операции с токенами
                for (const tokenChange of tokensChanged) {
                    await this.saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType);
                }

                console.log(`[${new Date().toISOString()}] ✅ Saved transaction ${signature} with ${tokensChanged.length} token operations`);
            });

            return {
                type: transactionType,
                solAmount: totalSolAmount,
                tokensChanged,
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${txInfo.signature}:`, error.message);
            return null;
        }
    }

    async analyzeSolAndUsdcChanges(meta, tx, walletAddress) {
        try {
            const accountKeys = tx.message.accountKeys.map((key) => key.pubkey.toBase58());
            const walletIndex = accountKeys.findIndex((key) => key === walletAddress);
            
            if (walletIndex === -1) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found in transaction account keys`);
                return null;
            }

            // Изменение SOL баланса
            const solPreBalance = meta.preBalances[walletIndex] || 0;
            const solPostBalance = meta.postBalances[walletIndex] || 0;
            const solChangeRaw = solPostBalance - solPreBalance; // В lamports
            const solChange = solChangeRaw / 1e9; // В SOL

            console.log(`[${new Date().toISOString()}] 💰 SOL balance change: ${solChange.toFixed(9)} SOL (${solChangeRaw} lamports)`);

            // Изменение USDC баланса
            let usdcChange = 0;
            let usdcChangeInSol = 0;

            for (const tokenBalance of meta.preTokenBalances || []) {
                if (tokenBalance.mint === this.USDC_MINT && tokenBalance.owner === walletAddress) {
                    const preUsdcBalance = tokenBalance.uiTokenAmount.uiAmount || 0;
                    
                    const postTokenBalance = meta.postTokenBalances?.find(
                        (tb) => tb.mint === this.USDC_MINT && tb.owner === walletAddress && tb.accountIndex === tokenBalance.accountIndex
                    );
                    const postUsdcBalance = postTokenBalance?.uiTokenAmount.uiAmount || 0;
                    
                    usdcChange = postUsdcBalance - preUsdcBalance;
                    console.log(`[${new Date().toISOString()}] 💵 USDC balance change: ${usdcChange.toFixed(6)} USDC`);
                    
                    if (Math.abs(usdcChange) > 0.01) { // Игнорируем мелкие изменения
                        const usdcToSolRate = await this.getUsdcToSolRate();
                        usdcChangeInSol = Math.abs(usdcChange) * usdcToSolRate;
                        console.log(`[${new Date().toISOString()}] 🔄 USDC change converted to SOL: ${usdcChangeInSol.toFixed(6)} SOL (rate: ${usdcToSolRate.toFixed(6)})`);
                    }
                    break;
                }
            }

            // Определяем тип транзакции и общую сумму
            let transactionType = null;
            let totalSolAmount = 0;

            // Логика определения типа транзакции:
            // 1. Если потратили SOL (solChange < 0) - это покупка
            // 2. Если потратили USDC (usdcChange < 0) - это тоже покупка  
            // 3. Если получили SOL (solChange > 0) или USDC (usdcChange > 0) - это продажа

            if (solChange < -0.001) { // Потратили SOL (покупка)
                transactionType = 'buy';
                totalSolAmount = Math.abs(solChange);
                console.log(`[${new Date().toISOString()}] 🛒 BUY detected: spent ${totalSolAmount.toFixed(6)} SOL`);
            } else if (usdcChange < -0.01) { // Потратили USDC (покупка)
                transactionType = 'buy';
                totalSolAmount = usdcChangeInSol;
                console.log(`[${new Date().toISOString()}] 🛒 BUY detected: spent ${Math.abs(usdcChange).toFixed(6)} USDC (${totalSolAmount.toFixed(6)} SOL equivalent)`);
            } else if (solChange > 0.001) { // Получили SOL (продажа)
                transactionType = 'sell';
                totalSolAmount = solChange;
                console.log(`[${new Date().toISOString()}] 💰 SELL detected: received ${totalSolAmount.toFixed(6)} SOL`);
            } else if (usdcChange > 0.01) { // Получили USDC (продажа)
                transactionType = 'sell';
                totalSolAmount = usdcChangeInSol;
                console.log(`[${new Date().toISOString()}] 💰 SELL detected: received ${usdcChange.toFixed(6)} USDC (${totalSolAmount.toFixed(6)} SOL equivalent)`);
            }

            if (!transactionType || totalSolAmount < 0.001) {
                console.log(`[${new Date().toISOString()}] ⏭️ No significant SOL/USDC activity detected`);
                return null;
            }

            return {
                transactionType,
                totalSolAmount,
                solChange,
                usdcChange,
                usdcChangeInSol
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error analyzing SOL/USDC changes:`, error.message);
            return null;
        }
    }

    async analyzeTokenChanges(meta, transactionType, walletAddress) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing token changes for ${transactionType} transaction`);
        console.log(`Pre-token balances: ${meta.preTokenBalances?.length || 0}, Post-token balances: ${meta.postTokenBalances?.length || 0}`);
    
        const allBalanceChanges = new Map();
    
        for (const pre of meta.preTokenBalances || []) {
            const key = `${pre.mint}-${pre.accountIndex}`;
            allBalanceChanges.set(key, {
                mint: pre.mint,
                accountIndex: pre.accountIndex,
                owner: pre.owner,
                preAmount: pre.uiTokenAmount.amount,
                preUiAmount: pre.uiTokenAmount.uiAmount,
                postAmount: '0',
                postUiAmount: 0,
                decimals: pre.uiTokenAmount.decimals
            });
        }
    
        for (const post of meta.postTokenBalances || []) {
            const key = `${post.mint}-${post.accountIndex}`;
            if (allBalanceChanges.has(key)) {
                const existing = allBalanceChanges.get(key);
                existing.postAmount = post.uiTokenAmount.amount;
                existing.postUiAmount = post.uiTokenAmount.uiAmount;
            } else {
                allBalanceChanges.set(key, {
                    mint: post.mint,
                    accountIndex: post.accountIndex,
                    owner: post.owner,
                    preAmount: '0',
                    preUiAmount: 0,
                    postAmount: post.uiTokenAmount.amount,
                    postUiAmount: post.uiTokenAmount.uiAmount,
                    decimals: post.uiTokenAmount.decimals
                });
            }
        }
    
        console.log(`[${new Date().toISOString()}] 📊 Found ${allBalanceChanges.size} balance changes to analyze`);
    
        const mintChanges = new Map();
    
        for (const [key, change] of allBalanceChanges) {
            // Пропускаем WSOL и USDC - они учтены в analyzeSolAndUsdcChanges
            if (change.mint === WRAPPED_SOL_MINT || change.mint === this.USDC_MINT) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping ${change.mint === WRAPPED_SOL_MINT ? 'WSOL' : 'USDC'}`);
                continue;
            }
    
            // Проверяем что изменение относится к нашему кошельку
            if (change.owner !== walletAddress) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping token ${change.mint} - not owned by wallet ${walletAddress}`);
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
    
            let isValidChange = false;
            
            if (transactionType === 'buy') {
                if (rawChange > 0) {
                    isValidChange = true;
                    console.log(`[${new Date().toISOString()}] ✅ Valid BUY: token balance increased by ${rawChange} raw units`);
                } else {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping buy token ${change.mint} - balance decreased or unchanged (${rawChange})`);
                }
            } else if (transactionType === 'sell') {
                if (rawChange < 0) {
                    isValidChange = true;
                    console.log(`[${new Date().toISOString()}] ✅ Valid SELL: token balance decreased by ${Math.abs(rawChange)} raw units`);
                } else {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping sell token ${change.mint} - balance increased or unchanged (${rawChange})`);
                }
            }
    
            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += Math.abs(rawChange);
                    console.log(`[${new Date().toISOString()}] 📈 Aggregating change for ${change.mint}: ${existing.totalRawChange} total`);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: Math.abs(rawChange)
                    });
                    console.log(`[${new Date().toISOString()}] 🆕 New mint change: ${change.mint} = ${Math.abs(rawChange)}`);
                }
            }
        }
    
        if (mintChanges.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found for ${transactionType} transaction`);
            return [];
        }
    
        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mintChanges.size} unique tokens`);
    
        const mints = Array.from(mintChanges.keys());
        const tokenInfos = await this.batchFetchTokenMetadata(mints);
    
        for (const [mint, aggregatedChange] of mintChanges) {
            const tokenInfo = tokenInfos.get(mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: aggregatedChange.decimals,
            };
    
            tokenChanges.push({
                mint: mint,
                rawChange: aggregatedChange.totalRawChange,
                decimals: aggregatedChange.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} total raw units)`);
        }
    
        console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} unique token changes`);
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
                this.recentlyProcessed.clear();
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