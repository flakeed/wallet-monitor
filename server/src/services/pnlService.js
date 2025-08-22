// server/src/services/pnlService.js - ULTRA-FAST PnL calculation service

const Redis = require('ioredis');

class PnLService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        
        // Кэш цен с очень коротким TTL для быстрых обновлений
        this.priceCache = new Map();
        this.solPriceCache = { price: 150, lastUpdated: 0 };
        
        // Batch запросы для оптимизации
        this.pendingPriceRequests = new Map();
        this.batchTimeout = null;
        this.BATCH_DELAY = 100; // 100ms для batch запросов
        this.PRICE_CACHE_TTL = 30000; // 30 секунд для цен токенов
        this.SOL_PRICE_TTL = 60000; // 1 минута для SOL
        
        console.log(`[${new Date().toISOString()}] 🚀 PnL Service initialized`);
    }

    // ULTRA-FAST SOL price with aggressive caching
    async getSolPrice() {
        const now = Date.now();
        
        if (now - this.solPriceCache.lastUpdated < this.SOL_PRICE_TTL) {
            return this.solPriceCache.price;
        }

        // Check Redis cache first
        try {
            const cachedPrice = await this.redis.get('sol_price');
            if (cachedPrice) {
                const priceData = JSON.parse(cachedPrice);
                if (now - priceData.timestamp < this.SOL_PRICE_TTL) {
                    this.solPriceCache = {
                        price: priceData.price,
                        lastUpdated: priceData.timestamp
                    };
                    return priceData.price;
                }
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Redis SOL price cache error:`, error.message);
        }

        // Fetch new price
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 3000 // 3 second timeout
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                
                const newPrice = parseFloat(bestPair.priceUsd || 150);
                
                this.solPriceCache = {
                    price: newPrice,
                    lastUpdated: now
                };

                // Cache in Redis
                try {
                    await this.redis.set('sol_price', JSON.stringify({
                        price: newPrice,
                        timestamp: now
                    }), 'EX', Math.floor(this.SOL_PRICE_TTL / 1000));
                } catch (redisError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to cache SOL price in Redis:`, redisError.message);
                }
                
                return newPrice;
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Failed to fetch SOL price:`, error.message);
        }
        
        return this.solPriceCache.price; // Return cached price as fallback
    }

    // BATCH token price fetching for maximum efficiency
    async getTokenPrice(mint) {
        return new Promise((resolve, reject) => {
            // Check local cache first
            const cached = this.priceCache.get(mint);
            if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
                resolve(cached.price);
                return;
            }

            // Add to pending requests
            if (!this.pendingPriceRequests.has(mint)) {
                this.pendingPriceRequests.set(mint, []);
            }
            this.pendingPriceRequests.get(mint).push({ resolve, reject });

            // Schedule batch processing
            this.scheduleBatchPriceRequest();
        });
    }

    scheduleBatchPriceRequest() {
        if (this.batchTimeout) return;
        
        this.batchTimeout = setTimeout(async () => {
            this.batchTimeout = null;
            await this.processBatchPriceRequests();
        }, this.BATCH_DELAY);
    }

    async processBatchPriceRequests() {
        if (this.pendingPriceRequests.size === 0) return;

        const mintsToFetch = Array.from(this.pendingPriceRequests.keys());
        console.log(`[${new Date().toISOString()}] 🚀 Processing batch price request for ${mintsToFetch.length} tokens`);

        // Check Redis cache for all tokens first
        const redisResults = await this.getBatchPricesFromRedis(mintsToFetch);
        const uncachedMints = [];

        for (const mint of mintsToFetch) {
            const cached = redisResults.get(mint);
            if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
                // Cache locally and resolve
                this.priceCache.set(mint, {
                    price: cached.price,
                    timestamp: cached.timestamp
                });
                
                const callbacks = this.pendingPriceRequests.get(mint) || [];
                callbacks.forEach(callback => callback.resolve(cached.price));
                this.pendingPriceRequests.delete(mint);
            } else {
                uncachedMints.push(mint);
            }
        }

        if (uncachedMints.length === 0) return;

        // Fetch uncached prices in parallel with retry logic
        const pricePromises = uncachedMints.map(mint => this.fetchSingleTokenPrice(mint));
        const results = await Promise.allSettled(pricePromises);

        // Process results
        results.forEach((result, index) => {
            const mint = uncachedMints[index];
            const callbacks = this.pendingPriceRequests.get(mint) || [];
            
            if (result.status === 'fulfilled' && result.value !== null) {
                const price = result.value;
                const now = Date.now();
                
                // Cache locally
                this.priceCache.set(mint, { price, timestamp: now });
                
                // Cache in Redis asynchronously
                this.redis.set(`token_price:${mint}`, JSON.stringify({
                    price,
                    timestamp: now
                }), 'EX', Math.floor(this.PRICE_CACHE_TTL / 1000)).catch(err => {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to cache price for ${mint}:`, err.message);
                });
                
                callbacks.forEach(callback => callback.resolve(price));
            } else {
                const error = result.status === 'rejected' ? result.reason : new Error('Failed to fetch price');
                callbacks.forEach(callback => callback.reject(error));
            }
            
            this.pendingPriceRequests.delete(mint);
        });
    }

    async getBatchPricesFromRedis(mints) {
        const results = new Map();
        
        try {
            const pipeline = this.redis.pipeline();
            mints.forEach(mint => {
                pipeline.get(`token_price:${mint}`);
            });
            
            const redisResults = await pipeline.exec();
            
            redisResults.forEach(([err, result], index) => {
                if (!err && result) {
                    try {
                        const priceData = JSON.parse(result);
                        results.set(mints[index], priceData);
                    } catch (parseError) {
                        console.warn(`[${new Date().toISOString()}] ⚠️ Failed to parse cached price for ${mints[index]}`);
                    }
                }
            });
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Redis batch price fetch error:`, error.message);
        }
        
        return results;
    }

    async fetchSingleTokenPrice(mint) {
        try {
            // Try DexScreener first (most reliable)
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 3000
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                
                const price = parseFloat(bestPair.priceUsd || 0);
                if (price > 0) return price;
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ DexScreener failed for ${mint}:`, error.message);
        }

        // Fallback to Jupiter API
        try {
            const jupiterResponse = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`, {
                timeout: 2000
            });
            
            if (jupiterResponse.ok) {
                const jupiterData = await jupiterResponse.json();
                if (jupiterData.data && jupiterData.data[mint]) {
                    const price = parseFloat(jupiterData.data[mint].price || 0);
                    if (price > 0) return price;
                }
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Jupiter fallback failed for ${mint}:`, error.message);
        }

        return null; // Failed to get price
    }

    // ULTRA-FAST PnL calculation with pre-computed data
    calculateTokenPnL(tokenData, currentPrice, solPrice) {
        if (!currentPrice || !solPrice || currentPrice <= 0 || solPrice <= 0) {
            return {
                totalPnLSOL: 0,
                totalPnLUSD: 0,
                realizedPnLSOL: 0,
                realizedPnLUSD: 0,
                unrealizedPnLSOL: 0,
                unrealizedPnLUSD: 0,
                currentHoldings: 0,
                currentValueUSD: 0,
                hasValidData: false
            };
        }

        const totalTokensBought = tokenData.totalTokensBought || 0;
        const totalTokensSold = tokenData.totalTokensSold || 0;
        const totalSpentSOL = tokenData.totalSpentSOL || 0;
        const totalReceivedSOL = tokenData.totalReceivedSOL || 0;

        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        
        let realizedPnLSOL = 0;
        let remainingCostBasisSOL = 0;

        if (totalTokensBought > 0 && totalTokensSold > 0) {
            const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
            const costOfSoldTokens = totalTokensSold * avgBuyPriceSOL;
            realizedPnLSOL = totalReceivedSOL - costOfSoldTokens;
            remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
        } else {
            realizedPnLSOL = totalReceivedSOL - totalSpentSOL;
            remainingCostBasisSOL = totalSpentSOL;
        }

        const currentValueUSD = currentHoldings * currentPrice;
        const remainingCostBasisUSD = remainingCostBasisSOL * solPrice;
        
        const unrealizedPnLUSD = currentValueUSD - remainingCostBasisUSD;
        const unrealizedPnLSOL = unrealizedPnLUSD / solPrice;
        
        const realizedPnLUSD = realizedPnLSOL * solPrice;
        const totalPnLUSD = realizedPnLUSD + unrealizedPnLUSD;
        const totalPnLSOL = totalPnLUSD / solPrice;

        return {
            totalPnLSOL,
            totalPnLUSD,
            realizedPnLSOL,
            realizedPnLUSD,
            unrealizedPnLSOL,
            unrealizedPnLUSD,
            currentHoldings,
            currentValueUSD,
            remainingCostBasisUSD,
            hasValidData: true
        };
    }

    // BATCH PnL calculation for multiple tokens
    async calculateBatchPnL(tokensData) {
        const startTime = Date.now();
        console.log(`[${new Date().toISOString()}] 🚀 Starting batch PnL calculation for ${tokensData.length} tokens`);

        // Get SOL price once
        const solPrice = await this.getSolPrice();

        // Extract unique mints
        const uniqueMints = [...new Set(tokensData.map(token => token.mint))];
        
        // Batch fetch all token prices
        const pricePromises = uniqueMints.map(mint => 
            this.getTokenPrice(mint).catch(error => {
                console.warn(`[${new Date().toISOString()}] ⚠️ Failed to get price for ${mint}:`, error.message);
                return null;
            })
        );

        const prices = await Promise.all(pricePromises);
        const priceMap = new Map();
        uniqueMints.forEach((mint, index) => {
            if (prices[index] !== null) {
                priceMap.set(mint, prices[index]);
            }
        });

        // Calculate PnL for each token
        const results = tokensData.map(tokenData => {
            const currentPrice = priceMap.get(tokenData.mint);
            const pnl = this.calculateTokenPnL(tokenData, currentPrice, solPrice);
            
            return {
                mint: tokenData.mint,
                symbol: tokenData.symbol,
                name: tokenData.name,
                currentPrice,
                solPrice,
                ...pnl
            };
        });

        const duration = Date.now() - startTime;
        const successfulPrices = results.filter(r => r.hasValidData).length;
        
        console.log(`[${new Date().toISOString()}] ✅ Batch PnL calculation completed in ${duration}ms: ${successfulPrices}/${tokensData.length} successful`);

        return results;
    }

    // Clean old cache entries periodically
    cleanCache() {
        const now = Date.now();
        
        for (const [mint, data] of this.priceCache.entries()) {
            if (now - data.timestamp > this.PRICE_CACHE_TTL * 2) {
                this.priceCache.delete(mint);
            }
        }
        
        // Clean pending requests that are too old
        for (const [mint, callbacks] of this.pendingPriceRequests.entries()) {
            if (callbacks.length === 0 || now - callbacks[0].timestamp > 30000) {
                this.pendingPriceRequests.delete(mint);
            }
        }
    }

    // Get cache statistics
    getCacheStats() {
        return {
            localPriceCache: this.priceCache.size,
            pendingRequests: this.pendingPriceRequests.size,
            solPrice: this.solPriceCache.price,
            solPriceAge: Date.now() - this.solPriceCache.lastUpdated
        };
    }
}

// Start cache cleaning interval
const pnlService = new PnLService();
setInterval(() => {
    pnlService.cleanCache();
}, 60000); // Clean every minute

module.exports = pnlService;