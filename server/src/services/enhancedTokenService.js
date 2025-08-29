// server/src/services/enhancedTokenService.js - Direct RPC token data service

const { Connection, PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddress } = require('@solana/spl-token');
const Redis = require('ioredis');

class EnhancedTokenService {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111',
            { commitment: 'confirmed' }
        );
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        
        // Known DEX program IDs
        this.dexPrograms = {
            RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUQpMDdHZsXNJgUSrp',
            ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            ORCA_V1: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
            ORCA_V2: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
            METEORA: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
            PHOENIX: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
            PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        };

        // Well-known token addresses
        this.knownTokens = {
            SOL: 'So11111111111111111111111111111111111111112',
            USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            WSOL: 'So11111111111111111111111111111111111111112'
        };

        // Cache settings
        this.PRICE_CACHE_TTL = 30; // 30 seconds
        this.TOKEN_INFO_CACHE_TTL = 300; // 5 minutes
        this.POOL_CACHE_TTL = 60; // 1 minute

        console.log(`[${new Date().toISOString()}] 🚀 Enhanced Token Service initialized with RPC: ${this.connection.rpcEndpoint}`);
    }

    // ========== TOKEN METADATA AND INFO ==========
    
    async getTokenInfo(mintAddress) {
        const cacheKey = `token_info:${mintAddress}`;
        
        try {
            // Check cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            const [mintInfo, deploymentInfo, metadataInfo] = await Promise.allSettled([
                this.getMintInfo(mintAddress),
                this.getTokenDeploymentInfo(mintAddress),
                this.getTokenMetadata(mintAddress)
            ]);

            const tokenInfo = {
                mint: mintAddress,
                decimals: mintInfo.status === 'fulfilled' ? mintInfo.value.decimals : 9,
                supply: mintInfo.status === 'fulfilled' ? mintInfo.value.supply : null,
                deployedAt: deploymentInfo.status === 'fulfilled' ? deploymentInfo.value.deployedAt : null,
                deploymentBlock: deploymentInfo.status === 'fulfilled' ? deploymentInfo.value.block : null,
                symbol: metadataInfo.status === 'fulfilled' ? metadataInfo.value.symbol : 'Unknown',
                name: metadataInfo.status === 'fulfilled' ? metadataInfo.value.name : 'Unknown Token',
                image: metadataInfo.status === 'fulfilled' ? metadataInfo.value.image : null,
                lastUpdated: Date.now()
            };

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
                image: null,
                lastUpdated: Date.now()
            };
        }
    }

    async getMintInfo(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintInfo = await getMint(this.connection, mintPubkey);
            
            return {
                decimals: mintInfo.decimals,
                supply: mintInfo.supply.toString(),
                mintAuthority: mintInfo.mintAuthority?.toString() || null,
                freezeAuthority: mintInfo.freezeAuthority?.toString() || null,
                isInitialized: mintInfo.isInitialized
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting mint info for ${mintAddress}:`, error.message);
            throw error;
        }
    }

    async getTokenDeploymentInfo(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            
            // Get signatures for this token (creation transactions)
            const signatures = await this.connection.getSignaturesForAddress(
                mintPubkey,
                { limit: 1000 },
                'confirmed'
            );

            if (signatures.length === 0) {
                return { deployedAt: null, block: null };
            }

            // The last signature should be the creation
            const creationSig = signatures[signatures.length - 1];
            
            return {
                deployedAt: creationSig.blockTime ? new Date(creationSig.blockTime * 1000) : null,
                block: creationSig.slot,
                signature: creationSig.signature
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting deployment info for ${mintAddress}:`, error.message);
            return { deployedAt: null, block: null };
        }
    }

    async getTokenMetadata(mintAddress) {
        try {
            // Try to get metadata from Metaplex standard
            const mintPubkey = new PublicKey(mintAddress);
            
            // Calculate metadata PDA
            const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
            const [metadataPDA] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from('metadata'),
                    METADATA_PROGRAM_ID.toBuffer(),
                    mintPubkey.toBuffer()
                ],
                METADATA_PROGRAM_ID
            );

            const metadataAccount = await this.connection.getAccountInfo(metadataPDA);
            
            if (!metadataAccount) {
                return { symbol: 'Unknown', name: 'Unknown Token', image: null };
            }

            // Parse metadata (simplified parsing)
            const metadata = this.parseMetadataAccount(metadataAccount.data);
            
            return {
                symbol: metadata.symbol || 'Unknown',
                name: metadata.name || 'Unknown Token',
                image: metadata.image || null,
                uri: metadata.uri || null
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting metadata for ${mintAddress}:`, error.message);
            return { symbol: 'Unknown', name: 'Unknown Token', image: null };
        }
    }

    // ========== PRICE DATA FROM POOLS ==========

    async getTokenPrice(mintAddress) {
        const cacheKey = `price:${mintAddress}`;
        
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

            // Get price from multiple DEX pools
            const pools = await this.findTokenPools(mintAddress);
            
            if (pools.length === 0) {
                return {
                    price: 0,
                    priceUsd: 0,
                    pools: [],
                    volume24h: 0,
                    liquidity: 0,
                    lastUpdated: Date.now(),
                    source: 'no_pools'
                };
            }

            // Calculate weighted average price based on liquidity
            const poolPrices = await Promise.allSettled(
                pools.map(pool => this.getPoolPrice(pool, mintAddress))
            );

            const validPrices = poolPrices
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            if (validPrices.length === 0) {
                return {
                    price: 0,
                    priceUsd: 0,
                    pools: pools.map(p => ({ address: p.address, dex: p.dex })),
                    volume24h: 0,
                    liquidity: 0,
                    lastUpdated: Date.now(),
                    source: 'no_valid_prices'
                };
            }

            // Calculate weighted average price
            const totalLiquidity = validPrices.reduce((sum, p) => sum + p.liquidity, 0);
            const weightedPrice = totalLiquidity > 0 ? 
                validPrices.reduce((sum, p) => sum + (p.price * p.liquidity), 0) / totalLiquidity :
                validPrices.reduce((sum, p) => sum + p.price, 0) / validPrices.length;

            const priceData = {
                price: weightedPrice,
                priceUsd: weightedPrice,
                pools: validPrices,
                volume24h: validPrices.reduce((sum, p) => sum + (p.volume24h || 0), 0),
                liquidity: totalLiquidity,
                marketCap: await this.calculateMarketCap(mintAddress, weightedPrice),
                lastUpdated: Date.now(),
                source: 'pools',
                poolCount: validPrices.length
            };

            // Cache price data
            await this.redis.setex(cacheKey, this.PRICE_CACHE_TTL, JSON.stringify(priceData));
            
            return priceData;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting price for ${mintAddress}:`, error.message);
            return {
                price: 0,
                priceUsd: 0,
                pools: [],
                volume24h: 0,
                liquidity: 0,
                lastUpdated: Date.now(),
                source: 'error',
                error: error.message
            };
        }
    }

    async findTokenPools(mintAddress) {
        const cacheKey = `pools:${mintAddress}`;
        
        try {
            // Check cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            const pools = [];
            const mintPubkey = new PublicKey(mintAddress);

            // Search for pools across different DEX programs
            for (const [dexName, programId] of Object.entries(this.dexPrograms)) {
                try {
                    const dexPools = await this.findPoolsForDEX(mintPubkey, programId, dexName);
                    pools.push(...dexPools);
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Error finding pools on ${dexName}:`, error.message);
                }
            }

            // Cache pools list
            await this.redis.setex(cacheKey, this.POOL_CACHE_TTL, JSON.stringify(pools));
            
            return pools;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding pools for ${mintAddress}:`, error.message);
            return [];
        }
    }

    async findPoolsForDEX(mintPubkey, programId, dexName) {
        try {
            // Use a lighter approach - try to find pools through known pool discovery methods
            // Instead of getting all program accounts which causes 500 errors
            
            const pools = [];
            
            // For now, we'll use a simplified approach that doesn't overload the RPC
            // This is a placeholder that can be enhanced with specific DEX pool discovery logic
            
            if (dexName.includes('RAYDIUM')) {
                // Try to find Raydium pools using their specific pool seeds/PDAs
                const raydiumPools = await this.findRaydiumPools(mintPubkey);
                pools.push(...raydiumPools);
            } else if (dexName.includes('ORCA')) {
                // Try to find Orca pools
                const orcaPools = await this.findOrcaPools(mintPubkey);
                pools.push(...orcaPools);
            } else if (dexName.includes('PUMP')) {
                // Try to find PumpFun pools
                const pumpPools = await this.findPumpFunPools(mintPubkey);
                pools.push(...pumpPools);
            }

            return pools;

        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not find pools for DEX ${dexName}:`, error.message);
            return [];
        }
    }

    async findRaydiumPools(mintPubkey) {
        // Simplified Raydium pool discovery
        // In a full implementation, you would use Raydium's specific pool derivation logic
        try {
            // This is a placeholder - implement based on Raydium's SDK
            return [];
        } catch (error) {
            return [];
        }
    }

    async findOrcaPools(mintPubkey) {
        // Simplified Orca pool discovery
        try {
            // This is a placeholder - implement based on Orca's SDK
            return [];
        } catch (error) {
            return [];
        }
    }

    async findPumpFunPools(mintPubkey) {
        // Simplified PumpFun pool discovery
        try {
            // This is a placeholder - implement based on PumpFun's pool structure
            return [];
        } catch (error) {
            return [];
        }
    }

    async getPoolPrice(pool, targetMintAddress) {
        try {
            const poolAccount = await this.connection.getAccountInfo(new PublicKey(pool.address));
            
            if (!poolAccount) {
                throw new Error('Pool account not found');
            }

            // Parse pool data based on DEX type
            const poolData = await this.parsePoolData(poolAccount.data, pool.dex);
            
            if (!poolData) {
                throw new Error('Could not parse pool data');
            }

            // Calculate price based on reserves
            const price = await this.calculatePoolPrice(poolData, targetMintAddress, pool);
            
            return {
                poolAddress: pool.address,
                dex: pool.dex,
                price: price.price,
                liquidity: price.liquidity,
                volume24h: price.volume24h || 0,
                reserves: price.reserves,
                lastUpdated: Date.now()
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting pool price for ${pool.address}:`, error.message);
            return null;
        }
    }

    async calculatePoolPrice(poolData, targetMintAddress, pool) {
        try {
            // Identify which token is our target and which is the quote
            const isTokenA = pool.tokenA === targetMintAddress;
            const targetReserve = isTokenA ? poolData.reserveA : poolData.reserveB;
            const quoteReserve = isTokenA ? poolData.reserveB : poolData.reserveA;
            const quoteMint = isTokenA ? pool.tokenB : pool.tokenA;

            // Get quote token info (decimals)
            const [targetDecimals, quoteDecimals] = await Promise.all([
                this.getTokenDecimals(targetMintAddress),
                this.getTokenDecimals(quoteMint)
            ]);

            // Adjust for decimals
            const adjustedTargetReserve = targetReserve / Math.pow(10, targetDecimals);
            const adjustedQuoteReserve = quoteReserve / Math.pow(10, quoteDecimals);

            // Calculate price (quote tokens per target token)
            let price = adjustedQuoteReserve / adjustedTargetReserve;

            // Convert to USD if quote token is not USD-based
            if (!this.isUSDToken(quoteMint)) {
                const quoteUsdPrice = await this.getUSDPrice(quoteMint);
                price = price * quoteUsdPrice;
            }

            // Calculate liquidity (total value in USD)
            const quoteLiquidityUsd = this.isUSDToken(quoteMint) ? 
                adjustedQuoteReserve : 
                adjustedQuoteReserve * (await this.getUSDPrice(quoteMint));
                
            const liquidity = quoteLiquidityUsd * 2; // Both sides of the pool

            return {
                price,
                liquidity,
                reserves: {
                    tokenA: adjustedTargetReserve,
                    tokenB: adjustedQuoteReserve,
                    tokenAMint: targetMintAddress,
                    tokenBMint: quoteMint
                }
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating pool price:`, error.message);
            throw error;
        }
    }

    // ========== MARKET CAP CALCULATION ==========

    async calculateMarketCap(mintAddress, priceUsd) {
        try {
            const mintInfo = await this.getMintInfo(mintAddress);
            const supply = parseFloat(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
            return supply * priceUsd;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating market cap:`, error.message);
            return 0;
        }
    }

    // ========== UTILITY FUNCTIONS ==========

    async getTokenDecimals(mintAddress) {
        try {
            const cacheKey = `decimals:${mintAddress}`;
            const cached = await this.redis.get(cacheKey);
            
            if (cached) {
                return parseInt(cached);
            }

            const mintInfo = await this.getMintInfo(mintAddress);
            const decimals = mintInfo.decimals;

            // Cache for longer since decimals don't change
            await this.redis.setex(cacheKey, 3600, decimals.toString());
            
            return decimals;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get decimals for ${mintAddress}, using default 9`);
            return 9;
        }
    }

    isUSDToken(mintAddress) {
        const usdTokens = [
            this.knownTokens.USDC,
            this.knownTokens.USDT
        ];
        return usdTokens.includes(mintAddress);
    }

    async getUSDPrice(mintAddress) {
        // For SOL, get SOL price
        if (mintAddress === this.knownTokens.SOL) {
            return await this.getSolPrice();
        }

        // For USD tokens, return 1
        if (this.isUSDToken(mintAddress)) {
            return 1;
        }

        // For other tokens, recursively get price
        try {
            const priceData = await this.getTokenPrice(mintAddress);
            return priceData.priceUsd || 0;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get USD price for ${mintAddress}`);
            return 0;
        }
    }

    async getSolPrice() {
        try {
            const cacheKey = 'sol_usd_price';
            const cached = await this.redis.get(cacheKey);
            
            if (cached) {
                return parseFloat(cached);
            }

            // Get SOL price from a SOL/USDC pool
            const solPriceData = await this.getTokenPrice(this.knownTokens.SOL);
            const solPrice = solPriceData.priceUsd || 150; // Fallback

            await this.redis.setex(cacheKey, 30, solPrice.toString());
            return solPrice;

        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Could not get SOL price, using fallback 150`);
            return 150;
        }
    }

    // ========== PARSING FUNCTIONS ==========

    parseMetadataAccount(data) {
        try {
            // Simplified metadata parsing
            // This is a basic implementation - you might want to use a proper metadata parser
            const decoder = new TextDecoder();
            const dataString = decoder.decode(data.slice(1, 300)); // Skip first byte, take reasonable chunk
            
            // Extract name and symbol using regex patterns
            const nameMatch = dataString.match(/([A-Za-z0-9\s]{1,32})/);
            const symbolMatch = dataString.match(/([A-Za-z0-9]{1,10})/);
            
            return {
                name: nameMatch ? nameMatch[1].trim() : 'Unknown Token',
                symbol: symbolMatch ? symbolMatch[1].trim() : 'UNK',
                image: null, // Would need to parse URI and fetch from IPFS/Arweave
                uri: null
            };

        } catch (error) {
            return {
                name: 'Unknown Token',
                symbol: 'UNK',
                image: null,
                uri: null
            };
        }
    }

    async parsePoolAccount(account, dexName, targetMint) {
        try {
            // This is a simplified parser - each DEX has its own data structure
            // You would need specific parsers for each DEX program
            
            const data = account.account.data;
            
            if (dexName.includes('RAYDIUM')) {
                return this.parseRaydiumPool(data, targetMint);
            } else if (dexName.includes('ORCA')) {
                return this.parseOrcaPool(data, targetMint);
            } else if (dexName.includes('PUMP')) {
                return this.parsePumpFunPool(data, targetMint);
            }
            
            return null;
            
        } catch (error) {
            return null;
        }
    }

    parseRaydiumPool(data, targetMint) {
        try {
            // Simplified Raydium pool parsing
            // Raydium V4 pools have a specific layout
            const tokenAMint = new PublicKey(data.slice(64, 96)).toString();
            const tokenBMint = new PublicKey(data.slice(96, 128)).toString();
            
            if (tokenAMint === targetMint.toString() || tokenBMint === targetMint.toString()) {
                return {
                    tokenA: tokenAMint,
                    tokenB: tokenBMint,
                    type: 'amm'
                };
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    parseOrcaPool(data, targetMint) {
        try {
            // Simplified Orca pool parsing
            // This is a placeholder - implement based on Orca's pool structure
            return null;
        } catch (error) {
            return null;
        }
    }

    parsePumpFunPool(data, targetMint) {
        try {
            // Simplified PumpFun parsing
            // This is a placeholder - implement based on PumpFun's structure
            return null;
        } catch (error) {
            return null;
        }
    }

    async parsePoolData(data, dexType) {
        try {
            // Parse pool reserves based on DEX type
            // This is simplified - each DEX has different data layouts
            
            if (dexType.includes('RAYDIUM')) {
                // Raydium pool data parsing
                const reserveA = data.readBigUInt64LE(128); // Approximate offsets
                const reserveB = data.readBigUInt64LE(136);
                
                return {
                    reserveA: Number(reserveA),
                    reserveB: Number(reserveB),
                    type: 'raydium'
                };
            }
            
            // Add other DEX parsers here
            
            return null;
            
        } catch (error) {
            throw new Error(`Failed to parse pool data: ${error.message}`);
        }
    }

    // ========== BATCH OPERATIONS ==========

    async getTokenPrices(mintAddresses) {
        const results = new Map();
        const batchSize = 10;
        
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

            // Small delay between batches to avoid overwhelming the RPC
            if (i + batchSize < mintAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return results;
    }

    // ========== SERVICE MANAGEMENT ==========

    getStats() {
        return {
            rpcEndpoint: this.connection.rpcEndpoint,
            supportedDEXs: Object.keys(this.dexPrograms),
            cacheSettings: {
                priceTTL: this.PRICE_CACHE_TTL,
                tokenInfoTTL: this.TOKEN_INFO_CACHE_TTL,
                poolTTL: this.POOL_CACHE_TTL
            },
            knownTokens: Object.keys(this.knownTokens).length
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Enhanced Token Service closed`);
    }
}

module.exports = EnhancedTokenService;