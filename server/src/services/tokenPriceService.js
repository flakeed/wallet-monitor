// server/src/services/tokenPriceService.js
const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');

class TokenPriceService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: process.env.SOLANA_WS_URL
        });

        // Redis client for regular operations
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        
        // Redis client for Pub/Sub
        this.redisPubSub = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');

        this.redis.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ TokenPriceService connected to Redis (regular)`);
        });

        this.redis.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ TokenPriceService Redis error (regular):`, err.message);
        });

        this.redisPubSub.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ TokenPriceService connected to Redis (Pub/Sub)`);
        });

        this.redisPubSub.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ TokenPriceService Redis error (Pub/Sub):`, err.message);
        });

        this.priceCache = new Map();
        this.CACHE_TTL = 30; // 30 seconds cache for prices
        this.JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
        this.SOL_MINT = 'So11111111111111111111111111111111111111112';

        // Start periodic price updates
        this.startPriceUpdater();
    }

    async startPriceUpdater() {
        setInterval(async () => {
            try {
                const activeTokens = await this.getActiveTokens();
                if (activeTokens.length > 0) {
                    console.log(`[${new Date().toISOString()}] 📊 Updating prices for ${activeTokens.length} active tokens`);
                    const prices = await this.batchUpdatePrices(activeTokens);
                    // Publish price updates to Pub/Sub
                    await this.redisPubSub.publish('price_updates', JSON.stringify({
                        timestamp: Date.now(),
                        prices: Object.fromEntries(prices)
                    }));
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error updating prices:`, error.message);
            }
        }, 10000);
    }

    async getActiveTokens() {
        try {
            const keys = await this.redis.keys('active_token:*');
            return keys.map(key => key.replace('active_token:', ''));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting active tokens:`, error.message);
            return [];
        }
    }

    async markTokenActive(tokenMint) {
        try {
            await this.redis.set(`active_token:${tokenMint}`, '1', 'EX', 300);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error marking token active:`, error.message);
        }
    }

    async getTokenPrice(tokenMint) {
        try {
            const cached = await this.redis.get(`price:${tokenMint}`);
            if (cached) {
                return JSON.parse(cached);
            }

            const priceData = await this.fetchJupiterPrice(tokenMint);
            if (priceData) {
                await this.redis.set(`price:${tokenMint}`, JSON.stringify(priceData), 'EX', this.CACHE_TTL);
                return priceData;
            }

            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${tokenMint}:`, error.message);
            return null;
        }
    }

    async fetchJupiterPrice(tokenMint, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`[${new Date().toISOString()}] 🔍 Fetching price from Jupiter for ${tokenMint} (attempt ${attempt})`);
            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=${tokenMint},${this.SOL_MINT}`);
            if (!response.ok) {
                console.log(`[${new Date().toISOString()}] ❌ Jupiter API returned ${response.status}`);
                if (attempt === retries) return null;
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data.data && data.data[tokenMint]) {
                const tokenPrice = data.data[tokenMint].price;
                const solPrice = data.data[this.SOL_MINT]?.price || 150;

                const priceData = {
                    priceInSOL: tokenPrice / solPrice,
                    priceInUSD: tokenPrice,
                    source: 'jupiter',
                    timestamp: Date.now()
                };

                console.log(`[${new Date().toISOString()}] ✅ Got price for ${tokenMint}: ${priceData.priceInSOL} SOL`);
                return priceData;
            }

            console.log(`[${new Date().toISOString()}] ⚠️ No price data from Jupiter for ${tokenMint}`);
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Jupiter API error (attempt ${attempt}):`, error.message);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            return null;
        }
    }
}

    async getSOLPrice() {
        try {
            const cached = await this.redis.get('price:SOL');
            if (cached) {
                return parseFloat(cached);
            }

            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=${this.SOL_MINT}`);
            const data = await response.json();
            const solPrice = data.data[this.SOL_MINT]?.price || 150;

            await this.redis.set('price:SOL', solPrice.toString(), 'EX', 60);
            return solPrice;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
            return 150; // Fallback price
        }
    }

    async batchUpdatePrices(tokenMints) {
        const prices = new Map();
        const batchSize = 100;
        for (let i = 0; i < tokenMints.length; i += batchSize) {
            const batch = tokenMints.slice(i, i + batchSize);
            const mintString = batch.join(',');

            try {
                const response = await fetch(`${this.JUPITER_PRICE_API}?ids=${mintString},${this.SOL_MINT}`);
                if (response.ok) {
                    const data = await response.json();
                    const solPrice = data.data[this.SOL_MINT]?.price || 150;

                    batch.forEach(mint => {
                        if (data.data[mint]) {
                            const tokenPrice = data.data[mint].price;
                            const priceData = {
                                priceInSOL: tokenPrice / solPrice,
                                priceInUSD: tokenPrice,
                                source: 'jupiter',
                                timestamp: Date.now()
                            };
                            prices.set(mint, priceData);
                            // Cache price in Redis
                            this.redis.set(`price:${mint}`, JSON.stringify(priceData), 'EX', this.CACHE_TTL);
                        }
                    });
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Batch price update error:`, error.message);
            }
        }

        return prices;
    }

    async getTokenBalance(walletAddress, tokenMint) {
        try {
            console.log(`[${new Date().toISOString()}] 🔍 Getting balance for wallet ${walletAddress} token ${tokenMint}`);
            const walletPubkey = new PublicKey(walletAddress);
            const mintPubkey = new PublicKey(tokenMint);

            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPubkey,
                { mint: mintPubkey }
            );

            if (tokenAccounts.value.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ No token accounts found`);
                return 0;
            }

            let totalBalance = 0;
            for (const account of tokenAccounts.value) {
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
                totalBalance += balance || 0;
            }

            console.log(`[${new Date().toISOString()}] ✅ Balance: ${totalBalance}`);
            return totalBalance;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token balance:`, error.message);
            return 0;
        }
    }

    async calculateUnrealizedPnL(walletAddress, tokenMint, spent, received) {
        try {
            const currentBalance = await this.getTokenBalance(walletAddress, tokenMint);
            const priceData = await this.getTokenPrice(tokenMint);
            if (!priceData) {
                console.log(`[${new Date().toISOString()}] ⚠️ No price data for ${tokenMint}, using 0`);
                return {
                    currentBalance,
                    currentValueSOL: 0,
                    unrealizedPnL: spent > received ? -(spent - received) : 0,
                    percentChange: -100,
                    pricePerToken: 0
                };
            }

            const currentValueSOL = currentBalance * priceData.priceInSOL;
            const netSpent = spent - received;
            const unrealizedPnL = currentValueSOL - netSpent;
            const percentChange = netSpent > 0 ? ((unrealizedPnL / netSpent) * 100) : 0;

            console.log(`[${new Date().toISOString()}] 💰 PnL for ${walletAddress}: balance=${currentBalance}, value=${currentValueSOL}, unrealized=${unrealizedPnL}`);

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
            console.error(`[${new Date().toISOString()}] ❌ Error calculating unrealized PnL:`, error.message);
            return {
                currentBalance: 0,
                currentValueSOL: 0,
                unrealizedPnL: -(spent - received),
                percentChange: -100,
                pricePerToken: 0
            };
        }
    }

    async enrichTokenDataWithPnL(tokenData) {
        try {
            console.log(`[${new Date().toISOString()}] 🎯 Enriching token ${tokenData.symbol} (${tokenData.mint})`);
            const enrichedData = { ...tokenData };
            await this.markTokenActive(tokenData.mint);
            const priceData = await this.getTokenPrice(tokenData.mint);
            enrichedData.currentPrice = priceData;

            const enrichmentPromises = tokenData.wallets.map(async (wallet) => {
                try {
                    const pnlData = await this.calculateUnrealizedPnL(
                        wallet.address,
                        tokenData.mint,
                        wallet.solSpent,
                        wallet.solReceived
                    );

                    return {
                        ...wallet,
                        currentBalance: pnlData.currentBalance,
                        remainingTokens: pnlData.currentBalance,
                        currentValueSOL: pnlData.currentValueSOL,
                        unrealizedPnL: pnlData.unrealizedPnL,
                        totalPnL: wallet.pnlSol + pnlData.unrealizedPnL,
                        percentChange: pnlData.percentChange
                    };
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error enriching wallet ${wallet.address}:`, error.message);
                    return {
                        ...wallet,
                        currentBalance: 0,
                        remainingTokens: 0,
                        currentValueSOL: 0,
                        unrealizedPnL: 0,
                        totalPnL: wallet.pnlSol,
                        percentChange: 0
                    };
                }
            });

            enrichedData.wallets = await Promise.all(enrichmentPromises);

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

            console.log(`[${new Date().toISOString()}] ✅ Enriched ${tokenData.symbol}: totalPnL=${enrichedData.summary.totalPnL}, unrealized=${totalUnrealizedPnL}`);
            return enrichedData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error enriching token data:`, error.message);
            return tokenData;
        }
    }

    async shutdown() {
        await this.redis.quit();
        await this.redisPubSub.quit();
    }
}

module.exports = TokenPriceService;