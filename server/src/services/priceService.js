const Redis = require('ioredis');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getMint, MintLayout } = require('@solana/spl-token');

class PriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111', {
            commitment: 'confirmed',
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0,
            cacheTimeout: 30000 // 30 seconds
        };
        this.tokenPriceCache = new Map();
        this.maxCacheSize = 1000;
        this.startBackgroundUpdates();
    }

    startBackgroundUpdates() {
        setInterval(async () => {
            try {
                await this.updateSolPriceInBackground();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
            }
        }, 30000);

        setInterval(() => {
            this.cleanTokenPriceCache();
        }, 300000);
    }

    async updateSolPriceInBackground() {
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const newPrice = parseFloat(bestPair.priceUsd || 150);
                this.solPriceCache = {
                    price: newPrice,
                    lastUpdated: Date.now(),
                    cacheTimeout: 30000
                };
                await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
                console.log(`[${new Date().toISOString()}] ✅ Updated SOL price in background: $${newPrice}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to update SOL price in background:`, error.message);
        }
    }

    async getSolPrice() {
        const now = Date.now();
        if (now - this.solPriceCache.lastUpdated < this.solPriceCache.cacheTimeout) {
            return {
                success: true,
                price: this.solPriceCache.price,
                source: 'cache',
                lastUpdated: this.solPriceCache.lastUpdated
            };
        }
        try {
            const redisPrice = await this.redis.get('sol_price');
            if (redisPrice) {
                const cached = JSON.parse(redisPrice);
                if (now - cached.lastUpdated < cached.cacheTimeout) {
                    this.solPriceCache = cached;
                    return {
                        success: true,
                        price: cached.price,
                        source: 'redis',
                        lastUpdated: cached.lastUpdated
                    };
                }
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Redis price fetch failed:`, error.message);
        }
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const newPrice = parseFloat(bestPair.priceUsd || 150);
                this.solPriceCache = {
                    price: newPrice,
                    lastUpdated: now,
                    cacheTimeout: 30000
                };
                await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
                return {
                    success: true,
                    price: newPrice,
                    source: 'fresh',
                    lastUpdated: now
                };
            }
            throw new Error('No price data found');
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching fresh SOL price:`, error.message);
            return {
                success: true,
                price: this.solPriceCache.price,
                source: 'fallback',
                lastUpdated: this.solPriceCache.lastUpdated,
                error: error.message
            };
        }
    }

    async getTokenPriceFromPool(mint) {
        // Пример: предположим, что мы используем Raydium для получения цены
        // Замените на реальный адрес пула ликвидности и программу (например, Raydium program ID)
        const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'); // Raydium program
        const mintPubkey = new PublicKey(mint);

        try {
            // Получаем все аккаунты, связанные с программой Raydium и данным токеном
            const accounts = await this.connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
                filters: [
                    { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } } // Фильтр по mint
                ]
            });

            if (!accounts || accounts.length === 0) {
                throw new Error('No liquidity pool found for this token');
            }

            // Предполагаем, что первый аккаунт — это пул ликвидности
            const poolAccount = accounts[0];
            const poolData = poolAccount.account.data; // Декодируйте данные пула (зависит от структуры пула)

            // Здесь нужно декодировать данные пула (например, запасы токена и SOL)
            // Это пример, нужно адаптировать под конкретную структуру данных Raydium
            // Для простоты предположим, что poolData содержит tokenAmount и solAmount
            const tokenAmount = 1000000; // Пример: нужно извлечь из poolData
            const solAmount = 100; // Пример: нужно извлечь из poolData

            const solPrice = (await this.getSolPrice()).price;
            const tokenPrice = (solAmount / tokenAmount) * solPrice;

            return {
                price: tokenPrice,
                liquidity: solAmount * solPrice, // Пример ликвидности
                source: 'rpc'
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching token price for ${mint}:`, error.message);
            return { price: 0, liquidity: 0, source: 'error', error: error.message };
        }
    }

    async getTokenMarketCap(mint) {
        try {
            const mintPubkey = new PublicKey(mint);
            const mintInfo = await getMint(this.connection, mintPubkey);
            const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
            const priceData = await this.getTokenPriceFromPool(mint);
            const marketCap = totalSupply * priceData.price;
            return marketCap;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating market cap for ${mint}:`, error.message);
            return 0;
        }
    }

    async getTokenDeployTime(mint) {
        try {
            const mintPubkey = new PublicKey(mint);
            const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 });
            if (signatures.length === 0) {
                throw new Error('No transactions found for token mint');
            }
            const blockTime = signatures[0].blockTime * 1000; // Время в миллисекундах
            const now = Date.now();
            const timeSinceDeploy = now - blockTime;
            return {
                deployTime: new Date(blockTime).toISOString(),
                timeSinceDeployMs: timeSinceDeploy
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching deploy time for ${mint}:`, error.message);
            return { deployTime: null, timeSinceDeployMs: 0, error: error.message };
        }
    }

    async getTokenPrices(tokenMints) {
        if (!tokenMints || tokenMints.length === 0) {
            return new Map();
        }

        const results = new Map();
        const uncachedMints = [];
        const now = Date.now();

        for (const mint of tokenMints) {
            const cached = this.tokenPriceCache.get(mint);
            if (cached && (now - cached.timestamp) < 60000) {
                results.set(mint, cached.data);
            } else {
                uncachedMints.push(mint);
            }
        }

        if (uncachedMints.length > 0) {
            const BATCH_SIZE = 10;
            for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
                const batch = uncachedMints.slice(i, i + BATCH_SIZE);
                const batchPromises = batch.map(async (mint) => {
                    try {
                        const priceData = await this.getTokenPriceFromPool(mint);
                        const marketCap = await this.getTokenMarketCap(mint);
                        const deployInfo = await this.getTokenDeployTime(mint);
                        const data = {
                            price: priceData.price,
                            liquidity: priceData.liquidity,
                            marketCap: marketCap,
                            deployTime: deployInfo.deployTime,
                            timeSinceDeployMs: deployInfo.timeSinceDeployMs
                        };
                        this.tokenPriceCache.set(mint, { data, timestamp: now });
                        return { mint, data };
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error processing ${mint}:`, error.message);
                        return { mint, data: null };
                    }
                });

                const batchResults = await Promise.all(batchPromises);
                batchResults.forEach(({ mint, data }) => {
                    results.set(mint, data);
                });

                if (i + BATCH_SIZE < uncachedMints.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }

        return results;
    }

    cleanTokenPriceCache() {
        if (this.tokenPriceCache.size <= this.maxCacheSize) return;

        const now = Date.now();
        const entries = Array.from(this.tokenPriceCache.entries());
        const validEntries = entries.filter(([, value]) => 
            (now - value.timestamp) < 300000
        );

        if (validEntries.length > this.maxCacheSize) {
            validEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            validEntries.length = this.maxCacheSize;
        }

        this.tokenPriceCache.clear();
        validEntries.forEach(([key, value]) => {
            this.tokenPriceCache.set(key, value);
        });

        console.log(`[${new Date().toISOString()}] 🧹 Cleaned token price cache: ${validEntries.length} entries remaining`);
    }

    getStats() {
        return {
            solPrice: {
                current: this.solPriceCache.price,
                lastUpdated: this.solPriceCache.lastUpdated,
                age: Date.now() - this.solPriceCache.lastUpdated
            },
            tokenCache: {
                size: this.tokenPriceCache.size,
                maxSize: this.maxCacheSize,
                utilization: Math.round((this.tokenPriceCache.size / this.maxCacheSize) * 100)
            }
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Price service closed`);
    }
}

module.exports = PriceService;