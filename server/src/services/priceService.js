const Redis = require('ioredis');

class PriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://:123@localhost:6379');
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0,
            cacheTimeout: 30000 // 30 seconds
        };
        this.tokenPriceCache = new Map();
        this.maxCacheSize = 1000;
        
        // Start background price updates
        this.startBackgroundUpdates();
    }

    // Background service to keep SOL price fresh
    startBackgroundUpdates() {
        // Update SOL price every 30 seconds
        setInterval(async () => {
            try {
                await this.updateSolPriceInBackground();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
            }
        }, 30000);

        // Clean old token price cache every 5 minutes
        setInterval(() => {
            this.cleanTokenPriceCache();
        }, 300000);
    }

    async updateSolPriceInBackground() {
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const newPrice = parseFloat(bestPair.priceUsd || 150);

                this.solPriceCache = {
                    price: newPrice,
                    lastUpdated: Date.now(),
                    cacheTimeout: 30000
                };

                // Also cache in Redis for sharing across instances
                await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
                
                console.log(`[${new Date().toISOString()}] ✅ Updated SOL price in background: $${newPrice}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to update SOL price in background:`, error.message);
        }
    }

    async getSolPrice() {
        const now = Date.now();
        
        // Return cached price if fresh
        if (now - this.solPriceCache.lastUpdated < this.solPriceCache.cacheTimeout) {
            return {
                success: true,
                price: this.solPriceCache.price,
                source: 'cache',
                lastUpdated: this.solPriceCache.lastUpdated
            };
        }

        // Try to get from Redis first (shared cache)
        try {
            const redisPrice = await this.redis.get('sol_price');
            if (redisPrice) {
                const cached = JSON.parse(redisPrice);
                if (now - cached.lastUpdated < cached.cacheTimeout) {
                    this.solPriceCache = cached;
                    return {
                        success: true,
                        price: cached.price,
                        source: 'redis',
                        lastUpdated: cached.lastUpdated
                    };
                }
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Redis price fetch failed:`, error.message);
        }

        // Fetch fresh price
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const newPrice = parseFloat(bestPair.priceUsd || 150);

                this.solPriceCache = {
                    price: newPrice,
                    lastUpdated: now,
                    cacheTimeout: 30000
                };

                // Cache in Redis
                await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
                
                return {
                    success: true,
                    price: newPrice,
                    source: 'fresh',
                    lastUpdated: now
                };
            }
            
            throw new Error('No price data found');
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching fresh SOL price:`, error.message);
            
            // Return cached price even if expired, better than nothing
            return {
                success: true,
                price: this.solPriceCache.price,
                source: 'fallback',
                lastUpdated: this.solPriceCache.lastUpdated,
                error: error.message
            };
        }
    }

    // Optimized batch token price fetching
    async getTokenPrices(tokenMints) {
        if (!tokenMints || tokenMints.length === 0) {
            return new Map();
        }

        const results = new Map();
        const uncachedMints = [];
        const now = Date.now();

        // Check cache first
        for (const mint of tokenMints) {
            const cached = this.tokenPriceCache.get(mint);
            if (cached && (now - cached.timestamp) < 60000) { // 1 minute cache
                results.set(mint, cached.data);
            } else {
                uncachedMints.push(mint);
            }
        }

        // Fetch uncached prices in batches
        if (uncachedMints.length > 0) {
            const BATCH_SIZE = 10;
            for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
                const batch = uncachedMints.slice(i, i + BATCH_SIZE);
                
                const batchPromises = batch.map(async (mint) => {
                    try {
                        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                            timeout: 5000,
                            headers: { 'Accept': 'application/json' }
                        });
                        
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                        
                        const data = await response.json();
                        
                        let priceData = null;
                        if (data.pairs && data.pairs.length > 0) {
                            const bestPair = data.pairs.reduce((prev, current) =>
                                (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                            );
                            priceData = {
                                price: parseFloat(bestPair.priceUsd || 0),
                                change24h: parseFloat(bestPair.priceChange?.h24 || 0),
                                volume24h: parseFloat(bestPair.volume?.h24 || 0),
                                liquidity: parseFloat(bestPair.liquidity?.usd || 0)
                            };
                        }

                        // Cache the result
                        this.tokenPriceCache.set(mint, {
                            data: priceData,
                            timestamp: now
                        });

                        return { mint, data: priceData };
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${mint}:`, error.message);
                        return { mint, data: null };
                    }
                });

                const batchResults = await Promise.all(batchPromises);
                batchResults.forEach(({ mint, data }) => {
                    results.set(mint, data);
                });

                // Small delay between batches to avoid rate limiting
                if (i + BATCH_SIZE < uncachedMints.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }

        return results;
    }

    cleanTokenPriceCache() {
        if (this.tokenPriceCache.size <= this.maxCacheSize) return;

        const now = Date.now();
        const entries = Array.from(this.tokenPriceCache.entries());
        
        // Remove expired entries first
        const validEntries = entries.filter(([, value]) => 
            (now - value.timestamp) < 300000 // 5 minutes
        );

        // If still too many, keep only the most recent
        if (validEntries.length > this.maxCacheSize) {
            validEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            validEntries.length = this.maxCacheSize;
        }

        // Rebuild cache
        this.tokenPriceCache.clear();
        validEntries.forEach(([key, value]) => {
            this.tokenPriceCache.set(key, value);
        });

        console.log(`[${new Date().toISOString()}] 🧹 Cleaned token price cache: ${validEntries.length} entries remaining`);
    }

    // Get price service statistics
    getStats() {
        return {
            solPrice: {
                current: this.solPriceCache.price,
                lastUpdated: this.solPriceCache.lastUpdated,
                age: Date.now() - this.solPriceCache.lastUpdated
            },
            tokenCache: {
                size: this.tokenPriceCache.size,
                maxSize: this.maxCacheSize,
                utilization: Math.round((this.tokenPriceCache.size / this.maxCacheSize) * 100)
            }
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Price service closed`);
    }
}

module.exports = PriceService;