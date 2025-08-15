const fetch = require('node-fetch');
const Redis = require('ioredis');

class DexScreenerService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
        this.cachePrefix = 'dexscreener:price:';
        this.cacheTTL = 300; // 5 minutes cache
        this.requestDelay = 100; // 100ms between requests to avoid rate limiting
        this.lastRequestTime = 0;
    }

    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.requestDelay) {
            await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
    }

    async getTokenPrice(mintAddress) {
        try {
            // Check cache first
            const cacheKey = `${this.cachePrefix}${mintAddress}`;
            const cachedPrice = await this.redis.get(cacheKey);
            
            if (cachedPrice) {
                console.log(`[${new Date().toISOString()}] 💰 Cache hit for token price: ${mintAddress}`);
                return JSON.parse(cachedPrice);
            }

            // Rate limiting
            await this.rateLimit();

            console.log(`[${new Date().toISOString()}] 🌐 Fetching price from DexScreener for: ${mintAddress}`);
            
            const response = await fetch(`${this.baseUrl}/tokens/${mintAddress}`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Wallet-Monitor/1.0'
                }
            });

            if (!response.ok) {
                throw new Error(`DexScreener API error: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data.pairs || data.pairs.length === 0) {
                console.log(`[${new Date().toISOString()}] ⚠️ No pairs found for token: ${mintAddress}`);
                return null;
            }

            // Find the best pair (highest liquidity)
            const bestPair = data.pairs.reduce((best, current) => {
                const currentLiq = parseFloat(current.liquidity?.usd || 0);
                const bestLiq = parseFloat(best.liquidity?.usd || 0);
                return currentLiq > bestLiq ? current : best;
            });

            const priceData = {
                mintAddress,
                priceUsd: parseFloat(bestPair.priceUsd || 0),
                priceNative: parseFloat(bestPair.priceNative || 0), // Price in SOL
                liquidity: parseFloat(bestPair.liquidity?.usd || 0),
                volume24h: parseFloat(bestPair.volume?.h24 || 0),
                priceChange24h: parseFloat(bestPair.priceChange?.h24 || 0),
                pairAddress: bestPair.pairAddress,
                dexId: bestPair.dexId,
                lastUpdated: new Date().toISOString()
            };

            // Cache the result
            await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(priceData));
            
            console.log(`[${new Date().toISOString()}] ✅ Cached price for ${mintAddress}: ${priceData.priceNative} SOL`);
            return priceData;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${mintAddress}:`, error.message);
            return null;
        }
    }

    async getBatchTokenPrices(mintAddresses) {
        const results = new Map();
        
        // Process in smaller batches to avoid overwhelming the API
        const batchSize = 5;
        for (let i = 0; i < mintAddresses.length; i += batchSize) {
            const batch = mintAddresses.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (mintAddress) => {
                try {
                    const price = await this.getTokenPrice(mintAddress);
                    return { mintAddress, price };
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error in batch for ${mintAddress}:`, error.message);
                    return { mintAddress, price: null };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mintAddress, price }) => {
                results.set(mintAddress, price);
            });

            // Small delay between batches
            if (i + batchSize < mintAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return results;
    }

    async calculateTokenMetrics(tokenData, priceData) {
        if (!priceData || !priceData.priceNative) {
            return {
                totalTokensHeld: 0,
                totalSpentSOL: 0,
                currentValueSOL: 0,
                unrealizedPnlSOL: 0,
                realizedPnlSOL: 0,
                totalPnlSOL: 0
            };
        }

        const totalTokensHeld = tokenData.wallets.reduce((sum, wallet) => {
            return sum + (wallet.tokensBought - wallet.tokensSold);
        }, 0);

        const totalSpentSOL = tokenData.wallets.reduce((sum, wallet) => {
            return sum + wallet.solSpent;
        }, 0);

        const totalReceivedSOL = tokenData.wallets.reduce((sum, wallet) => {
            return sum + wallet.solReceived;
        }, 0);

        const currentValueSOL = totalTokensHeld * priceData.priceNative;
        const realizedPnlSOL = totalReceivedSOL - (tokenData.wallets.reduce((sum, wallet) => {
            return sum + (wallet.tokensSold > 0 ? wallet.solSpent * (wallet.tokensSold / wallet.tokensBought) : 0);
        }, 0));

        const unrealizedPnlSOL = currentValueSOL - (totalSpentSOL - (tokenData.wallets.reduce((sum, wallet) => {
            return sum + (wallet.tokensSold > 0 ? wallet.solSpent * (wallet.tokensSold / wallet.tokensBought) : 0);
        }, 0)));

        const totalPnlSOL = realizedPnlSOL + unrealizedPnlSOL;

        return {
            totalTokensHeld,
            totalSpentSOL,
            currentValueSOL,
            unrealizedPnlSOL,
            realizedPnlSOL,
            totalPnlSOL,
            currentPrice: priceData.priceNative
        };
    }

    async close() {
        try {
            await this.redis.quit();
            console.log('✅ DexScreener service Redis connection closed');
        } catch (error) {
            console.error('❌ Error closing DexScreener service Redis connection:', error.message);
        }
    }
}

module.exports = DexScreenerService;