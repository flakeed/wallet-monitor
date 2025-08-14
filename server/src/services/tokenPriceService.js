const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const fetch = require('node-fetch');
const { fetchTokenMetadata } = require('./tokenService');

class TokenPriceService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: process.env.SOLANA_WS_URL
        });

        // Redis configuration with enhanced retry and connection pooling
        this.redis = new Redis({
            host: 'switchback.proxy.rlwy.net',
            port: 25212,
            password: 'CwBXeFAGuARpNfwwziJyFttVApFFFyGD',
            maxRetriesPerRequest: 10,
            retryStrategy: (times) => {
                if (times > 10) {
                    console.error(`[${new Date().toISOString()}] 🛑 Redis max retries exceeded`);
                    return null;
                }
                return Math.min(times * 1000, 5000);
            },
            reconnectOnError: (err) => {
                console.error(`[${new Date().toISOString()}] ❌ Redis reconnect error: ${err.message}`);
                return true;
            },
            lazyConnect: true
        });

        this.redisPubSub = new Redis({
            host: 'switchback.proxy.rlwy.net',
            port: 25212,
            password: 'CwBXeFAGuARpNfwwziJyFttVApFFFyGD',
            maxRetriesPerRequest: 10,
            retryStrategy: (times) => {
                if (times > 10) {
                    console.error(`[${new Date().toISOString()}] 🛑 Redis Pub/Sub max retries exceeded`);
                    return null;
                }
                return Math.min(times * 1000, 5000);
            },
            reconnectOnError: (err) => {
                console.error(`[${new Date().toISOString()}] ❌ Redis Pub/Sub reconnect error: ${err.message}`);
                return true;
            },
            lazyConnect: true
        });

        this.redis.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ Redis connected`);
        });
        this.redis.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Redis error: ${err.message}`);
        });
        this.redisPubSub.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ Redis Pub/Sub connected`);
        });
        this.redisPubSub.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Redis Pub/Sub error: ${err.message}`);
        });

        this.priceCache = new Map();
        this.activeTokensCache = new Set();
        this.CACHE_TTL = 30; // 30 seconds cache for prices
        this.DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';

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

            // Fetch price from DexScreener
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

            // Return null if no price is found
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${tokenMint}: ${error.message}`);
            return null;
        }
    }

    async fetchDexScreenerPrice(tokenMint, maxRetries = 3, retryDelay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.DEXSCREENER_API}/${tokenMint}`, {
                    timeout: 5000,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'wallet-monitor-backend/1.0'
                    }
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
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
                    priceInSOL: parseFloat(bestPair.priceNative),
                    priceInUSD: parseFloat(bestPair.priceUsd),
                    source: 'dexscreener',
                    timestamp: Date.now()
                };
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ DexScreener API attempt ${attempt}/${maxRetries} failed for ${tokenMint}: ${error.message}`);
                if (attempt === maxRetries) {
                    console.error(`[${new Date().toISOString()}] 🛑 Max retries reached for DexScreener API`);
                    return null;
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
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

            // Fetch SOL price from DexScreener
            const response = await fetch(`${this.DEXSCREENER_API}/So11111111111111111111111111111111111111112`, {
                timeout: 5000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'wallet-monitor-backend/1.0'
                }
            });
            const data = await response.json();
            const solPrice = data.pairs && data.pairs[0]?.priceUsd ? parseFloat(data.pairs[0].priceUsd) : 150;

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
        const batchSize = 50; // Reduced batch size to avoid rate limits
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
            // Add delay between batches to respect rate limits
            if (i + batchSize < tokenMints.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
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
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount || 0;
                totalBalance += balance;
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
            enrichedData.currentPrice = await this.getTokenPrice(tokenData.mint);
            
            enrichedData.wallets = await Promise.all(
                tokenData.wallets.map(async (wallet) => {
                    try {
                        const pnlData = await this.calculateUnrealizedPnL(
                            wallet.address,
                            tokenData.mint,
                            wallet.solSpent,
                            wallet.tokensBought
                        );
                        
                        return {
                            ...wallet,
                            currentBalance: +pnlData.currentBalance.toFixed(6),
                            currentValueSOL: +pnlData.currentValueSOL.toFixed(6),
                            unrealizedPnL: +pnlData.unrealizedPnL.toFixed(6),
                            totalPnL: +(wallet.realizedPnL + pnlData.unrealizedPnL).toFixed(6),
                            percentChange: +pnlData.percentChange.toFixed(2),
                            remainingTokens: +pnlData.currentBalance.toFixed(6)
                        };
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error calculating PnL for wallet ${wallet.address}, token ${tokenData.mint}: ${error.message}`);
                        return {
                            ...wallet,
                            currentBalance: 0,
                            currentValueSOL: 0,
                            unrealizedPnL: -wallet.solSpent,
                            totalPnL: wallet.realizedPnL - wallet.solSpent,
                            percentChange: -100,
                            remainingTokens: 0
                        };
                    }
                })
            );
            
            enrichedData.summary = {
                ...enrichedData.summary,
                totalUnrealizedPnL: +enrichedData.wallets.reduce(
                    (sum, w) => sum + (w.unrealizedPnL || 0), 0
                ).toFixed(6),
                totalPnL: +(
                    enrichedData.summary.totalRealizedPnL + 
                    enrichedData.wallets.reduce((sum, w) => sum + (w.unrealizedPnL || 0), 0)
                ).toFixed(6),
                totalCurrentValueSOL: +enrichedData.wallets.reduce(
                    (sum, w) => sum + (w.currentValueSOL || 0), 0
                ).toFixed(6),
                totalRemainingTokens: +enrichedData.wallets.reduce(
                    (sum, w) => sum + (w.remainingTokens || 0), 0
                ).toFixed(6),
                avgEntryPrice: enrichedData.summary.totalSpentSOL / 
                    (enrichedData.summary.totalBuys > 0 ? enrichedData.summary.totalBuys : 1)
            };
            
            return enrichedData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error enriching token ${tokenData.mint}: ${error.message}`);
            return enrichedData;
        }
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