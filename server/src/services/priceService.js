const Redis = require('ioredis');
const { Connection, PublicKey } = require('@solana/web3.js');

class PriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', 'confirmed');
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0,
            cacheTimeout: 30000 // 30 seconds
        };
        this.tokenPriceCache = new Map();
        this.tokenAgeCache = new Map();
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

    // NEW: Get token deployment age from Solana blockchain
    async getTokenAge(mintAddress) {
        const cached = this.tokenAgeCache.get(mintAddress);
        if (cached && (Date.now() - cached.timestamp) < 3600000) { // 1 hour cache
            return cached.data;
        }

        try {
            const mintPubkey = new PublicKey(mintAddress);
            
            // Get the first transaction of the mint (deployment)
            const signatures = await this.connection.getSignaturesForAddress(
                mintPubkey,
                { limit: 1000 },
                'confirmed'
            );

            if (signatures.length === 0) {
                return { deployedAt: null, age: null, ageInHours: null, ageInDays: null };
            }

            // Get the oldest signature (deployment transaction)
            const deploymentSig = signatures[signatures.length - 1];
            
            if (deploymentSig.blockTime) {
                const deployedAt = new Date(deploymentSig.blockTime * 1000);
                const now = new Date();
                const ageInMs = now - deployedAt;
                const ageInHours = Math.floor(ageInMs / (1000 * 60 * 60));
                const ageInDays = Math.floor(ageInHours / 24);

                const ageData = {
                    deployedAt: deployedAt.toISOString(),
                    age: ageInMs,
                    ageInHours,
                    ageInDays,
                    ageFormatted: this.formatTokenAge(ageInHours)
                };

                // Cache the result
                this.tokenAgeCache.set(mintAddress, {
                    data: ageData,
                    timestamp: Date.now()
                });

                return ageData;
            }

            return { deployedAt: null, age: null, ageInHours: null, ageInDays: null };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching token age for ${mintAddress}:`, error.message);
            return { deployedAt: null, age: null, ageInHours: null, ageInDays: null, error: error.message };
        }
    }

    // NEW: Format token age in human readable format
    formatTokenAge(ageInHours) {
        if (ageInHours < 1) {
            return 'Less than 1 hour';
        } else if (ageInHours < 24) {
            return `${ageInHours}h`;
        } else if (ageInHours < 24 * 7) {
            const days = Math.floor(ageInHours / 24);
            const hours = ageInHours % 24;
            return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
        } else if (ageInHours < 24 * 30) {
            const weeks = Math.floor(ageInHours / (24 * 7));
            const days = Math.floor((ageInHours % (24 * 7)) / 24);
            return days > 0 ? `${weeks}w ${days}d` : `${weeks}w`;
        } else if (ageInHours < 24 * 365) {
            const months = Math.floor(ageInHours / (24 * 30));
            const days = Math.floor((ageInHours % (24 * 30)) / 24);
            return days > 0 ? `${months}mo ${Math.floor(days / 7)}w` : `${months}mo`;
        } else {
            const years = Math.floor(ageInHours / (24 * 365));
            const months = Math.floor((ageInHours % (24 * 365)) / (24 * 30));
            return months > 0 ? `${years}y ${months}mo` : `${years}y`;
        }
    }

    // ENHANCED: Optimized batch token price fetching with age and market cap
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
            const BATCH_SIZE = 8; // Reduced batch size for more comprehensive data
            for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
                const batch = uncachedMints.slice(i, i + BATCH_SIZE);
                
                const batchPromises = batch.map(async (mint) => {
                    try {
                        // Fetch price data from DexScreener
                        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                            timeout: 8000,
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
                            
                            // Get token age
                            const ageData = await this.getTokenAge(mint);
                            
                            priceData = {
                                price: parseFloat(bestPair.priceUsd || 0),
                                change24h: parseFloat(bestPair.priceChange?.h24 || 0),
                                volume24h: parseFloat(bestPair.volume?.h24 || 0),
                                liquidity: parseFloat(bestPair.liquidity?.usd || 0),
                                marketCap: parseFloat(bestPair.fdv || bestPair.marketCap || 0), // Fully Diluted Valuation or Market Cap
                                // Token age information
                                deployedAt: ageData.deployedAt,
                                ageInHours: ageData.ageInHours,
                                ageInDays: ageData.ageInDays,
                                ageFormatted: ageData.ageFormatted,
                                // Additional useful data
                                symbol: bestPair.baseToken?.symbol || 'Unknown',
                                name: bestPair.baseToken?.name || 'Unknown Token',
                                pairAddress: bestPair.pairAddress,
                                dexId: bestPair.dexId,
                                // Risk indicators
                                isNew: ageData.ageInHours ? ageData.ageInHours < 24 : false,
                                isVeryNew: ageData.ageInHours ? ageData.ageInHours < 1 : false,
                                liquidityRisk: parseFloat(bestPair.liquidity?.usd || 0) < 10000 ? 'HIGH' : 
                                             parseFloat(bestPair.liquidity?.usd || 0) < 50000 ? 'MEDIUM' : 'LOW'
                            };
                        }

                        // Cache the result
                        this.tokenPriceCache.set(mint, {
                            data: priceData,
                            timestamp: now
                        });

                        return { mint, data: priceData };
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error fetching enhanced price data for ${mint}:`, error.message);
                        return { mint, data: null };
                    }
                });

                const batchResults = await Promise.all(batchPromises);
                batchResults.forEach(({ mint, data }) => {
                    results.set(mint, data);
                });

                // Small delay between batches to avoid rate limiting
                if (i + BATCH_SIZE < uncachedMints.length) {
                    await new Promise(resolve => setTimeout(resolve, 200));
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
        this.tokenAgeCache.clear(); // Also clean age cache
        
        validEntries.forEach(([key, value]) => {
            this.tokenPriceCache.set(key, value);
        });

        console.log(`[${new Date().toISOString()}] 🧹 Cleaned token caches: ${validEntries.length} entries remaining`);
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
                priceSize: this.tokenPriceCache.size,
                ageSize: this.tokenAgeCache.size,
                maxSize: this.maxCacheSize,
                priceUtilization: Math.round((this.tokenPriceCache.size / this.maxCacheSize) * 100),
                ageUtilization: Math.round((this.tokenAgeCache.size / this.maxCacheSize) * 100)
            }
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Enhanced price service closed`);
    }
}

module.exports = PriceService;