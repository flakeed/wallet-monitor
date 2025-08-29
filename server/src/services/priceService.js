// server/src/services/priceService.js - Updated to use enhanced token service

const EnhancedTokenService = require('./enhancedTokenService');

class PriceService {
    constructor() {
        this.enhancedTokenService = new EnhancedTokenService();
        
        console.log(`[${new Date().toISOString()}] 🚀 Price Service initialized with enhanced token analysis`);
    }

    // Get SOL price (using enhanced service)
    async getSolPrice() {
        try {
            return await this.enhancedTokenService.getSolPrice();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting SOL price:`, error.message);
            return {
                success: true,
                price: 150,
                source: 'fallback',
                error: error.message
            };
        }
    }

    // Get comprehensive token data with pool analysis
    async getTokenData(tokenMint) {
        try {
            const result = await this.enhancedTokenService.getTokenData(tokenMint);
            
            if (!result.success) {
                return null;
            }

            // Transform to match expected format
            return {
                price: result.data.price,
                priceInSol: result.data.priceInSol,
                marketCap: result.data.marketCap,
                volume24h: result.data.volume24h,
                liquidity: result.data.liquidity,
                change24h: 0, // Would need historical data
                pools: result.data.pools,
                bestPool: result.data.bestPool,
                createdAt: result.data.createdAt,
                ageInHours: result.data.ageInHours,
                supply: result.data.supply,
                decimals: result.data.decimals,
                symbol: result.data.symbol,
                name: result.data.name,
                source: result.source,
                lastUpdated: result.data.lastUpdated
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token data for ${tokenMint}:`, error.message);
            return null;
        }
    }

    // Get multiple token prices/data (batch processing)
    async getTokenPrices(tokenMints) {
        if (!tokenMints || tokenMints.length === 0) {
            return new Map();
        }

        try {
            console.log(`[${new Date().toISOString()}] 📊 Batch token analysis request for ${tokenMints.length} tokens`);
            const startTime = Date.now();
            
            const results = await this.enhancedTokenService.getTokenDataBatch(tokenMints);
            
            // Transform to expected format
            const priceMap = new Map();
            results.forEach((data, mint) => {
                if (data) {
                    priceMap.set(mint, {
                        price: data.price,
                        priceInSol: data.priceInSol,
                        marketCap: data.marketCap,
                        volume24h: data.volume24h,
                        liquidity: data.liquidity,
                        change24h: 0,
                        pools: data.pools,
                        bestPool: data.bestPool,
                        createdAt: data.createdAt,
                        ageInHours: data.ageInHours,
                        supply: data.supply,
                        decimals: data.decimals,
                        symbol: data.symbol,
                        name: data.name,
                        lastUpdated: data.lastUpdated
                    });
                } else {
                    priceMap.set(mint, null);
                }
            });

            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] ✅ Batch token analysis completed in ${duration}ms: ${priceMap.size} tokens processed`);
            
            return priceMap;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in batch token analysis:`, error.message);
            return new Map();
        }
    }

    // Legacy method for compatibility - single token price
    async getTokenPrice(tokenMint) {
        const data = await this.getTokenData(tokenMint);
        return data ? {
            price: data.price,
            change24h: data.change24h,
            volume24h: data.volume24h,
            liquidity: data.liquidity
        } : null;
    }

    // Get enhanced stats including pool analysis
    getStats() {
        const baseStats = this.enhancedTokenService.getStats();
        
        return {
            ...baseStats,
            serviceType: 'enhanced_pool_analysis',
            features: {
                poolAnalysis: true,
                marketCapCalculation: true,
                tokenAgeTracking: true,
                realTimePricing: true,
                multiDexSupport: true
            },
            supportedDEXes: ['raydium', 'orca', 'meteora', 'pumpfun']
        };
    }

    async close() {
        await this.enhancedTokenService.close();
        console.log(`[${new Date().toISOString()}] ✅ Price service closed`);
    }
}

module.exports = PriceService;