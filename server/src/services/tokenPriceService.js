const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const { fetchTokenMetadata } = require('./tokenService');

class TokenPriceService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: process.env.SOLANA_WS_URL
        });

        // Configure Redis with retry strategy
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212', {
            maxRetriesPerRequest: 5,
            retryStrategy: (times) => Math.min(times * 500, 2000), // Retry every 0.5s, up to 2s
            reconnectOnError: (err) => {
                console.error(`[${new Date().toISOString()}] ❌ Redis connection error: ${err.message}`);
                return true; // Attempt to reconnect
            }
        });

        this.redisPubSub = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212', {
            maxRetriesPerRequest: 5,
            retryStrategy: (times) => Math.min(times * 500, 2000),
            reconnectOnError: (err) => {
                console.error(`[${new Date().toISOString()}] ❌ Redis Pub/Sub connection error: ${err.message}`);
                return true;
            }
        });

        // In-memory fallback cache
        this.priceCache = new Map();
        this.activeTokensCache = new Set();
        this.CACHE_TTL = 30; // 30 seconds cache for prices
        this.RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        this.JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
        this.DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

        // Handle Redis errors
        this.redis.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Redis error: ${err.message}`);
        });
        this.redisPubSub.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Redis Pub/Sub error: ${err.message}`);
        });

        // Log successful Redis connection
        this.redis.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Redis`);
        });
        this.redisPubSub.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Redis Pub/Sub`);
        });

        // Start periodic price updates
        this.startPriceUpdater();
    }

    async startPriceUpdater() {
        setInterval(async () => {
            try {
                const activeTokens = await this.getActiveTokens();
                if (activeTokens.length > 0) {
                    await this.batchUpdatePrices(activeTokens);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error updating prices: ${error.message}`);
            }
        }, 10000);
    }

    async getActiveTokens() {
        try {
            const keys = await this.redis.keys('active_token:*');
            const tokens = keys.map(key => key.replace('active_token:', ''));
            return tokens.length > 0 ? tokens : Array.from(this.activeTokensCache);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to get active tokens from Redis, using in-memory cache: ${error.message}`);
            return Array.from(this.activeTokensCache);
        }
    }

    async markTokenActive(tokenMint) {
        try {
            await this.redis.set(`active_token:${tokenMint}`, '1', 'EX', 300);
            this.activeTokensCache.add(tokenMint);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to mark token ${tokenMint} as active in Redis, using in-memory cache: ${error.message}`);
            this.activeTokensCache.add(tokenMint);
        }
    }

    async getTokenPrice(tokenMint) {
        try {
            // Check cache (Redis first, then in-memory)
            let cached;
            try {
                cached = await this.redis.get(`price:${tokenMint}`);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Redis cache read error for ${tokenMint}: ${error.message}`);
                cached = this.priceCache.get(`price:${tokenMint}`);
            }
            if (cached) {
                return typeof cached === 'string' ? JSON.parse(cached) : cached;
            }

            // Try Jupiter API first
            const jupiterPrice = await this.fetchJupiterPrice(tokenMint);
            if (jupiterPrice) {
                try {
                    await this.redis.set(`price:${tokenMint}`, JSON.stringify(jupiterPrice), 'EX', this.CACHE_TTL);
                    await this.redisPubSub.publish('price_updates', JSON.stringify({ [tokenMint]: jupiterPrice }));
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Redis cache write error for ${tokenMint}: ${error.message}`);
                    this.priceCache.set(`price:${tokenMint}`, jupiterPrice);
                }
                return jupiterPrice;
            }

            // Try DexScreener as a fallback
            const dexScreenerPrice = await this.fetchDexScreenerPrice(tokenMint);
            if (dexScreenerPrice) {
                try {
                    await this.redis.set(`price:${tokenMint}`, JSON.stringify(dexScreenerPrice), 'EX', this.CACHE_TTL);
                    await this.redisPubSub.publish('price_updates', JSON.stringify({ [tokenMint]: dexScreenerPrice }));
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Redis cache write error for ${tokenMint}: ${error.message}`);
                    this.priceCache.set(`price:${tokenMint}`, dexScreenerPrice);
                }
                return dexScreenerPrice;
            }

            // Fall back to Raydium pools
            const raydiumPrice = await this.fetchRaydiumPrice(tokenMint);
            if (raydiumPrice) {
                try {
                    await this.redis.set(`price:${tokenMint}`, JSON.stringify(raydiumPrice), 'EX', this.CACHE_TTL);
                    await this.redisPubSub.publish('price_updates', JSON.stringify({ [tokenMint]: raydiumPrice }));
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Redis cache write error for ${tokenMint}: ${error.message}`);
                    this.priceCache.set(`price:${tokenMint}`, raydiumPrice);
                }
                return raydiumPrice;
            }

            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${tokenMint}: ${error.message}`);
            return null;
        }
    }

    async fetchJupiterPrice(tokenMint) {
        try {
            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=${tokenMint}`);
            if (!response.ok) return null;
            
            const data = await response.json();
            if (data.data && data.data[tokenMint]) {
                const price = data.data[tokenMint].price;
                return {
                    priceInSOL: price / data.data['So11111111111111111111111111111111111111112']?.price || 0,
                    priceInUSD: price,
                    source: 'jupiter',
                    timestamp: Date.now()
                };
            }
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Jupiter API error: ${error.message}`);
            return null;
        }
    }

    async fetchDexScreenerPrice(tokenMint) {
        try {
            const response = await fetch(`${this.DEXSCREENER_API}/${tokenMint}`);
            if (!response.ok) {
                console.error(`[${new Date().toISOString()}] ❌ DexScreener API returned ${response.status}`);
                return null;
            }

            const data = await response.json();
            if (!data.pairs || data.pairs.length === 0) {
                console.log(`[${new Date().toISOString()}] 🔍 No pairs found for ${tokenMint} on DexScreener`);
                return null;
            }

            // Find the most liquid pair (highest liquidity in USD)
            const bestPair = data.pairs.reduce((best, pair) => {
                const liquidity = Number(pair.liquidity?.usd || 0);
                return liquidity > (best.liquidity?.usd || 0) ? pair : best;
            }, data.pairs[0]);

            if (!bestPair.priceUsd || !bestPair.priceNative) {
                console.log(`[${new Date().toISOString()}] 🔍 No valid price data in DexScreener response for ${tokenMint}`);
                return null;
            }

            return {
                priceInSOL: parseFloat(bestPair.priceNative), // Price in SOL
                priceInUSD: parseFloat(bestPair.priceUsd),
                source: 'dexscreener',
                timestamp: Date.now()
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ DexScreener API error for ${tokenMint}: ${error.message}`);
            return null;
        }
    }

    async fetchRaydiumPrice(tokenMint) {
        try {
            const filters = [
                { dataSize: 752 },
                { memcmp: { offset: 400, bytes: tokenMint } }
            ];
            
            const poolAccounts = await this.connection.getProgramAccounts(
                this.RAYDIUM_V4,
                { filters }
            );

            if (poolAccounts.length === 0) {
                const altFilters = [
                    { dataSize: 752 },
                    { memcmp: { offset: 432, bytes: tokenMint } }
                ];
                const altPools = await this.connection.getProgramAccounts(
                    this.RAYDIUM_V4,
                    { filters: altFilters }
                );
                if (altPools.length > 0) {
                    poolAccounts.push(...altPools);
                }
            }

            if (poolAccounts.length === 0) return null;

            const poolData = poolAccounts[0].account.data;
            const baseVault = new PublicKey(poolData.slice(64, 96));
            const quoteVault = new PublicKey(poolData.slice(96, 128));
            
            const [baseBalance, quoteBalance] = await Promise.all([
                this.connection.getTokenAccountBalance(baseVault),
                this.connection.getTokenAccountBalance(quoteVault)
            ]);

            const baseAmount = parseFloat(baseBalance.value.uiAmount || 0);
            const quoteAmount = parseFloat(quoteBalance.value.uiAmount || 0);

            if (baseAmount === 0) return null;

            const priceInSOL = quoteAmount / baseAmount;

            return {
                priceInSOL,
                priceInUSD: priceInSOL * (await this.getSOLPrice()),
                source: 'raydium',
                timestamp: Date.now()
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Raydium price fetch error: ${error.message}`);
            return null;
        }
    }

    async getSOLPrice() {
        try {
            let cached;
            try {
                cached = await this.redis.get('price:SOL');
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Redis cache read error for SOL price: ${error.message}`);
                cached = this.priceCache.get('price:SOL');
            }
            if (cached) {
                return typeof cached === 'string' ? parseFloat(cached) : cached;
            }

            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=So11111111111111111111111111111111111111112`);
            const data = await response.json();
            const solPrice = data.data['So11111111111111111111111111111111111111112']?.price || 150;
            
            try {
                await this.redis.set('price:SOL', solPrice.toString(), 'EX', 60);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Redis cache write error for SOL price: ${error.message}`);
                this.priceCache.set('price:SOL', solPrice);
            }
            return solPrice;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price: ${error.message}`);
            return 150; // Fallback price
        }
    }

    async batchUpdatePrices(tokenMints) {
        const prices = new Map();
        const batchSize = 100;
        for (let i = 0; i < tokenMints.length; i += batchSize) {
            const batch = tokenMints.slice(i, i + batchSize);
            const batchPrices = await Promise.all(
                batch.map(mint => this.getTokenPrice(mint))
            );
            
            batch.forEach((mint, index) => {
                if (batchPrices[index]) {
                    prices.set(mint, batchPrices[index]);
                }
            });
        }
        
        return prices;
    }

    async getTokenBalance(walletAddress, tokenMint) {
        try {
            const walletPubkey = new PublicKey(walletAddress);
            const mintPubkey = new PublicKey(tokenMint);
            
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPubkey,
                { mint: mintPubkey }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            let totalBalance = 0;
            for (const account of tokenAccounts.value) {
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
                totalBalance += balance || 0;
            }

            return totalBalance;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token balance: ${error.message}`);
            return 0;
        }
    }

    async calculateUnrealizedPnL(walletAddress, tokenMint, spent, bought) {
        try {
            const currentBalance = await this.getTokenBalance(walletAddress, tokenMint);
            const priceData = await this.getTokenPrice(tokenMint);
            if (!priceData) {
                return {
                    currentBalance,
                    currentValueSOL: 0,
                    unrealizedPnL: -spent,
                    percentChange: -100,
                    pricePerToken: 0
                };
            }

            const currentValueSOL = currentBalance * priceData.priceInSOL;
            const unrealizedPnL = currentValueSOL - spent;
            const percentChange = spent > 0 ? ((unrealizedPnL / spent) * 100) : 0;

            return {
                currentBalance,
                currentValueSOL,
                unrealizedPnL,
                percentChange,
                pricePerToken: priceData.priceInSOL,
                priceSource: priceData.source,
                priceTimestamp: priceData.timestamp
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating unrealized PnL for ${tokenMint}: ${error.message}`);
            return {
                currentBalance: 0,
                currentValueSOL: 0,
                unrealizedPnL: -spent,
                percentChange: -100,
                pricePerToken: 0
            };
        }
    }

    async enrichTokenDataWithPnL(tokenData) {
        const enrichedData = { ...tokenData };
        
        try {
            await this.markTokenActive(tokenData.mint);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error marking token ${tokenData.mint} active: ${error.message}`);
        }
        
        enrichedData.currentPrice = await this.getTokenPrice(tokenData.mint);
        
        enrichedData.wallets = await Promise.all(
            tokenData.wallets.map(async (wallet) => {
                const pnlData = await this.calculateUnrealizedPnL(
                    wallet.address,
                    tokenData.mint,
                    wallet.solSpent,
                    wallet.tokensBought
                );
                
                return {
                    ...wallet,
                    currentBalance: pnlData.currentBalance,
                    currentValueSOL: pnlData.currentValueSOL,
                    unrealizedPnL: pnlData.unrealizedPnL,
                    totalPnL: wallet.pnlSol + pnlData.unrealizedPnL,
                    percentChange: pnlData.percentChange,
                    remainingTokens: pnlData.currentBalance
                };
            })
        );
        
        const totalUnrealizedPnL = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.unrealizedPnL || 0), 0
        );
        const totalCurrentValue = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.currentValueSOL || 0), 0
        );
        const totalRemainingTokens = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.remainingTokens || 0), 0
        );
        
        enrichedData.summary = {
            ...enrichedData.summary,
            totalUnrealizedPnL,
            totalPnL: enrichedData.summary.netSOL + totalUnrealizedPnL,
            totalCurrentValueSOL: totalCurrentValue,
            totalRemainingTokens,
            avgEntryPrice: enrichedData.summary.totalSpentSOL / 
                (enrichedData.summary.totalBuys > 0 ? enrichedData.summary.totalBuys : 1)
        };
        
        return enrichedData;
    }

    async shutdown() {
        try {
            await this.redis.quit();
            await this.redisPubSub.quit();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error shutting down Redis connections: ${error.message}`);
        }
    }
}

module.exports = TokenPriceService;