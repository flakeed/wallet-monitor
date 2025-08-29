// server/src/services/solanaPoolService.js - Direct pool data from Solana RPC

const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

class SolanaPoolService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111', {
            commitment: 'confirmed',
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        
        // Важные константы для Solana
        this.WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        this.USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        this.USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
        
        // Raydium AMM Program IDs
        this.RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
        this.RAYDIUM_AMM_PROGRAM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
        
        // Orca Program IDs  
        this.ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
        this.ORCA_AMM_PROGRAM = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP';
        
        // Jupiter Program IDs
        this.JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
        
        // Метрики и кэш
        this.solPriceCache = { price: 150, timestamp: 0, ttl: 30000 };
        this.poolCache = new Map(); // кэш пулов
        this.priceCache = new Map(); // кэш цен
        this.stats = {
            poolRequests: 0,
            cacheHits: 0,
            errors: 0,
            avgResponseTime: 0
        };
        
        console.log(`[${new Date().toISOString()}] 🏊 SolanaPoolService initialized`);
        this.startBackgroundUpdates();
    }

    // Фоновые обновления цены SOL
    startBackgroundUpdates() {
        // Обновляем SOL цену каждые 15 секунд
        setInterval(async () => {
            try {
                await this.updateSolPriceFromPools();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
            }
        }, 15000);

        // Очищаем старые кэши каждые 2 минуты
        setInterval(() => {
            this.cleanCaches();
        }, 120000);
    }

    // Получение цены SOL через пулы SOL/USDC
    async updateSolPriceFromPools() {
        const now = Date.now();
        
        if (now - this.solPriceCache.timestamp < this.solPriceCache.ttl) {
            return this.solPriceCache.price;
        }

        try {
            // Получаем цену SOL из основных пулов
            const pools = await this.findPoolsForToken(this.WRAPPED_SOL_MINT, this.USDC_MINT);
            
            if (pools.length === 0) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No SOL/USDC pools found`);
                return this.solPriceCache.price;
            }

            let totalLiquidity = 0;
            let weightedPrice = 0;

            for (const pool of pools.slice(0, 3)) { // Топ-3 пула
                try {
                    const price = await this.calculatePoolPrice(pool, this.WRAPPED_SOL_MINT, this.USDC_MINT);
                    if (price && price.price > 0 && price.liquidity > 100000) { // Минимум $100k ликвидности
                        weightedPrice += price.price * price.liquidity;
                        totalLiquidity += price.liquidity;
                    }
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Error calculating price for pool ${pool.address}:`, error.message);
                }
            }

            if (totalLiquidity > 0) {
                const newPrice = weightedPrice / totalLiquidity;
                this.solPriceCache = {
                    price: newPrice,
                    timestamp: now,
                    ttl: 30000
                };
                
                // Сохраняем в Redis для шаринга между инстансами
                await this.redis.setex('sol_price_pools', 60, JSON.stringify(this.solPriceCache));
                
                console.log(`[${new Date().toISOString()}] ✅ Updated SOL price from pools: $${newPrice.toFixed(4)}`);
                return newPrice;
            }

            console.warn(`[${new Date().toISOString()}] ⚠️ No valid pool prices found for SOL`);
            return this.solPriceCache.price;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating SOL price from pools:`, error.message);
            return this.solPriceCache.price;
        }
    }

    // Поиск пулов для пары токенов
    async findPoolsForToken(tokenA, tokenB) {
        const cacheKey = `pools:${tokenA}:${tokenB}`;
        const cached = this.poolCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < 300000) { // 5 минут кэш
            return cached.pools;
        }

        try {
            const pools = [];
            
            // Поиск пулов Raydium
            const raydiumPools = await this.findRaydiumPools(tokenA, tokenB);
            pools.push(...raydiumPools);
            
            // Поиск пулов Orca
            const orcaPools = await this.findOrcaPools(tokenA, tokenB);
            pools.push(...orcaPools);
            
            // Сортируем по ликвидности (приблизительно)
            pools.sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
            
            this.poolCache.set(cacheKey, {
                pools: pools,
                timestamp: Date.now()
            });

            console.log(`[${new Date().toISOString()}] 📊 Found ${pools.length} pools for ${tokenA.slice(0,8)}.../${tokenB.slice(0,8)}...`);
            return pools;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding pools:`, error.message);
            return [];
        }
    }

    // Поиск пулов Raydium AMM
    async findRaydiumPools(tokenA, tokenB) {
        try {
            const accounts = await this.connection.getProgramAccounts(
                new PublicKey(this.RAYDIUM_AMM_PROGRAM),
                {
                    commitment: 'confirmed',
                    filters: [
                        { dataSize: 752 }, // Размер Raydium AMM аккаунта
                        // Можно добавить фильтры по токенам, но это сложнее
                    ]
                }
            );

            const pools = [];
            
            for (const account of accounts.slice(0, 50)) { // Ограничиваем количество для производительности
                try {
                    const poolInfo = this.parseRaydiumPoolData(account.account.data);
                    
                    if (poolInfo && (
                        (poolInfo.tokenA === tokenA && poolInfo.tokenB === tokenB) ||
                        (poolInfo.tokenA === tokenB && poolInfo.tokenB === tokenA)
                    )) {
                        pools.push({
                            address: account.pubkey.toString(),
                            program: 'Raydium',
                            tokenA: poolInfo.tokenA,
                            tokenB: poolInfo.tokenB,
                            reserveA: poolInfo.reserveA,
                            reserveB: poolInfo.reserveB,
                            liquidity: poolInfo.liquidity
                        });
                    }
                } catch (error) {
                    // Игнорируем ошибки парсинга отдельных пулов
                }
            }

            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding Raydium pools:`, error.message);
            return [];
        }
    }

    // Поиск пулов Orca
    async findOrcaPools(tokenA, tokenB) {
        try {
            // Orca использует другую структуру, упрощенный поиск
            const accounts = await this.connection.getProgramAccounts(
                new PublicKey(this.ORCA_AMM_PROGRAM),
                {
                    commitment: 'confirmed',
                    filters: [
                        { dataSize: 324 }, // Размер Orca pool аккаунта
                    ]
                }
            );

            const pools = [];
            
            for (const account of accounts.slice(0, 30)) {
                try {
                    const poolInfo = this.parseOrcaPoolData(account.account.data);
                    
                    if (poolInfo && (
                        (poolInfo.tokenA === tokenA && poolInfo.tokenB === tokenB) ||
                        (poolInfo.tokenA === tokenB && poolInfo.tokenB === tokenA)
                    )) {
                        pools.push({
                            address: account.pubkey.toString(),
                            program: 'Orca',
                            tokenA: poolInfo.tokenA,
                            tokenB: poolInfo.tokenB,
                            reserveA: poolInfo.reserveA,
                            reserveB: poolInfo.reserveB,
                            liquidity: poolInfo.liquidity
                        });
                    }
                } catch (error) {
                    // Игнорируем ошибки парсинга
                }
            }

            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding Orca pools:`, error.message);
            return [];
        }
    }

    // Парсинг данных пула Raydium (упрощенный)
    parseRaydiumPoolData(data) {
        try {
            // Это упрощенная версия парсинга
            // В реальности нужно точно знать структуру данных Raydium
            
            const dataBuffer = Buffer.from(data);
            
            // Примерные оффсеты для Raydium AMM (нужно уточнить)
            const tokenA = new PublicKey(dataBuffer.slice(8, 40)).toString();
            const tokenB = new PublicKey(dataBuffer.slice(40, 72)).toString();
            
            // Резервы (примерные оффсеты)
            const reserveA = dataBuffer.readBigUInt64LE(100);
            const reserveB = dataBuffer.readBigUInt64LE(108);
            
            return {
                tokenA,
                tokenB,
                reserveA: Number(reserveA),
                reserveB: Number(reserveB),
                liquidity: Number(reserveA) + Number(reserveB) // Упрощенная оценка
            };
        } catch (error) {
            return null;
        }
    }

    // Парсинг данных пула Orca (упрощенный)
    parseOrcaPoolData(data) {
        try {
            const dataBuffer = Buffer.from(data);
            
            // Примерные оффсеты для Orca (нужно уточнить)
            const tokenA = new PublicKey(dataBuffer.slice(8, 40)).toString();
            const tokenB = new PublicKey(dataBuffer.slice(40, 72)).toString();
            
            const reserveA = dataBuffer.readBigUInt64LE(80);
            const reserveB = dataBuffer.readBigUInt64LE(88);
            
            return {
                tokenA,
                tokenB,
                reserveA: Number(reserveA),
                reserveB: Number(reserveB),
                liquidity: Number(reserveA) + Number(reserveB)
            };
        } catch (error) {
            return null;
        }
    }

    // Вычисление цены из пула
    async calculatePoolPrice(pool, baseToken, quoteToken) {
        try {
            let price = 0;
            let liquidity = 0;

            if (pool.tokenA === baseToken && pool.tokenB === quoteToken) {
                // baseToken/quoteToken
                if (pool.reserveA > 0 && pool.reserveB > 0) {
                    // Учитываем decimals токенов
                    const baseDecimals = baseToken === this.WRAPPED_SOL_MINT ? 9 : 6;
                    const quoteDecimals = quoteToken === this.USDC_MINT ? 6 : 9;
                    
                    const adjustedReserveA = pool.reserveA / Math.pow(10, baseDecimals);
                    const adjustedReserveB = pool.reserveB / Math.pow(10, quoteDecimals);
                    
                    price = adjustedReserveB / adjustedReserveA;
                    liquidity = adjustedReserveB; // USDC ликвидность
                }
            } else if (pool.tokenA === quoteToken && pool.tokenB === baseToken) {
                // quoteToken/baseToken (обратная пара)
                if (pool.reserveA > 0 && pool.reserveB > 0) {
                    const baseDecimals = baseToken === this.WRAPPED_SOL_MINT ? 9 : 6;
                    const quoteDecimals = quoteToken === this.USDC_MINT ? 6 : 9;
                    
                    const adjustedReserveA = pool.reserveA / Math.pow(10, quoteDecimals);
                    const adjustedReserveB = pool.reserveB / Math.pow(10, baseDecimals);
                    
                    price = adjustedReserveA / adjustedReserveB;
                    liquidity = adjustedReserveA; // USDC ликвидность
                }
            }

            return {
                price,
                liquidity,
                pool: pool.address,
                program: pool.program
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating pool price:`, error.message);
            return null;
        }
    }

    // Получение цены токена через пулы
    async getTokenPriceFromPools(tokenMint) {
        const startTime = Date.now();
        this.stats.poolRequests++;

        // Проверяем кэш
        const cached = this.priceCache.get(tokenMint);
        if (cached && Date.now() - cached.timestamp < 60000) { // 1 минута кэш
            this.stats.cacheHits++;
            return cached.data;
        }

        try {
            // Сначала получаем актуальную цену SOL
            const solPrice = await this.updateSolPriceFromPools();

            if (tokenMint === this.WRAPPED_SOL_MINT) {
                return {
                    price: solPrice,
                    change24h: 0, // TODO: можно вычислить через исторические данные
                    volume24h: 0,
                    liquidity: 0,
                    source: 'pools'
                };
            }

            // Ищем пулы token/SOL
            const solPools = await this.findPoolsForToken(tokenMint, this.WRAPPED_SOL_MINT);
            // Ищем пулы token/USDC
            const usdcPools = await this.findPoolsForToken(tokenMint, this.USDC_MINT);

            const allPools = [...solPools, ...usdcPools];

            if (allPools.length === 0) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No pools found for token ${tokenMint.slice(0,8)}...`);
                return null;
            }

            let bestPrice = null;
            let totalLiquidity = 0;
            let weightedPrice = 0;

            for (const pool of allPools.slice(0, 5)) { // Топ-5 пулов
                try {
                    let poolPriceData;

                    if (pool.tokenA === tokenMint || pool.tokenB === tokenMint) {
                        if (pool.tokenA === this.WRAPPED_SOL_MINT || pool.tokenB === this.WRAPPED_SOL_MINT) {
                            // token/SOL пул
                            poolPriceData = await this.calculatePoolPrice(pool, tokenMint, this.WRAPPED_SOL_MINT);
                            if (poolPriceData && poolPriceData.price > 0) {
                                poolPriceData.price *= solPrice; // Конвертируем в USD
                            }
                        } else if (pool.tokenA === this.USDC_MINT || pool.tokenB === this.USDC_MINT) {
                            // token/USDC пул
                            poolPriceData = await this.calculatePoolPrice(pool, tokenMint, this.USDC_MINT);
                        }

                        if (poolPriceData && poolPriceData.price > 0 && poolPriceData.liquidity > 1000) {
                            if (!bestPrice || poolPriceData.liquidity > bestPrice.liquidity) {
                                bestPrice = poolPriceData;
                            }

                            weightedPrice += poolPriceData.price * poolPriceData.liquidity;
                            totalLiquidity += poolPriceData.liquidity;
                        }
                    }
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Error processing pool ${pool.address}:`, error.message);
                }
            }

            let finalPrice = null;
            if (totalLiquidity > 0) {
                const avgPrice = weightedPrice / totalLiquidity;
                finalPrice = {
                    price: avgPrice,
                    change24h: 0, // TODO
                    volume24h: 0, // TODO
                    liquidity: totalLiquidity,
                    source: 'pools',
                    poolsUsed: allPools.length,
                    bestPool: bestPrice?.pool
                };

                // Кэшируем результат
                this.priceCache.set(tokenMint, {
                    data: finalPrice,
                    timestamp: Date.now()
                });
            }

            const responseTime = Date.now() - startTime;
            this.stats.avgResponseTime = (this.stats.avgResponseTime + responseTime) / 2;

            if (finalPrice) {
                console.log(`[${new Date().toISOString()}] ✅ Got price for ${tokenMint.slice(0,8)}... from pools: $${finalPrice.price.toFixed(8)} (${responseTime}ms)`);
            }

            return finalPrice;

        } catch (error) {
            this.stats.errors++;
            console.error(`[${new Date().toISOString()}] ❌ Error getting token price from pools:`, error.message);
            return null;
        }
    }

    // Получение цен для нескольких токенов
    async getTokenPricesFromPools(tokenMints) {
        const results = new Map();
        
        // Обрабатываем параллельно, но ограничиваем количество
        const BATCH_SIZE = 5;
        for (let i = 0; i < tokenMints.length; i += BATCH_SIZE) {
            const batch = tokenMints.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (mint) => {
                try {
                    const price = await this.getTokenPriceFromPools(mint);
                    return { mint, price };
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error in batch for ${mint}:`, error.message);
                    return { mint, price: null };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mint, price }) => {
                results.set(mint, price);
            });

            // Небольшая пауза между батчами
            if (i + BATCH_SIZE < tokenMints.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return results;
    }

    // Получение цены SOL
    async getSolPrice() {
        const price = await this.updateSolPriceFromPools();
        return {
            success: true,
            price: price,
            source: 'pools',
            lastUpdated: this.solPriceCache.timestamp
        };
    }

    // Очистка старых кэшей
    cleanCaches() {
        const now = Date.now();
        
        // Очищаем кэш цен (старше 5 минут)
        for (const [key, value] of this.priceCache.entries()) {
            if (now - value.timestamp > 300000) {
                this.priceCache.delete(key);
            }
        }

        // Очищаем кэш пулов (старше 10 минут)
        for (const [key, value] of this.poolCache.entries()) {
            if (now - value.timestamp > 600000) {
                this.poolCache.delete(key);
            }
        }

        console.log(`[${new Date().toISOString()}] 🧹 Cleaned caches: ${this.priceCache.size} prices, ${this.poolCache.size} pools`);
    }

    // Статистика сервиса
    getStats() {
        return {
            ...this.stats,
            solPrice: {
                current: this.solPriceCache.price,
                lastUpdated: this.solPriceCache.lastUpdated,
                age: Date.now() - this.solPriceCache.timestamp
            },
            caches: {
                prices: this.priceCache.size,
                pools: this.poolCache.size,
                hitRate: this.stats.poolRequests > 0 ? (this.stats.cacheHits / this.stats.poolRequests * 100).toFixed(1) + '%' : '0%'
            },
            connection: {
                endpoint: this.connection.rpcEndpoint,
                commitment: this.connection.commitment
            }
        };
    }

    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ SolanaPoolService closed`);
    }
}

module.exports = SolanaPoolService;