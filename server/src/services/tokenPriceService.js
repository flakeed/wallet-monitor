const axios = require('axios');
const Redis = require('ioredis');

class TokenPriceService {
    constructor(redisUrl) {
        this.redis = new Redis(redisUrl || process.env.REDIS_URL);
        this.PRICE_CACHE_TTL = 300; // 5 minutes cache
        this.REQUEST_DELAY = 100; // 100ms between requests
        this.lastRequestTime = 0;
    }

    async fetchTokenPrice(mint) {
        try {
            const cacheKey = `price:${mint}`;
            const cachedPrice = await this.redis.get(cacheKey);
            
            if (cachedPrice) {
                console.log(`[${new Date().toISOString()}] 📈 Cache hit for mint ${mint}: ${cachedPrice}`);
                return Number(cachedPrice);
            }

            // Rate limiting
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.REQUEST_DELAY) {
                await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY - timeSinceLastRequest));
            }
            this.lastRequestTime = Date.now();

            console.log(`[${new Date().toISOString()}] 🔍 Fetching price for mint ${mint}`);

            // Try DexScreener first (most reliable for Solana tokens)
            const dexScreenerPrice = await this.fetchFromDexScreener(mint);
            if (dexScreenerPrice !== null) {
                await this.redis.set(cacheKey, dexScreenerPrice, 'EX', this.PRICE_CACHE_TTL);
                console.log(`[${new Date().toISOString()}] 📈 DexScreener price for ${mint}: ${dexScreenerPrice} SOL`);
                return dexScreenerPrice;
            }

            // Fallback to Jupiter API
            const jupiterPrice = await this.fetchFromJupiter(mint);
            if (jupiterPrice !== null) {
                await this.redis.set(cacheKey, jupiterPrice, 'EX', this.PRICE_CACHE_TTL);
                console.log(`[${new Date().toISOString()}] 📈 Jupiter price for ${mint}: ${jupiterPrice} SOL`);
                return jupiterPrice;
            }

            // Fallback to Birdeye API
            const birdeyePrice = await this.fetchFromBirdeye(mint);
            if (birdeyePrice !== null) {
                await this.redis.set(cacheKey, birdeyePrice, 'EX', this.PRICE_CACHE_TTL);
                console.log(`[${new Date().toISOString()}] 📈 Birdeye price for ${mint}: ${birdeyePrice} SOL`);
                return birdeyePrice;
            }

            // Check database for last known price
            const dbPrice = await this.getLastKnownPrice(mint);
            if (dbPrice && (Date.now() - new Date(dbPrice.fetched_at).getTime()) < 24 * 60 * 60 * 1000) { // Less than 24h old
                await this.redis.set(cacheKey, dbPrice.price, 'EX', this.PRICE_CACHE_TTL);
                console.log(`[${new Date().toISOString()}] 📈 Using DB price for ${mint}: ${dbPrice.price} SOL (${dbPrice.source})`);
                return dbPrice.price;
            }

            // Ultimate fallback - very small price to avoid division by zero
            const fallbackPrice = 0.000001;
            await this.redis.set(cacheKey, fallbackPrice, 'EX', 60); // Cache fallback for 1 minute only
            console.warn(`[${new Date().toISOString()}] ⚠️ Using fallback price for ${mint}: ${fallbackPrice} SOL`);
            return fallbackPrice;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${mint}:`, error.message);
            return 0.000001; // Safe fallback
        }
    }

    async fetchFromDexScreener(mint) {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'WalletMonitor/1.0'
                }
            });

            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Find the pair with highest liquidity for more accurate pricing
                const pairs = response.data.pairs.filter(p => 
                    p.chainId === 'solana' && 
                    p.quoteToken?.symbol === 'SOL' && 
                    p.priceNative && 
                    parseFloat(p.priceNative) > 0
                );

                if (pairs.length > 0) {
                    // Sort by liquidity (if available) or volume
                    pairs.sort((a, b) => {
                        const aLiq = parseFloat(a.liquidity?.usd || 0);
                        const bLiq = parseFloat(b.liquidity?.usd || 0);
                        if (aLiq !== bLiq) return bLiq - aLiq;
                        
                        const aVol = parseFloat(a.volume?.h24 || 0);
                        const bVol = parseFloat(b.volume?.h24 || 0);
                        return bVol - aVol;
                    });

                    const bestPair = pairs[0];
                    const priceInSol = parseFloat(bestPair.priceNative);
                    
                    if (priceInSol > 0) {
                        console.log(`[${new Date().toISOString()}] 📊 DexScreener data for ${mint}:`, {
                            pair: bestPair.pairAddress,
                            price: priceInSol,
                            liquidity: bestPair.liquidity?.usd,
                            volume24h: bestPair.volume?.h24
                        });
                        return priceInSol;
                    }
                }
            }
            return null;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ DexScreener API failed for ${mint}:`, error.message);
            return null;
        }
    }

    async fetchFromJupiter(mint) {
        try {
            const SOL_MINT = 'So11111111111111111111111111111111111111112';
            const response = await axios.get(`https://price.jup.ag/v4/price?ids=${mint}`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'WalletMonitor/1.0'
                }
            });

            if (response.data?.data?.[mint]?.price) {
                const priceInUsd = parseFloat(response.data.data[mint].price);
                
                // Get SOL price in USD to convert
                const solResponse = await axios.get(`https://price.jup.ag/v4/price?ids=${SOL_MINT}`, {
                    timeout: 5000
                });
                
                if (solResponse.data?.data?.[SOL_MINT]?.price) {
                    const solPriceInUsd = parseFloat(solResponse.data.data[SOL_MINT].price);
                    const priceInSol = priceInUsd / solPriceInUsd;
                    
                    if (priceInSol > 0) {
                        return priceInSol;
                    }
                }
            }
            return null;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Jupiter API failed for ${mint}:`, error.message);
            return null;
        }
    }

    async fetchFromBirdeye(mint) {
        try {
            const response = await axios.get(`https://public-api.birdeye.so/defi/price?address=${mint}`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'WalletMonitor/1.0',
                    'X-API-KEY': process.env.BIRDEYE_API_KEY || '' // Optional API key
                }
            });

            if (response.data?.data?.value) {
                const priceInUsd = parseFloat(response.data.data.value);
                
                // Get SOL price from Birdeye
                const solResponse = await axios.get('https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112', {
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'WalletMonitor/1.0',
                        'X-API-KEY': process.env.BIRDEYE_API_KEY || ''
                    }
                });

                if (solResponse.data?.data?.value) {
                    const solPriceInUsd = parseFloat(solResponse.data.data.value);
                    const priceInSol = priceInUsd / solPriceInUsd;
                    
                    if (priceInSol > 0) {
                        return priceInSol;
                    }
                }
            }
            return null;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Birdeye API failed for ${mint}:`, error.message);
            return null;
        }
    }

    async getLastKnownPrice(mint) {
        // This should use your database instance
        try {
            const Database = require('../database/connection');
            const db = new Database();
            return await db.getLatestPrice(mint);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting last known price from DB:`, error.message);
            return null;
        }
    }

    // Batch fetch prices for multiple tokens
    async batchFetchPrices(mints, batchSize = 10) {
        const results = new Map();
        
        for (let i = 0; i < mints.length; i += batchSize) {
            const batch = mints.slice(i, i + batchSize);
            const promises = batch.map(async (mint) => {
                const price = await this.fetchTokenPrice(mint);
                return { mint, price };
            });
            
            const batchResults = await Promise.all(promises);
            batchResults.forEach(({ mint, price }) => {
                results.set(mint, price);
            });
            
            // Small delay between batches to avoid rate limiting
            if (i + batchSize < mints.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        return results;
    }

    // Get historical price data (if needed for better PnL calculations)
    async fetchHistoricalPrice(mint, timestamp) {
        try {
            // DexScreener historical data (if available)
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 5000
            });

            if (response.data?.pairs?.[0]?.priceNative) {
                // Note: DexScreener doesn't provide historical data in free tier
                // You might need to implement your own price history storage
                console.log(`[${new Date().toISOString()}] 📈 Using current price as historical fallback for ${mint}`);
                return parseFloat(response.data.pairs[0].priceNative);
            }
            
            return null;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Historical price fetch failed for ${mint}:`, error.message);
            return null;
        }
    }
}

module.exports = TokenPriceService;