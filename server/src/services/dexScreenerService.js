// services/dexScreenerService.js
const axios = require('axios');
const Redis = require('ioredis');

class DexScreenerService {
    constructor() {
        this.baseUrl = 'https://api.dexscreener.com/latest/dex';
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212);
        this.priceCache = new Map();
        this.CACHE_TTL = 60; // Cache prices for 60 seconds
        this.BATCH_SIZE = 30; // DexScreener allows up to 30 tokens per request
    }

    /**
     * Get token price and liquidity data from DexScreener
     * @param {string} mintAddress - Token mint address
     * @returns {Promise<Object>} Token data including price, liquidity, volume
     */
    async getTokenData(mintAddress) {
        try {
            // Check Redis cache first
            const cached = await this.redis.get(`dex:token:${mintAddress}`);
            if (cached) {
                console.log(`[${new Date().toISOString()}] ⚡ DexScreener cache hit for ${mintAddress}`);
                return JSON.parse(cached);
            }

            // Fetch from DexScreener API
            const response = await axios.get(`${this.baseUrl}/tokens/${mintAddress}`, {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Wallet-Monitor/1.0'
                }
            });

            if (!response.data || !response.data.pairs || response.data.pairs.length === 0) {
                console.log(`[${new Date().toISOString()}] ⚠️ No pairs found for token ${mintAddress}`);
                return null;
            }

            // Get the most liquid pair (usually the first one)
            const mainPair = this.selectBestPair(response.data.pairs);
            
            const tokenData = {
                mintAddress,
                priceUsd: parseFloat(mainPair.priceUsd) || 0,
                priceNative: parseFloat(mainPair.priceNative) || 0, // Price in SOL
                liquidity: {
                    usd: mainPair.liquidity?.usd || 0,
                    base: mainPair.liquidity?.base || 0,
                    quote: mainPair.liquidity?.quote || 0
                },
                volume24h: mainPair.volume?.h24 || 0,
                priceChange24h: mainPair.priceChange?.h24 || 0,
                txns24h: {
                    buys: mainPair.txns?.h24?.buys || 0,
                    sells: mainPair.txns?.h24?.sells || 0
                },
                fdv: mainPair.fdv || 0,
                marketCap: mainPair.marketCap || 0,
                pairAddress: mainPair.pairAddress,
                dexId: mainPair.dexId,
                url: mainPair.url,
                lastUpdated: new Date().toISOString()
            };

            // Cache the result
            await this.redis.set(
                `dex:token:${mintAddress}`, 
                JSON.stringify(tokenData), 
                'EX', 
                this.CACHE_TTL
            );

            return tokenData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ DexScreener API error for ${mintAddress}:`, error.message);
            return null;
        }
    }

    /**
     * Get multiple token prices in batch
     * @param {string[]} mintAddresses - Array of token mint addresses
     * @returns {Promise<Map>} Map of mint address to token data
     */
    async getMultipleTokenData(mintAddresses) {
        const results = new Map();
        
        // Remove duplicates
        const uniqueMints = [...new Set(mintAddresses)];
        
        // Check cache first
        const uncachedMints = [];
        for (const mint of uniqueMints) {
            const cached = await this.redis.get(`dex:token:${mint}`);
            if (cached) {
                results.set(mint, JSON.parse(cached));
                console.log(`[${new Date().toISOString()}] ⚡ Cache hit for ${mint}`);
            } else {
                uncachedMints.push(mint);
            }
        }

        // Batch fetch uncached tokens
        if (uncachedMints.length > 0) {
            console.log(`[${new Date().toISOString()}] 🔍 Fetching ${uncachedMints.length} tokens from DexScreener`);
            
            // Process in batches
            for (let i = 0; i < uncachedMints.length; i += this.BATCH_SIZE) {
                const batch = uncachedMints.slice(i, i + this.BATCH_SIZE);
                const batchResults = await this.fetchBatch(batch);
                
                for (const [mint, data] of batchResults) {
                    results.set(mint, data);
                }
                
                // Small delay between batches to avoid rate limiting
                if (i + this.BATCH_SIZE < uncachedMints.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }

        return results;
    }

    /**
     * Fetch a batch of tokens from DexScreener
     * @private
     */
    async fetchBatch(mintAddresses) {
        const results = new Map();
        
        try {
            // DexScreener allows comma-separated addresses
            const addresses = mintAddresses.join(',');
            const response = await axios.get(`${this.baseUrl}/tokens/${addresses}`, {
                timeout: 10000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Wallet-Monitor/1.0'
                }
            });

            if (!response.data || !response.data.pairs) {
                return results;
            }

            // Group pairs by base token (mint address)
            const pairsByToken = new Map();
            for (const pair of response.data.pairs) {
                const baseToken = pair.baseToken?.address;
                if (!baseToken) continue;
                
                if (!pairsByToken.has(baseToken)) {
                    pairsByToken.set(baseToken, []);
                }
                pairsByToken.get(baseToken).push(pair);
            }

            // Process each token's pairs
            for (const [mintAddress, pairs] of pairsByToken) {
                const mainPair = this.selectBestPair(pairs);
                
                const tokenData = {
                    mintAddress,
                    priceUsd: parseFloat(mainPair.priceUsd) || 0,
                    priceNative: parseFloat(mainPair.priceNative) || 0,
                    liquidity: {
                        usd: mainPair.liquidity?.usd || 0,
                        base: mainPair.liquidity?.base || 0,
                        quote: mainPair.liquidity?.quote || 0
                    },
                    volume24h: mainPair.volume?.h24 || 0,
                    priceChange24h: mainPair.priceChange?.h24 || 0,
                    txns24h: {
                        buys: mainPair.txns?.h24?.buys || 0,
                        sells: mainPair.txns?.h24?.sells || 0
                    },
                    fdv: mainPair.fdv || 0,
                    marketCap: mainPair.marketCap || 0,
                    pairAddress: mainPair.pairAddress,
                    dexId: mainPair.dexId,
                    url: mainPair.url,
                    lastUpdated: new Date().toISOString()
                };

                // Cache the result
                await this.redis.set(
                    `dex:token:${mintAddress}`, 
                    JSON.stringify(tokenData), 
                    'EX', 
                    this.CACHE_TTL
                );

                results.set(mintAddress, tokenData);
            }

            // For mints that didn't return data, set null
            for (const mint of mintAddresses) {
                if (!results.has(mint)) {
                    results.set(mint, null);
                }
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ DexScreener batch fetch error:`, error.message);
            
            // Return null for all requested tokens on error
            for (const mint of mintAddresses) {
                results.set(mint, null);
            }
        }

        return results;
    }

    /**
     * Select the best pair from multiple pairs (highest liquidity/volume)
     * @private
     */
    selectBestPair(pairs) {
        if (!pairs || pairs.length === 0) return null;
        if (pairs.length === 1) return pairs[0];

        // Sort by liquidity USD (prefer most liquid pair)
        return pairs.sort((a, b) => {
            const liquidityA = parseFloat(a.liquidity?.usd || 0);
            const liquidityB = parseFloat(b.liquidity?.usd || 0);
            return liquidityB - liquidityA;
        })[0];
    }

    /**
     * Get current SOL price in USD
     */
    async getSolPrice() {
        try {
            const cached = await this.redis.get('dex:sol:price');
            if (cached) {
                return parseFloat(cached);
            }

            // Wrapped SOL address
            const wsolAddress = 'So11111111111111111111111111111111111111112';
            const response = await axios.get(`${this.baseUrl}/tokens/${wsolAddress}`, {
                timeout: 5000
            });

            if (response.data && response.data.pairs && response.data.pairs.length > 0) {
                // Get USDC pair for most accurate price
                const usdcPair = response.data.pairs.find(p => 
                    p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'
                ) || response.data.pairs[0];

                const solPrice = parseFloat(usdcPair.priceUsd) || 0;
                
                // Cache for 30 seconds
                await this.redis.set('dex:sol:price', solPrice.toString(), 'EX', 30);
                
                return solPrice;
            }

            return 0;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
            return 0;
        }
    }

    /**
     * Calculate unrealized PnL for a position
     */
    calculateUnrealizedPnL(tokenBalance, avgBuyPrice, currentPriceInSol) {
        if (!tokenBalance || tokenBalance <= 0 || !currentPriceInSol) {
            return {
                unrealizedPnlSol: 0,
                unrealizedPnlUsd: 0,
                currentValueSol: 0,
                currentValueUsd: 0
            };
        }

        const currentValueSol = tokenBalance * currentPriceInSol;
        const costBasisSol = tokenBalance * avgBuyPrice;
        const unrealizedPnlSol = currentValueSol - costBasisSol;

        return {
            unrealizedPnlSol,
            currentValueSol,
            costBasisSol
        };
    }

    /**
     * Clear all cached prices
     */
    async clearCache() {
        const keys = await this.redis.keys('dex:*');
        if (keys.length > 0) {
            await this.redis.del(...keys);
            console.log(`[${new Date().toISOString()}] 🗑️ Cleared ${keys.length} cached DexScreener entries`);
        }
    }

    /**
     * Get cache statistics
     */
    async getCacheStats() {
        const keys = await this.redis.keys('dex:*');
        const tokenKeys = keys.filter(k => k.startsWith('dex:token:'));
        
        return {
            totalCached: keys.length,
            tokensCached: tokenKeys.length,
            cacheKeys: keys
        };
    }
}

module.exports = DexScreenerService;