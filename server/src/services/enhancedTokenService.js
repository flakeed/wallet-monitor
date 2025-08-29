// server/src/services/enhancedTokenService.js - Direct pool analysis for accurate token data

const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');

class EnhancedTokenService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111', {
            commitment: 'confirmed'
        });
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        
        // Known program addresses
        this.PROGRAMS = {
            RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            RAYDIUM_AUTHORITY: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
            ORCA: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
            METEORA: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
            PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
            TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            SYSTEM_PROGRAM: '11111111111111111111111111111111'
        };
        
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        
        // Cache settings
        this.CACHE_TTL = 30; // 30 seconds for pool data
        this.SOL_PRICE_TTL = 60; // 1 minute for SOL price
        
        // SOL price cache
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0
        };
        
        console.log(`[${new Date().toISOString()}] 🚀 Enhanced Token Service initialized`);
        this.startSolPriceUpdater();
    }

    // Start background SOL price updater using DexScreener
    startSolPriceUpdater() {
        this.updateSolPrice();
        setInterval(() => this.updateSolPrice(), 30000); // Every 30 seconds
    }

    async updateSolPrice() {
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.pairs && data.pairs.length > 0) {
                    const bestPair = data.pairs.reduce((prev, current) =>
                        (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                    );
                    const newPrice = parseFloat(bestPair.priceUsd || 150);
                    
                    this.solPriceCache = {
                        price: newPrice,
                        lastUpdated: Date.now()
                    };
                    
                    await this.redis.setex('sol_price_enhanced', this.SOL_PRICE_TTL, JSON.stringify(this.solPriceCache));
                }
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to update SOL price:`, error.message);
        }
    }

    async getSolPrice() {
        const now = Date.now();
        
        if (now - this.solPriceCache.lastUpdated < 30000) {
            return {
                success: true,
                price: this.solPriceCache.price,
                source: 'cache'
            };
        }

        try {
            const cached = await this.redis.get('sol_price_enhanced');
            if (cached) {
                const data = JSON.parse(cached);
                this.solPriceCache = data;
                return {
                    success: true,
                    price: data.price,
                    source: 'redis'
                };
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Redis SOL price fetch failed:`, error.message);
        }

        return {
            success: true,
            price: this.solPriceCache.price,
            source: 'fallback'
        };
    }

    // Get comprehensive token data from pools
    async getTokenData(tokenMint) {
        try {
            const cacheKey = `token_data_${tokenMint}`;
            
            // Check cache first
            try {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    return { success: true, data: JSON.parse(cached), source: 'cache' };
                }
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Cache fetch failed for ${tokenMint}:`, error.message);
            }

            console.log(`[${new Date().toISOString()}] 🔍 Analyzing pools for token: ${tokenMint}`);
            
            // Get all pools for this token
            const pools = await this.findTokenPools(tokenMint);
            
            if (pools.length === 0) {
                console.log(`[${new Date().toISOString()}] ⚠️ No pools found for token ${tokenMint}`);
                return { success: false, error: 'No pools found' };
            }

            // Analyze pools to get best data
            const analysis = await this.analyzePools(tokenMint, pools);
            
            // Get token creation time
            const creationData = await this.getTokenCreationData(tokenMint);
            
            const result = {
                mint: tokenMint,
                price: analysis.price,
                priceInSol: analysis.priceInSol,
                marketCap: analysis.marketCap,
                volume24h: analysis.volume24h,
                liquidity: analysis.totalLiquidity,
                pools: analysis.poolCount,
                bestPool: analysis.bestPool,
                createdAt: creationData.createdAt,
                ageInHours: creationData.ageInHours,
                supply: analysis.supply,
                decimals: analysis.decimals,
                symbol: analysis.symbol,
                name: analysis.name,
                lastUpdated: Date.now()
            };

            // Cache result
            try {
                await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(result));
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Failed to cache token data:`, error.message);
            }

            console.log(`[${new Date().toISOString()}] ✅ Token analysis complete: $${analysis.price?.toFixed(8) || 'N/A'}, MC: $${analysis.marketCap?.toLocaleString() || 'N/A'}, Age: ${creationData.ageInHours?.toFixed(1) || 'N/A'}h`);
            
            return { success: true, data: result, source: 'fresh' };
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error analyzing token ${tokenMint}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    // Find all pools containing the token
    async findTokenPools(tokenMint) {
        const pools = [];
        
        try {
            // Search for token accounts of this mint
            const tokenAccounts = await this.connection.getParsedProgramAccounts(
                new PublicKey(this.PROGRAMS.TOKEN_PROGRAM),
                {
                    filters: [
                        { dataSize: 165 },
                        { memcmp: { offset: 0, bytes: tokenMint } }
                    ]
                }
            );

            console.log(`[${new Date().toISOString()}] 📊 Found ${tokenAccounts.length} token accounts for ${tokenMint}`);

            // Analyze each account to find pools
            for (const account of tokenAccounts.slice(0, 50)) { // Limit to first 50 accounts
                try {
                    const accountInfo = account.account.data.parsed.info;
                    const owner = accountInfo.owner;
                    const amount = parseFloat(accountInfo.tokenAmount.uiAmount || 0);
                    
                    if (amount === 0) continue;
                    
                    // Check if owner is a known DEX program
                    const poolType = this.identifyPoolType(owner);
                    if (poolType) {
                        const poolData = await this.analyzePool(account.pubkey.toString(), tokenMint, poolType, amount);
                        if (poolData) {
                            pools.push(poolData);
                        }
                    }
                } catch (error) {
                    // Skip problematic accounts
                    continue;
                }
            }
            
            console.log(`[${new Date().toISOString()}] 🏊 Found ${pools.length} valid pools for ${tokenMint}`);
            return pools;
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding pools:`, error.message);
            return [];
        }
    }

    // Identify pool type by owner
    identifyPoolType(owner) {
        if (owner === this.PROGRAMS.RAYDIUM || owner === this.PROGRAMS.RAYDIUM_AUTHORITY) return 'raydium';
        if (owner === this.PROGRAMS.ORCA) return 'orca';
        if (owner === this.PROGRAMS.METEORA) return 'meteora';
        if (owner === this.PROGRAMS.PUMP_FUN) return 'pumpfun';
        return null;
    }

    // Analyze individual pool
    async analyzePool(poolAddress, tokenMint, poolType, tokenAmount) {
        try {
            // Get all accounts owned by the pool
            const poolAccounts = await this.connection.getParsedProgramAccounts(
                new PublicKey(this.PROGRAMS.TOKEN_PROGRAM),
                {
                    filters: [
                        { dataSize: 165 },
                        { memcmp: { offset: 32, bytes: poolAddress } }
                    ]
                }
            );

            let solAmount = 0;
            let usdcAmount = 0;
            let otherTokenAmount = 0;
            let pairedMint = null;

            for (const account of poolAccounts) {
                const info = account.account.data.parsed.info;
                const mint = info.mint;
                const amount = parseFloat(info.tokenAmount.uiAmount || 0);

                if (mint === this.SOL_MINT) {
                    solAmount = amount;
                    pairedMint = this.SOL_MINT;
                } else if (mint === this.USDC_MINT) {
                    usdcAmount = amount;
                    pairedMint = this.USDC_MINT;
                } else if (mint !== tokenMint) {
                    otherTokenAmount = amount;
                    pairedMint = mint;
                }
            }

            // Calculate price based on available pairs
            let priceInSol = 0;
            let priceInUsd = 0;
            let liquidity = 0;

            const solPrice = this.solPriceCache.price;

            if (solAmount > 0 && tokenAmount > 0) {
                priceInSol = solAmount / tokenAmount;
                priceInUsd = priceInSol * solPrice;
                liquidity = solAmount * solPrice * 2; // Both sides of pool
            } else if (usdcAmount > 0 && tokenAmount > 0) {
                priceInUsd = usdcAmount / tokenAmount;
                priceInSol = priceInUsd / solPrice;
                liquidity = usdcAmount * 2; // Both sides of pool
            }

            if (priceInUsd === 0) return null;

            return {
                address: poolAddress,
                type: poolType,
                tokenAmount,
                solAmount,
                usdcAmount,
                priceInSol,
                priceInUsd,
                liquidity,
                pairedMint,
                pairedAmount: solAmount || usdcAmount || otherTokenAmount
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error analyzing pool ${poolAddress}:`, error.message);
            return null;
        }
    }

    // Analyze all pools to get best data
    async analyzePools(tokenMint, pools) {
        if (pools.length === 0) {
            return {
                price: 0,
                priceInSol: 0,
                marketCap: 0,
                volume24h: 0,
                totalLiquidity: 0,
                poolCount: 0,
                bestPool: null
            };
        }

        // Sort pools by liquidity
        const sortedPools = pools.sort((a, b) => b.liquidity - a.liquidity);
        const bestPool = sortedPools[0];
        
        // Calculate weighted average price based on liquidity
        let totalLiquidityWeight = 0;
        let weightedPriceSum = 0;
        
        for (const pool of pools) {
            if (pool.liquidity > 100) { // Only consider pools with >$100 liquidity
                totalLiquidityWeight += pool.liquidity;
                weightedPriceSum += pool.priceInUsd * pool.liquidity;
            }
        }
        
        const weightedPrice = totalLiquidityWeight > 0 ? weightedPriceSum / totalLiquidityWeight : bestPool.priceInUsd;
        const totalLiquidity = pools.reduce((sum, pool) => sum + pool.liquidity, 0);
        
        // Get token supply for market cap
        const supplyData = await this.getTokenSupply(tokenMint);
        const marketCap = supplyData.supply * weightedPrice;
        
        // Get basic token metadata
        const metadata = await this.getBasicTokenMetadata(tokenMint);

        return {
            price: weightedPrice,
            priceInSol: weightedPrice / this.solPriceCache.price,
            marketCap,
            volume24h: 0, // Would need historical data
            totalLiquidity,
            poolCount: pools.length,
            bestPool: {
                address: bestPool.address,
                type: bestPool.type,
                liquidity: bestPool.liquidity,
                priceInUsd: bestPool.priceInUsd
            },
            supply: supplyData.supply,
            decimals: supplyData.decimals,
            symbol: metadata.symbol,
            name: metadata.name
        };
    }

    // Get token supply
    async getTokenSupply(tokenMint) {
        try {
            const supply = await this.connection.getTokenSupply(new PublicKey(tokenMint));
            return {
                supply: parseFloat(supply.value.uiAmount || 0),
                decimals: supply.value.decimals
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token supply:`, error.message);
            return { supply: 0, decimals: 9 };
        }
    }

    // Get basic token metadata
    async getBasicTokenMetadata(tokenMint) {
        try {
            // Try to get from cache first
            const cached = await this.redis.get(`token_meta_${tokenMint}`);
            if (cached) {
                return JSON.parse(cached);
            }

            // For now, return basic data
            // In production, you'd fetch from Metaplex or other metadata sources
            const metadata = {
                symbol: 'UNK',
                name: 'Unknown Token'
            };

            await this.redis.setex(`token_meta_${tokenMint}`, 3600, JSON.stringify(metadata));
            return metadata;
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting metadata:`, error.message);
            return { symbol: 'UNK', name: 'Unknown Token' };
        }
    }

    // Get token creation data
    async getTokenCreationData(tokenMint) {
        try {
            // Get token creation signature
            const signatures = await this.connection.getSignaturesForAddress(
                new PublicKey(tokenMint),
                { limit: 1 }
            );

            if (signatures.length === 0) {
                return { createdAt: null, ageInHours: null };
            }

            const creationTime = signatures[0].blockTime;
            if (!creationTime) {
                return { createdAt: null, ageInHours: null };
            }

            const createdAt = new Date(creationTime * 1000);
            const ageInHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

            return {
                createdAt: createdAt.toISOString(),
                ageInHours
            };
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting creation data:`, error.message);
            return { createdAt: null, ageInHours: null };
        }
    }

    // Batch get multiple tokens
    async getTokenDataBatch(tokenMints) {
        const results = new Map();
        const uncachedMints = [];

        // Check cache for all tokens
        for (const mint of tokenMints) {
            try {
                const cached = await this.redis.get(`token_data_${mint}`);
                if (cached) {
                    results.set(mint, JSON.parse(cached));
                } else {
                    uncachedMints.push(mint);
                }
            } catch (error) {
                uncachedMints.push(mint);
            }
        }

        // Process uncached tokens in small batches
        const BATCH_SIZE = 5;
        for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
            const batch = uncachedMints.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (mint) => {
                const result = await this.getTokenData(mint);
                return { mint, result };
            });

            const batchResults = await Promise.all(batchPromises);
            
            batchResults.forEach(({ mint, result }) => {
                if (result.success) {
                    results.set(mint, result.data);
                } else {
                    results.set(mint, null);
                }
            });

            // Small delay between batches
            if (i + BATCH_SIZE < uncachedMints.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return results;
    }

    // Get service stats
    getStats() {
        return {
            solPrice: {
                current: this.solPriceCache.price,
                lastUpdated: this.solPriceCache.lastUpdated,
                age: Date.now() - this.solPriceCache.lastUpdated
            },
            rpcEndpoint: this.connection.rpcEndpoint,
            cacheSettings: {
                tokenDataTTL: this.CACHE_TTL,
                solPriceTTL: this.SOL_PRICE_TTL
            }
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Enhanced Token Service closed`);
    }
}

module.exports = EnhancedTokenService;