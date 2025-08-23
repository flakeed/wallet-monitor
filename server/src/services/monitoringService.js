// Enhanced monitoring service with price tracking for accurate PnL

const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata } = require('./tokenService');
const Database = require('../database/connection');
const PriceService = require('./priceService');
const Redis = require('ioredis');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.priceService = new PriceService();
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
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.isProcessingQueue = false;
        this.queueKey = 'webhook:queue';
        this.batchSize = 400;

        // Enhanced price cache with historical tracking
        this.priceCache = new Map();
        this.maxPriceCacheSize = 10000;
        
        console.log(`[${new Date().toISOString()}] 🔧 Enhanced MonitoringService initialized with price tracking`);
    }

    // Enhanced transaction processing with price tracking
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
                return null;
            }
            this.recentlyProcessed.add(processedKey);

            if (this.recentlyProcessed.size > 1000) {
                const toDelete = Array.from(this.recentlyProcessed).slice(0, 500);
                toDelete.forEach(key => this.recentlyProcessed.delete(key));
            }

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
            }

            if (walletIndex === -1) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
                return null;
            }

            const preBalance = tx.meta.preBalances[walletIndex] || 0;
            const postBalance = tx.meta.postBalances[walletIndex] || 0;
            const solChange = (postBalance - preBalance) / 1e9;

            const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            let transactionType, totalSolAmount = 0, usdcAmount = 0;
            const FEE_THRESHOLD = 0.01;
            let tokenChanges = [];

            // Get SOL price at transaction time
            const blockTimestamp = new Date(sig.blockTime * 1000);
            const solPriceData = await this.getPriceAtTime('SOL', blockTimestamp);
            const solPrice = solPriceData.price || 150; // Fallback

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

            if (usdcChange !== 0) {
                usdcAmount = Math.abs(usdcChange);
                const usdcSolEquivalent = usdcAmount / solPrice;
                
                if (usdcChange < 0) {
                    transactionType = 'buy';
                    totalSolAmount = usdcSolEquivalent;
                } else if (usdcChange > 0) {
                    transactionType = 'sell';
                    totalSolAmount = usdcSolEquivalent;
                }
                tokenChanges = await this.analyzeTokenChangesWithPrices(tx.meta, transactionType, walletPubkey, blockTimestamp, solPrice);
            } else if (solChange < -FEE_THRESHOLD) {
                transactionType = 'buy';
                totalSolAmount = Math.abs(solChange);
                tokenChanges = await this.analyzeTokenChangesWithPrices(tx.meta, transactionType, walletPubkey, blockTimestamp, solPrice);
            } else if (solChange > 0.001) {
                transactionType = 'sell';
                totalSolAmount = solChange;
                tokenChanges = await this.analyzeTokenChangesWithPrices(tx.meta, transactionType, walletPubkey, blockTimestamp, solPrice);
            } else {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange.toFixed(6)} (likely just fees)`);
                return null;
            }

            if (tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
                return null;
            }

            return await this.db.withTransaction(async (client) => {
                const finalCheck = await client.query(
                    'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                    [sig.signature, wallet.id]
                );
                if (finalCheck.rows.length > 0) {
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
                    return null;
                }

                const transaction = result.rows[0];
                
                // Save token operations with price data
                const tokenSavePromises = tokenChanges.map((tokenChange) =>
                    this.saveTokenOperationWithPrices(client, transaction.id, tokenChange, transactionType, totalSolAmount)
                );
                await Promise.all(tokenSavePromises);

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount: totalSolAmount,
                    usdcAmount,
                    tokensChanged: tokenChanges,
                    solPrice: solPrice,
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            return null;
        }
    }

    // Enhanced token change analysis with price data
    async analyzeTokenChangesWithPrices(meta, transactionType, walletAddress, blockTimestamp, solPrice) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const tokenChanges = [];

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

        const mintChanges = new Map();
        for (const [key, change] of allBalanceChanges) {
            if (change.mint === WRAPPED_SOL_MINT || change.mint === USDC_MINT) {
                continue;
            }

            if (change.owner !== walletAddress) {
                continue;
            }

            const rawChange = Number(change.postAmount) - Number(change.preAmount);
            
            let isValidChange = false;
            if (transactionType === 'buy' && rawChange > 0) {
                isValidChange = true;
            } else if (transactionType === 'sell' && rawChange < 0) {
                isValidChange = true;
            } else {
                continue;
            }

            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += Math.abs(rawChange);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: Math.abs(rawChange)
                    });
                }
            }
        }

        if (mintChanges.size === 0) {
            return [];
        }

        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata and prices for ${mintChanges.size} unique tokens`);

        const mints = Array.from(mintChanges.keys());
        
        // Batch fetch token metadata
        const tokenInfos = await this.batchFetchTokenMetadata(mints);
        
        // Batch fetch token prices at transaction time
        const tokenPrices = await this.getBatchPricesAtTime(mints, blockTimestamp);

        for (const [mint, aggregatedChange] of mintChanges) {
            const tokenInfo = tokenInfos.get(mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: aggregatedChange.decimals,
            };

            const priceData = tokenPrices.get(mint) || {
                price: 0,
                confidence: 'low'
            };

            tokenChanges.push({
                mint: mint,
                rawChange: aggregatedChange.totalRawChange,
                decimals: aggregatedChange.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
                priceUsd: priceData.price,
                priceConfidence: priceData.confidence,
                solPrice: solPrice,
            });

            console.log(`[${new Date().toISOString()}] ✅ Added token change with price: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} units, $${priceData.price} per token)`);
        }

        return tokenChanges;
    }

    // Enhanced token operation saving with price data
    async saveTokenOperationWithPrices(client, transactionId, tokenChange, transactionType, totalSolAmount) {
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
            
            // Calculate SOL amount for this specific token operation
            // This is an approximation based on the token's share of the total transaction
            const tokenSolAmount = totalSolAmount; // For now, assume single token per transaction
            
            const operationQuery = `
                INSERT INTO token_operations (
                    transaction_id, token_id, amount, operation_type,
                    token_price_usd, sol_price_usd, sol_amount
                ) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `;
            await client.query(operationQuery, [
                transactionId, 
                tokenId, 
                amount, 
                transactionType,
                tokenChange.priceUsd || 0,
                tokenChange.solPrice || 150,
                tokenSolAmount
            ]);

            console.log(`[${new Date().toISOString()}] ✅ Saved token operation with prices: ${tokenInfo.symbol} - $${tokenChange.priceUsd} per token, SOL at $${tokenChange.solPrice}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error saving token operation with prices:`, error.message);
            throw error;
        }
    }

    // Get price at specific time (with caching)
    async getPriceAtTime(tokenSymbol, timestamp) {
        const cacheKey = `price_${tokenSymbol}_${Math.floor(timestamp.getTime() / (5 * 60 * 1000))}` // 5 minute buckets
        
        if (this.priceCache.has(cacheKey)) {
            return this.priceCache.get(cacheKey);
        }

        try {
            let priceData;
            if (tokenSymbol === 'SOL') {
                priceData = await this.priceService.getSolPrice();
            } else {
                // For historical prices, you might want to use a different service
                // For now, we'll use current price as fallback
                const prices = await this.priceService.getTokenPrices([tokenSymbol]);
                priceData = prices.get(tokenSymbol) || { price: 0, confidence: 'low' };
            }

            // Cache the result
            if (this.priceCache.size >= this.maxPriceCacheSize) {
                // Remove oldest entries
                const oldestKey = this.priceCache.keys().next().value;
                this.priceCache.delete(oldestKey);
            }
            
            this.priceCache.set(cacheKey, priceData);
            return priceData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting price for ${tokenSymbol}:`, error.message);
            return { price: 0, confidence: 'none' };
        }
    }

    // Batch get prices at specific time
    async getBatchPricesAtTime(mints, timestamp) {
        const results = new Map();
        const uncachedMints = [];
        const cacheTimestamp = Math.floor(timestamp.getTime() / (5 * 60 * 1000)); // 5 minute buckets

        // Check cache first
        for (const mint of mints) {
            const cacheKey = `price_${mint}_${cacheTimestamp}`;
            if (this.priceCache.has(cacheKey)) {
                results.set(mint, this.priceCache.get(cacheKey));
            } else {
                uncachedMints.push(mint);
            }
        }

        // Fetch uncached prices
        if (uncachedMints.length > 0) {
            try {
                const pricesMap = await this.priceService.getTokenPrices(uncachedMints);
                
                for (const mint of uncachedMints) {
                    const priceData = pricesMap.get(mint) || { price: 0, confidence: 'low' };
                    results.set(mint, priceData);
                    
                    // Cache the result
                    const cacheKey = `price_${mint}_${cacheTimestamp}`;
                    if (this.priceCache.size < this.maxPriceCacheSize) {
                        this.priceCache.set(cacheKey, priceData);
                    }
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error getting batch prices:`, error.message);
                // Set fallback prices
                for (const mint of uncachedMints) {
                    results.set(mint, { price: 0, confidence: 'none' });
                }
            }
        }

        return results;
    }

    // Rest of the methods remain the same...
    async fetchTransactionWithRetry(signature, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
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
                            console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature} with price data`);
                            return {
                                signature,
                                walletAddress,
                                walletName: wallet.name,
                                groupId: wallet.group_id,
                                groupName: wallet.group_name,
                                transactionType: txData.type,
                                solAmount: txData.solAmount,
                                solPrice: txData.solPrice || 150,
                                tokens: txData.tokensChanged.map((tc) => ({
                                    mint: tc.mint,
                                    amount: tc.rawChange / Math.pow(10, tc.decimals),
                                    symbol: tc.symbol,
                                    name: tc.name,
                                    priceUsd: tc.priceUsd || 0,
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

        if (!this.isProcessingQueue) {
            setImmediate(() => this.processQueue());
        }
    }

    // Legacy methods for compatibility
    startMonitoring() {
        console.log('⚠️ Legacy monitoring is deprecated. Use WebSocket service instead.');
        this.isMonitoring = false;
    }

    stopMonitoring() {
        this.isMonitoring = false;
        console.log('⏹️ Legacy monitoring stopped');
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
            
            let query = `SELECT signature FROM transactions t JOIN wallets w ON t.wallet_id = w.id WHERE 1=1`;
            const params = [];
            let paramIndex = 1;
            
            if (userId) {
                query += ` AND w.user_id = ${paramIndex++}`;
                params.push(userId);
            }
            
            if (groupId) {
                query += ` AND w.group_id = ${paramIndex}`;
                params.push(groupId);
            }
            
            const transactions = await this.db.pool.query(query, params);
            const allSignatures = transactions.rows.map((tx) => tx.signature);
            allSignatures.forEach((sig) => this.processedSignatures.delete(sig));
            
            if (!groupId && !userId) {
                this.processedSignatures.clear();
                this.recentlyProcessed.clear();
            }
            
            let deleteQuery = `DELETE FROM wallets WHERE 1=1`;
            const deleteParams = [];
            let deleteParamIndex = 1;
            
            if (userId) {
                deleteQuery += ` AND user_id = ${deleteParamIndex++}`;
                deleteParams.push(userId);
            }
            
            if (groupId) {
                deleteQuery += ` AND group_id = ${deleteParamIndex}`;
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
            priceCache: {
                size: this.priceCache.size,
                maxSize: this.maxPriceCacheSize,
            }
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
        await this.priceService.close();
        console.log(`[${new Date().toISOString()}] ✅ Enhanced monitoring service closed`);
    }
}

module.exports = WalletMonitoringService;