// server/src/services/enhancedPriceService.js - Гибридный сервис цен

const Redis = require('ioredis');
const SolanaPoolService = require('./solanaPoolService');

class EnhancedPriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.poolService = new SolanaPoolService();
        
        // Кэш для внешних API
        this.solPriceCache = {
            price: 150,
            lastUpdated: 0,
            cacheTimeout: 30000
        };
        this.tokenPriceCache = new Map();
        this.maxCacheSize = 1000;
        
        // Настройки стратегии получения данных
        this.strategies = {
            // Для SOL - сначала пулы, потом внешние API
            SOL: ['pools', 'dexscreener', 'fallback'],
            // Для популярных токенов - сначала пулы
            POPULAR: ['pools', 'dexscreener'],
            // Для редких токенов - внешние API, потом пулы
            RARE: ['dexscreener', 'pools']
        };
        
        // Список популярных токенов (имеют хорошие пулы)
        this.popularTokens = new Set([
            'So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
            'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
            // Добавляйте сюда другие популярные токены
        ]);
        
        // Статистика
        this.stats = {
            poolRequests: 0,
            apiRequests: 0,
            poolSuccess: 0,
            apiSuccess: 0,
            poolErrors: 0,
            apiErrors: 0,
            avgPoolTime: 0,
            avgApiTime: 0
        };
        
        console.log(`[${new Date().toISOString()}] 🚀 EnhancedPriceService initialized`);
        this.startBackgroundUpdates();
    }

    // Фоновые обновления
    startBackgroundUpdates() {
        // Обновляем SOL цену каждые 15 секунд (приоритет пулам)
        setInterval(async () => {
            try {
                await this.updateSolPriceHybrid();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
            }
        }, 15000);

        // Очищаем кэши каждые 3 минуты
        setInterval(() => {
            this.cleanTokenPriceCache();
        }, 180000);

        // Обновляем список популярных токенов каждые 30 минут
        setInterval(() => {
            this.updatePopularTokensList();
        }, 1800000);
    }

    // Гибридное получение цены SOL
    async updateSolPriceHybrid() {
        const now = Date.now();
        
        if (now - this.solPriceCache.lastUpdated < this.solPriceCache.cacheTimeout) {
            return this.solPriceCache.price;
        }

        let finalPrice = this.solPriceCache.price;
        let source = 'fallback';

        // Стратегия для SOL: pools -> dexscreener -> fallback
        for (const strategy of this.strategies.SOL) {
            try {
                const startTime = Date.now();
                
                if (strategy === 'pools') {
                    const poolResult = await this.poolService.getSolPrice();
                    if (poolResult && poolResult.success && poolResult.price > 50) { // Разумные границы
                        finalPrice = poolResult.price;
                        source = 'pools';
                        this.stats.poolSuccess++;
                        this.stats.avgPoolTime = (this.stats.avgPoolTime + (Date.now() - startTime)) / 2;
                        break;
                    }
                } else if (strategy === 'dexscreener') {
                    const apiPrice = await this.getSolPriceFromAPI();
                    if (apiPrice > 50) {
                        finalPrice = apiPrice;
                        source = 'dexscreener';
                        this.stats.apiSuccess++;
                        this.stats.avgApiTime = (this.stats.avgApiTime + (Date.now() - startTime)) / 2;
                        break;
                    }
                }
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] ⚠️ SOL price strategy ${strategy} failed:`, error.message);
                if (strategy === 'pools') {
                    this.stats.poolErrors++;
                } else {
                    this.stats.apiErrors++;
                }
            }
        }

        // Обновляем кэш
        this.solPriceCache = {
            price: finalPrice,
            lastUpdated: now,
            cacheTimeout: 30000,
            source
        };

        // Сохраняем в Redis
        await this.redis.setex('sol_price_hybrid', 60, JSON.stringify(this.solPriceCache));
        
        console.log(`[${new Date().toISOString()}] ✅ Updated SOL price (${source}): ${finalPrice.toFixed(4)}`);
        return finalPrice;
    }

    // Получение цены SOL из внешнего API
    async getSolPriceFromAPI() {
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                return parseFloat(bestPair.priceUsd || 150);
            }
            
            throw new Error('No price data found');
        } catch (error) {
            throw error;
        }
    }

    // Получение цены SOL (публичный метод)
    async getSolPrice() {
        const price = await this.updateSolPriceHybrid();
        return {
            success: true,
            price: price,
            source: this.solPriceCache.source || 'hybrid',
            lastUpdated: this.solPriceCache.lastUpdated
        };
    }

    // Гибридное получение цен токенов
    async getTokenPrices(tokenMints) {
        if (!tokenMints || tokenMints.length === 0) {
            return new Map();
        }

        const results = new Map();
        const uncachedMints = [];
        const now = Date.now();

        // Проверяем кэш
        for (const mint of tokenMints) {
            const cached = this.tokenPriceCache.get(mint);
            if (cached && (now - cached.timestamp) < 90000) { // 1.5 минуты кэш
                results.set(mint, cached.data);
            } else {
                uncachedMints.push(mint);
            }
        }

        if (uncachedMints.length === 0) {
            return results;
        }

        console.log(`[${new Date().toISOString()}] 💱 Getting prices for ${uncachedMints.length} tokens using hybrid approach`);

        // Разделяем токены на популярные и редкие
        const popularMints = [];
        const rareMints = [];
        
        uncachedMints.forEach(mint => {
            if (this.popularTokens.has(mint)) {
                popularMints.push(mint);
            } else {
                rareMints.push(mint);
            }
        });

        // Обрабатываем популярные токены (приоритет пулам)
        if (popularMints.length > 0) {
            await this.processTokensWithStrategy(popularMints, this.strategies.POPULAR, results);
        }

        // Обрабатываем редкие токены (приоритет внешним API)
        if (rareMints.length > 0) {
            await this.processTokensWithStrategy(rareMints, this.strategies.RARE, results);
        }

        return results;
    }

    // Обработка токенов с определенной стратегией
    async processTokensWithStrategy(tokenMints, strategies, results) {
        const BATCH_SIZE = 8;
        
        for (let i = 0; i < tokenMints.length; i += BATCH_SIZE) {
            const batch = tokenMints.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (mint) => {
                let finalPrice = null;
                let source = 'none';

                // Пробуем стратегии по порядку
                for (const strategy of strategies) {
                    try {
                        const startTime = Date.now();
                        
                        if (strategy === 'pools') {
                            this.stats.poolRequests++;
                            const poolPrice = await this.poolService.getTokenPriceFromPools(mint);
                            
                            if (poolPrice && poolPrice.price > 0) {
                                finalPrice = poolPrice;
                                source = 'pools';
                                this.stats.poolSuccess++;
                                this.stats.avgPoolTime = (this.stats.avgPoolTime + (Date.now() - startTime)) / 2;
                                break;
                            }
                        } else if (strategy === 'dexscreener') {
                            this.stats.apiRequests++;
                            const apiPrice = await this.getTokenPriceFromAPI(mint);
                            
                            if (apiPrice && apiPrice.price > 0) {
                                finalPrice = apiPrice;
                                source = 'dexscreener';
                                this.stats.apiSuccess++;
                                this.stats.avgApiTime = (this.stats.avgApiTime + (Date.now() - startTime)) / 2;
                                break;
                            }
                        }
                    } catch (error) {
                        console.warn(`[${new Date().toISOString()}] ⚠️ Strategy ${strategy} failed for ${mint.slice(0,8)}...:`, error.message);
                        if (strategy === 'pools') {
                            this.stats.poolErrors++;
                        } else {
                            this.stats.apiErrors++;
                        }
                    }
                }

                // Кэшируем результат
                if (finalPrice) {
                    finalPrice.source = source;
                    this.tokenPriceCache.set(mint, {
                        data: finalPrice,
                        timestamp: Date.now()
                    });
                    
                    console.log(`[${new Date().toISOString()}] ✅ Got price for ${mint.slice(0,8)}... (${source}): ${finalPrice.price.toFixed(8)}`);
                }

                return { mint, price: finalPrice };
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mint, price }) => {
                results.set(mint, price);
            });

            // Пауза между батчами
            if (i + BATCH_SIZE < tokenMints.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }

    // Получение цены токена из внешнего API
    async getTokenPriceFromAPI(mint) {
        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            let priceData = null;
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                priceData = {
                    price: parseFloat(bestPair.priceUsd || 0),
                    change24h: parseFloat(bestPair.priceChange?.h24 || 0),
                    volume24h: parseFloat(bestPair.volume?.h24 || 0),
                    liquidity: parseFloat(bestPair.liquidity?.usd || 0)
                };
            }

            return priceData;
        } catch (error) {
            throw error;
        }
    }

    // Обновление списка популярных токенов
    async updatePopularTokensList() {
        try {
            console.log(`[${new Date().toISOString()}] 📊 Updating popular tokens list...`);
            
            // Можно получить топ токены из различных источников
            // Пока оставляем статичный список, но можно расширить логику
            
            // Например, можно анализировать какие токены чаще всего запрашиваются
            // и автоматически добавлять их в популярные
            
            const requestCounts = new Map();
            // Анализируем статистику запросов из кэша
            for (const [mint, cached] of this.tokenPriceCache.entries()) {
                if (cached.requestCount) {
                    requestCounts.set(mint, cached.requestCount);
                }
            }
            
            // Добавляем в популярные токены с большим количеством запросов
            const sortedByRequests = [...requestCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20); // Топ-20
            
            let newPopularAdded = 0;
            sortedByRequests.forEach(([mint, count]) => {
                if (!this.popularTokens.has(mint) && count > 10) {
                    this.popularTokens.add(mint);
                    newPopularAdded++;
                }
            });
            
            if (newPopularAdded > 0) {
                console.log(`[${new Date().toISOString()}] 📈 Added ${newPopularAdded} new popular tokens`);
            }
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating popular tokens:`, error.message);
        }
    }

    // Очистка кэша токенов
    cleanTokenPriceCache() {
        if (this.tokenPriceCache.size <= this.maxCacheSize) return;

        const now = Date.now();
        const entries = Array.from(this.tokenPriceCache.entries());
        
        // Удаляем устаревшие записи
        const validEntries = entries.filter(([, value]) => 
            (now - value.timestamp) < 300000 // 5 минут
        );

        // Если все еще слишком много, оставляем самые свежие
        if (validEntries.length > this.maxCacheSize) {
            validEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            validEntries.length = this.maxCacheSize;
        }

        // Перестраиваем кэш
        this.tokenPriceCache.clear();
        validEntries.forEach(([key, value]) => {
            this.tokenPriceCache.set(key, value);
        });

        console.log(`[${new Date().toISOString()}] 🧹 Cleaned token price cache: ${validEntries.length} entries remaining`);
    }

    // Статистика сервиса
    getStats() {
        const poolStats = this.poolService.getStats();
        
        return {
            hybrid: {
                solPrice: {
                    current: this.solPriceCache.price,
                    lastUpdated: this.solPriceCache.lastUpdated,
                    source: this.solPriceCache.source,
                    age: Date.now() - this.solPriceCache.lastUpdated
                },
                tokenCache: {
                    size: this.tokenPriceCache.size,
                    maxSize: this.maxCacheSize,
                    utilization: Math.round((this.tokenPriceCache.size / this.maxCacheSize) * 100)
                },
                strategies: this.strategies,
                popularTokens: this.popularTokens.size
            },
            performance: {
                pools: {
                    requests: this.stats.poolRequests,
                    success: this.stats.poolSuccess,
                    errors: this.stats.poolErrors,
                    successRate: this.stats.poolRequests > 0 ? 
                        `${((this.stats.poolSuccess / this.stats.poolRequests) * 100).toFixed(1)}%` : '0%',
                    avgTime: `${this.stats.avgPoolTime.toFixed(0)}ms`
                },
                api: {
                    requests: this.stats.apiRequests,
                    success: this.stats.apiSuccess,
                    errors: this.stats.apiErrors,
                    successRate: this.stats.apiRequests > 0 ? 
                        `${((this.stats.apiSuccess / this.stats.apiRequests) * 100).toFixed(1)}%` : '0%',
                    avgTime: `${this.stats.avgApiTime.toFixed(0)}ms`
                }
            },
            pools: poolStats
        };
    }

    // Принудительное обновление цены токена
    async forceUpdateTokenPrice(mint) {
        this.tokenPriceCache.delete(mint);
        const result = new Map();
        await this.processTokensWithStrategy([mint], this.strategies.POPULAR, result);
        return result.get(mint);
    }

    // Получение лучшей цены токена (пробует все источники)
    async getBestTokenPrice(mint) {
        const results = [];
        
        // Пробуем получить из пулов
        try {
            const poolPrice = await this.poolService.getTokenPriceFromPools(mint);
            if (poolPrice && poolPrice.price > 0) {
                results.push({ ...poolPrice, source: 'pools' });
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Pool price failed:`, error.message);
        }
        
        // Пробуем получить из API
        try {
            const apiPrice = await this.getTokenPriceFromAPI(mint);
            if (apiPrice && apiPrice.price > 0) {
                results.push({ ...apiPrice, source: 'dexscreener' });
            }
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ API price failed:`, error.message);
        }
        
        if (results.length === 0) {
            return null;
        }
        
        // Выбираем лучший результат (по ликвидности или объему)
        const best = results.reduce((prev, current) => {
            const prevScore = (prev.liquidity || 0) + (prev.volume24h || 0);
            const currentScore = (current.liquidity || 0) + (current.volume24h || 0);
            return currentScore > prevScore ? current : prev;
        });
        
        return {
            ...best,
            alternatives: results.length > 1 ? results.filter(r => r !== best) : []
        };
    }

    async close() {
        await this.poolService.close();
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ EnhancedPriceService closed`);
    }
}

module.exports = EnhancedPriceService;