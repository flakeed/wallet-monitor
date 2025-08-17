const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

// Константы для стейблкоинов и анализа
const STABLECOIN_MINTS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJNm', // USDH
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC (old)
    'BXXkv6z8ykpG1yuvUDPgh732wzVHB69RnB9YgSYh3itW', // USDC (Wormhole)
]);

const STABLECOIN_INFO = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', priority: 1 },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', priority: 2 },
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJNm': { symbol: 'USDH', priority: 3 },
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC_OLD', priority: 4 },
    'BXXkv6z8ykpG1yuvUDPgh732wzVHB69RnB9YgSYh3itW': { symbol: 'USDC_WORMHOLE', priority: 5 },
};

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

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
        
        // Кэш для цен SOL/USD
        this.solPriceCache = {
            price: null,
            timestamp: 0,
            ttl: 60000 // 1 минута
        };
        
        console.log(`[${new Date().toISOString()}] 🔧 MonitoringService initialized with enhanced stablecoin support`);
    }

    // Получение текущей цены SOL в USD
    async getSolPriceUSD() {
        const now = Date.now();
        
        // Проверяем кэш
        if (this.solPriceCache.price && 
            (now - this.solPriceCache.timestamp) < this.solPriceCache.ttl) {
            return this.solPriceCache.price;
        }

        try {
            console.log(`[${new Date().toISOString()}] 📊 Fetching current SOL price...`);
            
            // Пробуем получить цену из нескольких источников
            const sources = [
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
                'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
            ];

            for (const source of sources) {
                try {
                    const response = await fetch(source, { timeout: 5000 });
                    const data = await response.json();
                    
                    let price = null;
                    if (source.includes('coingecko')) {
                        price = data?.solana?.usd;
                    } else if (source.includes('dexscreener')) {
                        // Берем самую ликвидную пару
                        const bestPair = data.pairs?.reduce((prev, current) => 
                            (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                        );
                        price = parseFloat(bestPair?.priceUsd);
                    }
                    
                    if (price && price > 0) {
                        this.solPriceCache = {
                            price,
                            timestamp: now
                        };
                        console.log(`[${new Date().toISOString()}] ✅ SOL price: $${price.toFixed(2)}`);
                        return price;
                    }
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to fetch from ${source}:`, error.message);
                }
            }
            
            // Fallback цена если все источники недоступны
            const fallbackPrice = 150;
            console.warn(`[${new Date().toISOString()}] ⚠️ Using fallback SOL price: $${fallbackPrice}`);
            this.solPriceCache = {
                price: fallbackPrice,
                timestamp: now
            };
            return fallbackPrice;
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
            return 150; // Fallback
        }
    }

    // Конвертация стейблкоинов в SOL эквивалент
    async convertStablecoinToSOL(stablecoinAmount, stablecoinMint) {
        try {
            const solPriceUSD = await this.getSolPriceUSD();
            
            // Стейблкоины примерно равны $1, поэтому просто делим на цену SOL
            const solEquivalent = stablecoinAmount / solPriceUSD;
            
            console.log(`[${new Date().toISOString()}] 💱 Conversion: ${stablecoinAmount} ${STABLECOIN_INFO[stablecoinMint]?.symbol || 'STABLE'} = ${solEquivalent.toFixed(6)} SOL (SOL price: $${solPriceUSD.toFixed(2)})`);
            
            return solEquivalent;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error converting stablecoin to SOL:`, error.message);
            // Fallback: используем примерную цену SOL = $150
            return stablecoinAmount / 150;
        }
    }

    // Вспомогательные функции для анализа стейблкоинов
    isStablecoin(mint) {
        return STABLECOIN_MINTS.has(mint);
    }

    analyzeTokenSwaps(preTokenBalances, postTokenBalances) {
        const balanceChanges = new Map();
        
        // Обрабатываем pre-balances
        for (const pre of preTokenBalances || []) {
            const key = `${pre.mint}-${pre.accountIndex}`;
            balanceChanges.set(key, {
                mint: pre.mint,
                accountIndex: pre.accountIndex,
                owner: pre.owner,
                preAmount: Number(pre.uiTokenAmount.amount || 0),
                preUiAmount: Number(pre.uiTokenAmount.uiAmount || 0),
                postAmount: 0,
                postUiAmount: 0,
                decimals: pre.uiTokenAmount.decimals
            });
        }
        
        // Обрабатываем post-balances
        for (const post of postTokenBalances || []) {
            const key = `${post.mint}-${post.accountIndex}`;
            if (balanceChanges.has(key)) {
                const existing = balanceChanges.get(key);
                existing.postAmount = Number(post.uiTokenAmount.amount || 0);
                existing.postUiAmount = Number(post.uiTokenAmount.uiAmount || 0);
            } else {
                balanceChanges.set(key, {
                    mint: post.mint,
                    accountIndex: post.accountIndex,
                    owner: post.owner,
                    preAmount: 0,
                    preUiAmount: 0,
                    postAmount: Number(post.uiTokenAmount.amount || 0),
                    postUiAmount: Number(post.uiTokenAmount.uiAmount || 0),
                    decimals: post.uiTokenAmount.decimals
                });
            }
        }
        
        const increased = [];
        const decreased = [];
        
        for (const [key, change] of balanceChanges) {
            const rawChange = change.postAmount - change.preAmount;
            const uiChange = change.postUiAmount - change.preUiAmount;
            
            // Пропускаем WSOL
            if (change.mint === WRAPPED_SOL_MINT) continue;
            
            if (rawChange > 0) {
                increased.push({
                    mint: change.mint,
                    rawChange: Math.abs(rawChange),
                    uiChange: Math.abs(uiChange),
                    decimals: change.decimals,
                    isStablecoin: this.isStablecoin(change.mint)
                });
            } else if (rawChange < 0) {
                decreased.push({
                    mint: change.mint,
                    rawChange: Math.abs(rawChange),
                    uiChange: Math.abs(uiChange),
                    decimals: change.decimals,
                    isStablecoin: this.isStablecoin(change.mint)
                });
            }
        }
        
        return { increased, decreased };
    }

    // Обновленный метод анализа токенов с поддержкой стейблкоинов
    async analyzeTokenChangesEnhanced(meta, transactionType, solChange, walletIndex) {
        const tokenChanges = [];
        
        console.log(`[${new Date().toISOString()}] 🔍 Enhanced token analysis with stablecoin support`);
        console.log(`  - SOL change: ${solChange.toFixed(6)}`);
        console.log(`  - Pre-token balances: ${meta.preTokenBalances?.length || 0}`);
        console.log(`  - Post-token balances: ${meta.postTokenBalances?.length || 0}`);
        
        const { increased, decreased } = this.analyzeTokenSwaps(meta.preTokenBalances, meta.postTokenBalances);
        
        console.log(`  - Tokens increased: ${increased.length}`);
        console.log(`  - Tokens decreased: ${decreased.length}`);
        
        // Анализируем паттерны торговли
        const stablecoinsIncreased = increased.filter(t => t.isStablecoin);
        const stablecoinsDecreased = decreased.filter(t => t.isStablecoin);
        const tokensIncreased = increased.filter(t => !t.isStablecoin);
        const tokensDecreased = decreased.filter(t => !t.isStablecoin);
        
        console.log(`  - Stablecoins increased: ${stablecoinsIncreased.length}`);
        console.log(`  - Stablecoins decreased: ${stablecoinsDecreased.length}`);
        console.log(`  - Other tokens increased: ${tokensIncreased.length}`);
        console.log(`  - Other tokens decreased: ${tokensDecreased.length}`);
        
        // ПРАВИЛЬНАЯ ЛОГИКА: анализируем что реально произошло
        
        // Считаем изменения стейблкоинов
        let totalStablecoinIncrease = 0;  // Получили стейблкоинов
        let totalStablecoinDecrease = 0;  // Потеряли стейблкоинов
        
        stablecoinsIncreased.forEach(stable => {
            totalStablecoinIncrease += stable.uiChange;
            console.log(`  - GAINED ${stable.uiChange} ${STABLECOIN_INFO[stable.mint]?.symbol || 'STABLE'}`);
        });
        
        stablecoinsDecreased.forEach(stable => {
            totalStablecoinDecrease += stable.uiChange;
            console.log(`  - LOST ${stable.uiChange} ${STABLECOIN_INFO[stable.mint]?.symbol || 'STABLE'}`);
        });
        
        const netStablecoinChange = totalStablecoinIncrease - totalStablecoinDecrease;
        
        console.log(`  - Net stablecoin change: ${netStablecoinChange >= 0 ? '+' : ''}${netStablecoinChange.toFixed(6)}`);
        console.log(`  - Total stablecoin gained: ${totalStablecoinIncrease.toFixed(6)}`);
        console.log(`  - Total stablecoin lost: ${totalStablecoinDecrease.toFixed(6)}`);
        
        let detectedType = null;
        let validTokens = [];
        let solEquivalentAmount = Math.abs(solChange);
        
        // ИСПРАВЛЕННАЯ ЛОГИКА определения типа транзакции
        if (totalStablecoinDecrease > 0.01 && tokensIncreased.length > 0) {
            // ПОКУПКА: потеряли стейблкоины И получили токены
            detectedType = 'buy';
            validTokens = tokensIncreased;
            
            // Используем количество потерянных стейблкоинов
            solEquivalentAmount = await this.convertStablecoinToSOL(totalStablecoinDecrease, stablecoinsDecreased[0]?.mint);
            
            console.log(`[${new Date().toISOString()}] ✅ Detected stablecoin BUY: spent ${totalStablecoinDecrease.toFixed(6)} STABLE = ${solEquivalentAmount.toFixed(6)} SOL equiv`);
            
        } else if (totalStablecoinIncrease > 0.01 && tokensDecreased.length > 0) {
            // ПРОДАЖА: получили стейблкоины И потеряли токены
            detectedType = 'sell';
            validTokens = tokensDecreased;
            
            // Используем количество полученных стейблкоинов
            solEquivalentAmount = await this.convertStablecoinToSOL(totalStablecoinIncrease, stablecoinsIncreased[0]?.mint);
            
            console.log(`[${new Date().toISOString()}] ✅ Detected stablecoin SELL: received ${totalStablecoinIncrease.toFixed(6)} STABLE = ${solEquivalentAmount.toFixed(6)} SOL equiv`);
            
        } else if (solChange < -0.01 && tokensIncreased.length > 0) {
            // Покупка за SOL (классическая логика)
            detectedType = 'buy';
            validTokens = tokensIncreased;
            solEquivalentAmount = Math.abs(solChange);
            console.log(`[${new Date().toISOString()}] ✅ Detected SOL BUY: ${solEquivalentAmount.toFixed(6)} SOL`);
            
        } else if (solChange > 0.001 && tokensDecreased.length > 0) {
            // Продажа за SOL (классическая логика)
            detectedType = 'sell';
            validTokens = tokensDecreased;
            solEquivalentAmount = solChange;
            console.log(`[${new Date().toISOString()}] ✅ Detected SOL SELL: ${solEquivalentAmount.toFixed(6)} SOL`);
            
        } else if (tokensDecreased.length > 0 && tokensIncreased.length > 0) {
            // Токен-токен свап - анализируем по стейблкоинам если есть
            
            if (Math.abs(netStablecoinChange) > 0.01) {
                if (netStablecoinChange > 0) {
                    // Получили больше стейблкоинов = продажа
                    detectedType = 'sell';
                    validTokens = tokensDecreased;
                    solEquivalentAmount = await this.convertStablecoinToSOL(totalStablecoinIncrease, 
                        stablecoinsIncreased[0]?.mint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
                    console.log(`[${new Date().toISOString()}] ✅ Detected token SWAP as SELL (gained ${totalStablecoinIncrease.toFixed(6)} stables)`);
                } else {
                    // Потеряли стейблкоины = покупка
                    detectedType = 'buy';
                    validTokens = tokensIncreased;
                    solEquivalentAmount = await this.convertStablecoinToSOL(totalStablecoinDecrease, 
                        stablecoinsDecreased[0]?.mint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
                    console.log(`[${new Date().toISOString()}] ✅ Detected token SWAP as BUY (lost ${totalStablecoinDecrease.toFixed(6)} stables)`);
                }
            } else {
                // Простой токен-токен свап без значительных изменений стейблкоинов
                if (tokensDecreased.length === 1 && tokensIncreased.length === 1) {
                    detectedType = 'sell';
                    validTokens = tokensDecreased;
                    solEquivalentAmount = Math.abs(solChange) || 0.000005;
                    console.log(`[${new Date().toISOString()}] ✅ Detected simple token SWAP (as sell): ${tokensDecreased[0].mint} -> ${tokensIncreased[0].mint}`);
                } else {
                    detectedType = 'buy';
                    validTokens = tokensIncreased;
                    solEquivalentAmount = Math.abs(solChange) || 0.000005;
                    console.log(`[${new Date().toISOString()}] ✅ Detected complex token SWAP (as buy)`);
                }
            }
        }
        
        // Fallback логика
        if (!detectedType) {
            if (solChange < -0.01) {
                detectedType = 'buy';
                validTokens = tokensIncreased;
                solEquivalentAmount = Math.abs(solChange);
                console.log(`[${new Date().toISOString()}] ⚠️ Fallback to SOL-based BUY`);
            } else if (solChange > 0.001) {
                detectedType = 'sell';
                validTokens = tokensDecreased;
                solEquivalentAmount = solChange;
                console.log(`[${new Date().toISOString()}] ⚠️ Fallback to SOL-based SELL`);
            } else {
                console.log(`[${new Date().toISOString()}] ❌ Cannot determine transaction type - no significant changes detected`);
                console.log(`  - SOL change too small: ${solChange.toFixed(6)}`);
                console.log(`  - Stablecoin net change: ${netStablecoinChange.toFixed(6)}`);
                console.log(`  - Tokens increased: ${tokensIncreased.length}, decreased: ${tokensDecreased.length}`);
                return null;
            }
        }
        
        if (validTokens.length === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid tokens found for ${detectedType} transaction`);
            return null;
        }
        
        // Группируем по mint и получаем метаданные
        const mintChanges = new Map();
        for (const token of validTokens) {
            if (mintChanges.has(token.mint)) {
                mintChanges.get(token.mint).totalRawChange += token.rawChange;
            } else {
                mintChanges.set(token.mint, {
                    mint: token.mint,
                    decimals: token.decimals,
                    totalRawChange: token.rawChange
                });
            }
        }
        
        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mintChanges.size} unique tokens`);
        
        const mints = Array.from(mintChanges.keys());
        const tokenInfos = await this.batchFetchTokenMetadata(mints);
        
        const finalTokenChanges = [];
        for (const [mint, aggregatedChange] of mintChanges) {
            const tokenInfo = tokenInfos.get(mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: aggregatedChange.decimals,
            };
            
            finalTokenChanges.push({
                mint: mint,
                rawChange: aggregatedChange.totalRawChange,
                decimals: aggregatedChange.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
            
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} raw units)`);
        }
        
        return { 
            detectedType, 
            tokenChanges: finalTokenChanges,
            solEquivalentAmount
        };
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

    // ОБНОВЛЕННЫЙ ГЛАВНЫЙ МЕТОД с новой логикой
    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }

            // Проверка на дубликаты
            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                [sig.signature, wallet.id]
            );
            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed for wallet ${wallet.address}`);
                return null;
            }

            const processedKey = `${sig.signature}-${wallet.id}`;
            if (this.recentlyProcessed && this.recentlyProcessed.has(processedKey)) {
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

            // Находим индекс кошелька
            const walletPubkey = wallet.address;
            let walletIndex = -1;
            
            if (tx.transaction.message.accountKeys) {
                if (Array.isArray(tx.transaction.message.accountKeys)) {
                    walletIndex = tx.transaction.message.accountKeys.findIndex(
                        (key) => key.pubkey ? key.pubkey.toString() === walletPubkey : key.toString() === walletPubkey
                    );
                } else {
                    if (tx.transaction.message.staticAccountKeys) {
                        walletIndex = tx.transaction.message.staticAccountKeys.findIndex(
                            (key) => key.toString() === walletPubkey
                        );
                    }
                    
                    if (walletIndex === -1 && tx.transaction.message.addressTableLookups) {
                        console.warn(`[${new Date().toISOString()}] ⚠️ Versioned transaction with address table lookups not fully supported yet`);
                        return null;
                    }
                }
            }

            if (walletIndex === -1) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
                return null;
            }

            // Анализируем изменение SOL баланса
            const preBalance = tx.meta.preBalances[walletIndex] || 0;
            const postBalance = tx.meta.postBalances[walletIndex] || 0;
            const solChange = (postBalance - preBalance) / 1e9;

            console.log(`[${new Date().toISOString()}] 💰 SOL balance change for ${walletPubkey}:`);
            console.log(`  - Pre: ${(preBalance / 1e9).toFixed(6)} SOL`);
            console.log(`  - Post: ${(postBalance / 1e9).toFixed(6)} SOL`);
            console.log(`  - Change: ${solChange.toFixed(6)} SOL`);

            // НОВАЯ ЛОГИКА: анализируем токены независимо от SOL изменений
            const analysis = await this.analyzeTokenChangesEnhanced(tx.meta, null, solChange, walletIndex);
            
            if (!analysis || !analysis.detectedType || analysis.tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no valid token operations detected`);
                
                // Расширенная диагностика
                console.log(`[${new Date().toISOString()}] 🔍 Debug info:`);
                console.log(`  - SOL change: ${solChange.toFixed(6)}`);
                console.log(`  - Pre-token balances: ${tx.meta.preTokenBalances?.length || 0}`);
                console.log(`  - Post-token balances: ${tx.meta.postTokenBalances?.length || 0}`);
                
                if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
                    const { increased, decreased } = this.analyzeTokenSwaps(tx.meta.preTokenBalances, tx.meta.postTokenBalances);
                    console.log(`  - Tokens increased: ${increased.length}`);
                    console.log(`  - Tokens decreased: ${decreased.length}`);
                }
                
                return null;
            }

            const { detectedType, tokenChanges, solEquivalentAmount } = analysis;

            console.log(`[${new Date().toISOString()}] ✅ Detected ${detectedType.toUpperCase()} transaction:`);
            console.log(`  - Tokens: ${tokenChanges.length}`);
            console.log(`  - SOL equivalent: ${solEquivalentAmount.toFixed(6)} SOL`);

            // Сохраняем транзакцию с правильным SOL эквивалентом
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
                        sol_spent, sol_received
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;
                const result = await client.query(query, [
                    wallet.id,
                    sig.signature,
                    new Date(sig.blockTime * 1000).toISOString(),
                    detectedType,
                    detectedType === 'buy' ? solEquivalentAmount : 0,
                    detectedType === 'sell' ? solEquivalentAmount : 0,
                ]);

                if (result.rows.length === 0) {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} was already inserted by another process`);
                    return null;
                }

                const transaction = result.rows[0];
                
                // Сохраняем операции с токенами
                const tokenSavePromises = tokenChanges.map((tokenChange) =>
                    this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, detectedType)
                );
                await Promise.all(tokenSavePromises);

                console.log(`[${new Date().toISOString()}] ✅ Successfully saved transaction ${sig.signature} with ${tokenChanges.length} token operations (${solEquivalentAmount.toFixed(6)} SOL equiv)`);

                return {
                    signature: sig.signature,
                    type: detectedType,
                    solAmount: solEquivalentAmount, // Используем рассчитанный эквивалент
                    tokensChanged: tokenChanges,
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            console.error(`[${new Date().toISOString()}] ❌ Stack trace:`, error.stack);
            return null;
        }
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