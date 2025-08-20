const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata } = require('./tokenService');
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
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0,
            cacheTimeout: 60000 
        };
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
                    const { signature, walletAddress, blockTime, userId, groupId } = request;
                    try {
                        // Получаем кошелек с проверкой пользователя
                        const wallet = await this.db.getWalletByAddressAndUser(walletAddress, userId);
                        if (!wallet) {
                            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found for user ${userId}`);
                            return null;
                        }
    
                        const txData = await this.processTransaction({ signature, blockTime }, wallet);
                        if (txData) {
                            console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature} for user ${userId}`);
                            return {
                                signature,
                                walletAddress,
                                walletName: wallet.name,
                                groupId: wallet.group_id,
                                groupName: wallet.group_name,
                                userId: wallet.user_id, // ВАЖНО: добавляем userId в результат
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
                console.log(`[${new Date().toISOString()}] 📡 Publishing ${successfulTxs.length} transactions to Redis`);
                const pipeline = this.redis.pipeline();
                successfulTxs.forEach((tx) => {
                    console.log(`[${new Date().toISOString()}] 📤 Publishing transaction: ${tx.signature} for user ${tx.userId}, group ${tx.groupId}`);
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
        const { signature, walletAddress, blockTime, userId, groupId } = message;
        const requestId = require('uuid').v4();
        
        // ВАЖНО: передаем userId и groupId в очередь
        await this.redis.lpush(this.queueKey, JSON.stringify({
            requestId,
            signature,
            walletAddress,
            blockTime,
            userId,        // добавляем userId
            groupId,       // добавляем groupId
            timestamp: Date.now(),
        }));
        
        console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature} for user ${userId}, group ${groupId}`);
    
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

 async fetchSolPrice() {
    const now = Date.now();
    
    if (now - this.solPriceCache.lastUpdated < this.solPriceCache.cacheTimeout) {
        console.log(`[${new Date().toISOString()}] 💰 Using cached SOL price: $${this.solPriceCache.price}`);
        return this.solPriceCache.price;
    }

    try {
        console.log(`[${new Date().toISOString()}] 💰 Fetching fresh SOL price from DexScreener...`);
        const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
            const bestPair = data.pairs.reduce((prev, current) =>
                (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
            );
            const newPrice = parseFloat(bestPair.priceUsd || 150);

            this.solPriceCache = {
                price: newPrice,
                lastUpdated: now,
                cacheTimeout: 60000
            };
            
            console.log(`[${new Date().toISOString()}] 💰 Updated SOL price: $${newPrice}`);
            return newPrice;
        }
        
        console.warn(`[${new Date().toISOString()}] ⚠️ No SOL price data found, using fallback`);
        return this.solPriceCache.price;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
        return this.solPriceCache.price; 
    }
}

async processTransaction(sig, wallet) {
    try {
        if (!sig.signature || !sig.blockTime) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
            return null;
        }

        const existingTx = await this.db.pool.query(
            'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
            [sig.signature, wallet.id]
        );
        if (existingTx.rows.length > 0) {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed for wallet ${wallet.address}`);
            return null;
        }

        const processedKey = `${sig.signature}-${wallet.id}`;
        if (this.recentlyProcessed.has(processedKey)) {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} recently processed for wallet ${wallet.address}`);
            return null;
        }
        this.recentlyProcessed.add(processedKey);

        if (this.recentlyProcessed.size > 1000) {
            const toDelete = Array.from(this.recentlyProcessed).slice(0, 500);
            toDelete.forEach(key => this.recentlyProcessed.delete(key));
        }

        console.log(`[${new Date().toISOString()}] 🔍 Processing transaction ${sig.signature} for wallet ${wallet.address}`);

        const tx = await this.fetchTransactionWithRetry(sig.signature);
        if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature} - missing metadata`);
            return null;
        }

        const walletPubkey = wallet.address;
        let walletIndex = -1;
        if (tx.transaction.message.accountKeys) {
            if (Array.isArray(tx.transaction.message.accountKeys)) {
                walletIndex = tx.transaction.message.accountKeys.findIndex(
                    (key) => key.pubkey ? key.pubkey.toString() === walletPubkey : key.toString() === walletPubkey
                );
            } else if (tx.transaction.message.staticAccountKeys) {
                walletIndex = tx.transaction.message.staticAccountKeys.findIndex(
                    (key) => key.toString() === walletPubkey
                );
            }
            if (walletIndex === -1 && tx.transaction.message.addressTableLookups) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Versioned transaction with address table lookups not fully supported yet`);
                return null;
            }
        }

        if (walletIndex === -1) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
            return null;
        }

        const preBalance = tx.meta.preBalances[walletIndex] || 0;
        const postBalance = tx.meta.postBalances[walletIndex] || 0;
        const solChange = (postBalance - preBalance) / 1e9;

        console.log(`[${new Date().toISOString()}] 💰 SOL balance change for ${walletPubkey}:`);
        console.log(`  - Pre: ${(preBalance / 1e9).toFixed(6)} SOL`);
        console.log(`  - Post: ${(postBalance / 1e9).toFixed(6)} SOL`);
        console.log(`  - Change: ${solChange.toFixed(6)} SOL`);

        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        let transactionType, totalSolAmount = 0, usdcAmount = 0;
        const FEE_THRESHOLD = 0.01;
        let tokenChanges = [];

        const solPrice = await this.fetchSolPrice();
        console.log(`[${new Date().toISOString()}] 💰 Current SOL price: ${solPrice}`);

        let usdcChange = 0;
        const usdcPreBalance = (tx.meta.preTokenBalances || []).find(b => b.mint === USDC_MINT && b.owner === walletPubkey);
        const usdcPostBalance = (tx.meta.postTokenBalances || []).find(b => b.mint === USDC_MINT && b.owner === walletPubkey);
        
        if (usdcPreBalance && usdcPostBalance) {
            usdcChange = (Number(usdcPostBalance.uiTokenAmount.amount) - Number(usdcPreBalance.uiTokenAmount.amount)) / 1e6;
        } else if (usdcPostBalance) {
            usdcChange = Number(usdcPostBalance.uiTokenAmount.uiAmount || 0);
        } else if (usdcPreBalance) {
            usdcChange = -Number(usdcPreBalance.uiTokenAmount.uiAmount || 0);
        }

        console.log(`[${new Date().toISOString()}] 💵 USDC change: ${usdcChange.toFixed(2)} USDC`);

        if (usdcChange !== 0) {
            usdcAmount = Math.abs(usdcChange);
            const usdcSolEquivalent = usdcAmount / solPrice;
            
            if (usdcChange < 0) {
                transactionType = 'buy';
                totalSolAmount = usdcSolEquivalent; 
                console.log(`[${new Date().toISOString()}] 🛒 Detected USDC BUY: spent ${usdcAmount.toFixed(2)} USDC = ${totalSolAmount.toFixed(6)} SOL equivalent`);
            } else if (usdcChange > 0) {
                transactionType = 'sell';
                totalSolAmount = usdcSolEquivalent; 
                console.log(`[${new Date().toISOString()}] 💸 Detected USDC SELL: received ${usdcAmount.toFixed(2)} USDC = ${totalSolAmount.toFixed(6)} SOL equivalent`);
            }
            tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType, walletPubkey);
        } else if (solChange < -FEE_THRESHOLD) {
            transactionType = 'buy';
            totalSolAmount = Math.abs(solChange);
            console.log(`[${new Date().toISOString()}] 🛒 Detected SOL BUY: spent ${totalSolAmount.toFixed(6)} SOL`);
            tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType, walletPubkey);
        } else if (solChange > 0.001) {
            transactionType = 'sell';
            totalSolAmount = solChange;
            console.log(`[${new Date().toISOString()}] 💸 Detected SOL SELL: received ${totalSolAmount.toFixed(6)} SOL`);
            tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType, walletPubkey);
        } else {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange.toFixed(6)} (likely just fees)`);
            return null;
        }

        if (tokenChanges.length === 0) {
            console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
            return null;
        }

        console.log(`[${new Date().toISOString()}] ✅ Found ${tokenChanges.length} token changes, saving transaction`);

        return await this.db.withTransaction(async (client) => {
            const finalCheck = await client.query(
                'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                [sig.signature, wallet.id]
            );
            if (finalCheck.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already exists, skipping insert`);
                return null;
            }

            const query = `
                INSERT INTO transactions (
                    wallet_id, signature, block_time, transaction_type,
                    sol_spent, sol_received, usdc_spent, usdc_received
                ) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, signature, transaction_type
            `;
            const result = await client.query(query, [
                wallet.id,
                sig.signature,
                new Date(sig.blockTime * 1000).toISOString(),
                transactionType,
                transactionType === 'buy' ? totalSolAmount : 0,
                transactionType === 'sell' ? totalSolAmount : 0,
                transactionType === 'buy' && usdcAmount ? usdcAmount : 0,
                transactionType === 'sell' && usdcAmount ? usdcAmount : 0,
            ]);

            if (result.rows.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} was already inserted by another process`);
                return null;
            }

            const transaction = result.rows[0];
            const tokenSavePromises = tokenChanges.map((tokenChange) =>
                this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
            );
            await Promise.all(tokenSavePromises);

            console.log(`[${new Date().toISOString()}] ✅ Successfully saved transaction ${sig.signature} with ${tokenChanges.length} token operations`);
            console.log(`[${new Date().toISOString()}] 💰 Transaction summary: ${transactionType} ${totalSolAmount.toFixed(6)} SOL${usdcAmount ? ` (from ${usdcAmount.toFixed(2)} USDC)` : ''}`);

            return {
                signature: sig.signature,
                type: transactionType,
                solAmount: totalSolAmount,
                usdcAmount,
                tokensChanged: tokenChanges,
            };
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
        console.error(`[${new Date().toISOString()}] ❌ Stack trace:`, error.stack);
        return null;
    }
}
async analyzeTokenChanges(meta, transactionType, walletAddress) {
    const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
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
        if (change.mint === WRAPPED_SOL_MINT || change.mint === USDC_MINT) {
            console.log(`[${new Date().toISOString()}] ⏭️ Skipping ${change.mint === WRAPPED_SOL_MINT ? 'WSOL' : 'USDC'}`);
            continue;
        }

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
        if (transactionType === 'buy' && rawChange > 0) {
            isValidChange = true;
            console.log(`[${new Date().toISOString()}] ✅ Valid BUY: token balance increased by ${rawChange} raw units`);
        } else if (transactionType === 'sell' && rawChange < 0) {
            isValidChange = true;
            console.log(`[${new Date().toISOString()}] ✅ Valid SELL: token balance decreased by ${Math.abs(rawChange)} raw units`);
        } else {
            console.log(`[${new Date().toISOString()}] ⏭️ Skipping token ${change.mint} - balance change doesn't match transaction type`);
            continue;
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
        console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found for ${transactionType} transaction (excluding WSOL and USDC)`);
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

    console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} unique token changes (USDC excluded)`);
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

    async addWallet(address, name = null, groupId = null, userId = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name, groupId, userId);
            console.log(`[${new Date().toISOString()}] ✅ Added wallet: ${name || address.slice(0, 8)}... to group ${groupId || 'none'} for user ${userId}`);
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address, userId = null) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (wallet) {
                // Check if wallet belongs to user (if userId provided)
                if (userId && wallet.user_id !== userId) {
                    throw new Error('Access denied: Wallet does not belong to user');
                }
                
                const transactions = await this.db.getRecentTransactions(24 * 7);
                const walletSignatures = transactions
                    .filter((tx) => tx.wallet_address === address)
                    .map((tx) => tx.signature);
                walletSignatures.forEach((sig) => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet: ${address.slice(0, 8)}... for user ${userId || 'system'}`);
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async removeAllWallets(groupId = null, userId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🗑️ Removing all wallets from monitoring service${groupId ? ` for group ${groupId}` : ''}${userId ? ` for user ${userId}` : ''}`);
            
            // Build query based on parameters
            let query = `SELECT signature FROM transactions t JOIN wallets w ON t.wallet_id = w.id WHERE 1=1`;
            const params = [];
            let paramIndex = 1;
            
            if (userId) {
                query += ` AND w.user_id = $${paramIndex++}`;
                params.push(userId);
            }
            
            if (groupId) {
                query += ` AND w.group_id = $${paramIndex}`;
                params.push(groupId);
            }
            
            const transactions = await this.db.pool.query(query, params);
            const allSignatures = transactions.rows.map((tx) => tx.signature);
            allSignatures.forEach((sig) => this.processedSignatures.delete(sig));
            
            if (!groupId && !userId) {
                this.processedSignatures.clear();
                this.recentlyProcessed.clear();
            }
            
            // Remove wallets with user/group filter
            let deleteQuery = `DELETE FROM wallets WHERE 1=1`;
            const deleteParams = [];
            let deleteParamIndex = 1;
            
            if (userId) {
                deleteQuery += ` AND user_id = $${deleteParamIndex++}`;
                deleteParams.push(userId);
            }
            
            if (groupId) {
                deleteQuery += ` AND group_id = $${deleteParamIndex}`;
                deleteParams.push(groupId);
            }
            
            const result = await this.db.pool.query(deleteQuery, deleteParams);
            
            console.log(`[${new Date().toISOString()}] ✅ All wallets removed from monitoring service${groupId ? ` for group ${groupId}` : ''}${userId ? ` for user ${userId}` : ''} (${result.rowCount} wallets)`);
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