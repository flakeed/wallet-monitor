// server/src/services/simplifiedTokenService.js - Efficient token service with fallback

const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getMint } = require('@solana/spl-token');
const Redis = require('ioredis');

class SimplifiedTokenService {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111',
            { commitment: 'confirmed' }
        );
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        
        // Cache settings
        this.PRICE_CACHE_TTL = 30; // 30 seconds
        this.TOKEN_INFO_CACHE_TTL = 300; // 5 minutes
        this.DEPLOYMENT_CACHE_TTL = 3600; // 1 hour for deployment info
        
        // Fallback APIs
        this.fallbackApis = {
            dexscreener: 'https://api.dexscreener.com/latest/dex/tokens',
            jupiter: 'https://price.jup.ag/v6/price'
        };

        console.log(`[${new Date().toISOString()}] 🚀 Simplified Token Service initialized with RPC: ${this.connection.rpcEndpoint}`);
    }

    // ========== CORE TOKEN INFORMATION ==========
    
    async getTokenInfo(mintAddress) {
        const cacheKey = `token_info_v2:${mintAddress}`;
        
        try {
            // Check cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            console.log(`[${new Date().toISOString()}] 🔍 Fetching token info for ${mintAddress}`);

            // Get basic token info from RPC
            const [mintInfo, deploymentInfo, priceInfo] = await Promise.allSettled([
                this.getMintInfoRPC(mintAddress),
                this.getDeploymentInfoRPC(mintAddress),
                this.getPriceInfoFallback(mintAddress)
            ]);

            const tokenInfo = {
                mint: mintAddress,
                decimals: mintInfo.status === 'fulfilled' ? mintInfo.value.decimals : 9,
                supply: mintInfo.status === 'fulfilled' ? mintInfo.value.supply : null,
                deployedAt: deploymentInfo.status === 'fulfilled' ? deploymentInfo.value.deployedAt : null,
                deploymentBlock: deploymentInfo.status === 'fulfilled' ? deploymentInfo.value.block : null,
                symbol: 'Unknown',
                name: 'Unknown Token',
                priceData: priceInfo.status === 'fulfilled' ? priceInfo.value : {
                    price: 0,
                    volume24h: 0,
                    liquidity: 0,
                    marketCap: 0,
                    pools: [],
                    source: 'unavailable'
                },
                lastUpdated: Date.now()
            };

            // Try to get symbol/name from price data if available
            if (priceInfo.status === 'fulfilled' && priceInfo.value.tokenInfo) {
                tokenInfo.symbol = priceInfo.value.tokenInfo.symbol || tokenInfo.symbol;
                tokenInfo.name = priceInfo.value.tokenInfo.name || tokenInfo.name;
            }

            // Cache token info
            await this.redis.setex(cacheKey, this.TOKEN_INFO_CACHE_TTL, JSON.stringify(tokenInfo));
            
            return tokenInfo;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token info for ${mintAddress}:`, error.message);
            return {
                mint: mintAddress,
                decimals: 9,
                supply: null,
                deployedAt: null,
                deploymentBlock: null,
                symbol: 'Unknown',
                name: 'Unknown Token',
                priceData: { price: 0, volume24h: 0, liquidity: 0, marketCap: 0, pools: [], source: 'error' },
                lastUpdated: Date.now(),
                error: error.message
            };
        }
    }

    async getMintInfoRPC(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintAccount = await this.connection.getAccountInfo(mintPubkey);
            
            if (!mintAccount) {
                throw new Error('Mint account not found');
            }

            // Parse mint data manually to avoid potential issues with getMint
            const data = mintAccount.data;
            const decimals = data[44]; // Decimals are at offset 44
            
            // Supply is stored as 8 bytes starting at offset 36
            const supplyBytes = data.slice(36, 44);
            const supply = supplyBytes.readBigUInt64LE(0);

            return {
                decimals,
                supply: supply.toString(),
                isInitialized: true
            };
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get mint info via RPC for ${mintAddress}:`, error.message);
            throw error;
        }
    }

    async getDeploymentInfoRPC(mintAddress) {
        const cacheKey = `deployment:${mintAddress}`;
        
        try {
            // Check cache first (deployment info rarely changes)
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            const mintPubkey = new PublicKey(mintAddress);
            
            // Get signatures for this token (creation transactions)
            const signatures = await this.connection.getSignaturesForAddress(
                mintPubkey,
                { limit: 100 }, // Reduced limit to avoid timeout
                'confirmed'
            );

            if (signatures.length === 0) {
                return { deployedAt: null, block: null };
            }

            // The last signature should be the creation
            const creationSig = signatures[signatures.length - 1];
            
            const deploymentInfo = {
                deployedAt: creationSig.blockTime ? new Date(creationSig.blockTime * 1000) : null,
                block: creationSig.slot,
                signature: creationSig.signature
            };

            // Cache for longer since deployment info doesn't change
            await this.redis.setex(cacheKey, this.DEPLOYMENT_CACHE_TTL, JSON.stringify(deploymentInfo));
            
            return deploymentInfo;

        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get deployment info via RPC for ${mintAddress}:`, error.message);
            return { deployedAt: null, block: null };
        }
    }

    // ========== PRICE DATA WITH FALLBACK ==========

    async getTokenPrice(mintAddress) {
        const cacheKey = `price_v2:${mintAddress}`;
        
        try {
            // Check cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                const priceData = JSON.parse(cached);
                // Return cached data if less than cache TTL
                if (Date.now() - priceData.lastUpdated < this.PRICE_CACHE_TTL * 1000) {
                    return priceData;
                }
            }

            const priceData = await this.getPriceInfoFallback(mintAddress);
            
            // Cache price data
            await this.redis.setex(cacheKey, this.PRICE_CACHE_TTL, JSON.stringify(priceData));
            
            return priceData;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting price for ${mintAddress}:`, error.message);
            return {
                price: 0,
                priceUsd: 0,
                volume24h: 0,
                liquidity: 0,
                marketCap: 0,
                pools: [],
                lastUpdated: Date.now(),
                source: 'error',
                error: error.message
            };
        }
    }

    async getPriceInfoFallback(mintAddress) {
        // Try DexScreener first (most comprehensive)
        try {
            const response = await fetch(`${this.fallbackApis.dexscreener}/${mintAddress}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'WalletPulse/1.0' }
            });
            
            if (!response.ok) {
                throw new Error(`DexScreener HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                // Find the best pair by liquidity
                const bestPair = data.pairs.reduce((prev, current) => {
                    const prevLiq = prev.liquidity?.usd || 0;
                    const currLiq = current.liquidity?.usd || 0;
                    return currLiq > prevLiq ? current : prev;
                });

                const priceData = {
                    price: parseFloat(bestPair.priceUsd || 0),
                    priceUsd: parseFloat(bestPair.priceUsd || 0),
                    volume24h: parseFloat(bestPair.volume?.h24 || 0),
                    liquidity: parseFloat(bestPair.liquidity?.usd || 0),
                    marketCap: parseFloat(bestPair.marketCap || 0),
                    change24h: parseFloat(bestPair.priceChange?.h24 || 0),
                    pools: data.pairs.map(pair => ({
                        address: pair.pairAddress,
                        dex: pair.dexId,
                        liquidity: parseFloat(pair.liquidity?.usd || 0),
                        volume24h: parseFloat(pair.volume?.h24 || 0),
                        price: parseFloat(pair.priceUsd || 0)
                    })),
                    tokenInfo: {
                        symbol: bestPair.baseToken?.symbol || 'Unknown',
                        name: bestPair.baseToken?.name || 'Unknown Token'
                    },
                    lastUpdated: Date.now(),
                    source: 'dexscreener'
                };

                // Try to calculate market cap if not available
                if (!priceData.marketCap && priceData.price > 0) {
                    try {
                        const mintInfo = await this.getMintInfoRPC(mintAddress);
                        const supply = parseFloat(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
                        priceData.marketCap = supply * priceData.price;
                    } catch (error) {
                        // Ignore market cap calculation error
                    }
                }

                return priceData;
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ DexScreener failed for ${mintAddress}:`, error.message);
        }

        // Try Jupiter as fallback
        try {
            const response = await fetch(`${this.fallbackApis.jupiter}?ids=${mintAddress}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'WalletPulse/1.0' }
            });
            
            if (response.ok) {
                const data = await response.json();
                const priceInfo = data.data?.[mintAddress];
                
                if (priceInfo) {
                    return {
                        price: parseFloat(priceInfo.price || 0),
                        priceUsd: parseFloat(priceInfo.price || 0),
                        volume24h: 0,
                        liquidity: 0,
                        marketCap: 0,
                        change24h: 0,
                        pools: [],
                        lastUpdated: Date.now(),
                        source: 'jupiter'
                    };
                }
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Jupiter failed for ${mintAddress}:`, error.message);
        }

        // Return zero data if all fallbacks fail
        return {
            price: 0,
            priceUsd: 0,
            volume24h: 0,
            liquidity: 0,
            marketCap: 0,
            change24h: 0,
            pools: [],
            lastUpdated: Date.now(),
            source: 'no_data'
        };
    }

    // ========== SOL PRICE ==========
    
    async getSolPrice() {
        const cacheKey = 'sol_price_v2';
        
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                const priceData = JSON.parse(cached);
                if (Date.now() - priceData.timestamp < 30000) { // 30 seconds cache
                    return priceData.price;
                }
            }

            // Get SOL price from DexScreener
            const response = await fetch(`${this.fallbackApis.dexscreener}/So11111111111111111111111111111111111111112`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'WalletPulse/1.0' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const price = parseFloat(bestPair.priceUsd || 150);

                await this.redis.setex(cacheKey, 60, JSON.stringify({
                    price,
                    timestamp: Date.now()
                }));
                
                return price;
            }
            
            throw new Error('No SOL price data found');
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get SOL price, using fallback 150:`, error.message);
            return 150;
        }
    }

    // ========== BATCH OPERATIONS ==========

    async getTokenPrices(mintAddresses) {
        const results = new Map();
        const batchSize = 5; // Smaller batches to avoid overwhelming APIs
        
        for (let i = 0; i < mintAddresses.length; i += batchSize) {
            const batch = mintAddresses.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (mint) => {
                try {
                    const price = await this.getTokenPrice(mint);
                    return { mint, price };
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error getting price for ${mint}:`, error.message);
                    return { 
                        mint, 
                        price: {
                            price: 0,
                            priceUsd: 0,
                            volume24h: 0,
                            liquidity: 0,
                            marketCap: 0,
                            pools: [],
                            lastUpdated: Date.now(),
                            source: 'error',
                            error: error.message
                        }
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mint, price }) => {
                results.set(mint, price);
            });

            // Delay between batches to respect rate limits
            if (i + batchSize < mintAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return results;
    }

    // ========== UTILITY FUNCTIONS ==========

    async calculateMarketCap(mintAddress, priceUsd) {
        try {
            const mintInfo = await this.getMintInfoRPC(mintAddress);
            const supply = parseFloat(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
            return supply * priceUsd;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating market cap:`, error.message);
            return 0;
        }
    }

    // ========== SERVICE STATUS ==========
    
    getStats() {
        return {
            rpcEndpoint: this.connection.rpcEndpoint,
            fallbackApis: Object.keys(this.fallbackApis),
            cacheSettings: {
                priceTTL: this.PRICE_CACHE_TTL,
                tokenInfoTTL: this.TOKEN_INFO_CACHE_TTL,
                deploymentTTL: this.DEPLOYMENT_CACHE_TTL
            },
            mode: 'simplified_hybrid'
        };
    }

    async testConnectivity() {
        const results = {
            rpc: { status: 'unknown', latency: 0 },
            fallbacks: {}
        };

        // Test RPC
        try {
            const startTime = Date.now();
            const slot = await this.connection.getSlot();
            results.rpc = {
                status: 'connected',
                latency: Date.now() - startTime,
                currentSlot: slot
            };
        } catch (error) {
            results.rpc = {
                status: 'failed',
                error: error.message
            };
        }

        // Test fallback APIs
        for (const [name, baseUrl] of Object.entries(this.fallbackApis)) {
            try {
                const startTime = Date.now();
                const testUrl = name === 'jupiter' ? 
                    `${baseUrl}?ids=So11111111111111111111111111111111111111112` :
                    `${baseUrl}/So11111111111111111111111111111111111111112`;
                
                const response = await fetch(testUrl, { timeout: 5000 });
                results.fallbacks[name] = {
                    status: response.ok ? 'connected' : 'error',
                    latency: Date.now() - startTime,
                    httpStatus: response.status
                };
            } catch (error) {
                results.fallbacks[name] = {
                    status: 'failed',
                    error: error.message
                };
            }
        }

        return results;
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Simplified Token Service closed`);
    }
}

module.exports = SimplifiedTokenService;