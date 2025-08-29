// server/src/services/enhancedPriceService.js - Гибридный сервис цен (OnChain + External)
const Redis = require('ioredis');
const OnChainTokenService = require('./onChainTokenService');

class EnhancedPriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.onChainService = new OnChainTokenService();
        
        // Настройки кэширования
        this.SOL_PRICE_CACHE_TTL = 30; // 30 секунд для SOL
        this.TOKEN_PRICE_CACHE_TTL = 60; // 1 минута для токенов
        this.EXTERNAL_API_TIMEOUT = 5000; // 5 секунд таймаут для внешних API
        
        // Fallback настройки
        this.USE_ONCHAIN_FIRST = true; // Приоритет OnChain данным
        this.FALLBACK_TO_EXTERNAL = true; // Использовать внешние API как fallback
        
        // Кэш в памяти для быстрого доступа
        this.memoryCache = new Map();
        this.maxMemoryCacheSize = 1000;
        
        // Статистика
        this.stats = {
            onchainRequests: 0,
            externalRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            errors: 0,
            avgResponseTime: 0,
            totalRequests: 0
        };
        
        // Запуск фоновых обновлений
        this.startBackgroundUpdates();
        
        console.log(`[${new Date().toISOString()}] 🚀 Enhanced PriceService initialized`);
    }

    // Фоновые обновления популярных токенов
    startBackgroundUpdates() {
        // Обновляем цену SOL каждые 30 секунд
        setInterval(async () => {
            try {
                await this.updateSolPriceInBackground();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
            }
        }, 30000);

        // Очистка кэша памяти каждые 5 минут
        setInterval(() => {
            this.cleanMemoryCache();
        }, 300000);
    }

    // Получение цены SOL с гибридным подходом
    async getSolPrice() {
        const startTime = Date.now();
        try {
            const cacheKey = 'sol_price_enhanced';
            
            // Проверить кэш в памяти
            const memoryPrice = this.memoryCache.get(cacheKey);
            if (memoryPrice && (Date.now() - memoryPrice.timestamp) < this.SOL_PRICE_CACHE_TTL * 1000) {
                this.stats.cacheHits++;
                return {
                    success: true,
                    price: memoryPrice.price,
                    source: 'memory_cache',
                    lastUpdated: memoryPrice.timestamp,
                    responseTime: Date.now() - startTime
                };
            }

            // Проверить Redis кэш
            const redisPrice = await this.redis.get(cacheKey);
            if (redisPrice) {
                const cached = JSON.parse(redisPrice);
                if (Date.now() - cached.timestamp < this.SOL_PRICE_CACHE_TTL * 1000) {
                    // Обновить кэш памяти
                    this.memoryCache.set(cacheKey, cached);
                    this.stats.cacheHits++;
                    
                    return {
                        success: true,
                        price: cached.price,
                        source: 'redis_cache',
                        lastUpdated: cached.timestamp,
                        responseTime: Date.now() - startTime
                    };
                }
            }

            this.stats.cacheMisses++;
            let priceData = null;

            // Попробовать получить из OnChain данных
            if (this.USE_ONCHAIN_FIRST) {
                try {
                    const onchainData = await this.onChainService.getTokenPrice('So11111111111111111111111111111111111111112');
                    if (onchainData && onchainData.price > 0) {
                        priceData = {
                            price: onchainData.price,
                            source: 'onchain_pools',
                            liquidity: onchainData.totalLiquidity,
                            poolCount: onchainData.poolCount,
                            timestamp: Date.now()
                        };
                        this.stats.onchainRequests++;
                    }
                } catch (onchainError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ OnChain SOL price failed: ${onchainError.message}`);
                }
            }

            // Fallback к внешним API если OnChain не сработал
            if (!priceData && this.FALLBACK_TO_EXTERNAL) {
                priceData = await this.fetchSolPriceFromExternal();
            }

            // Fallback к фиксированной цене если все не сработало
            if (!priceData) {
                priceData = {
                    price: 150,
                    source: 'fallback',
                    timestamp: Date.now()
                };
            }

            // Кэшировать результат
            await this.cachePriceData(cacheKey, priceData);

            const responseTime = Date.now() - startTime;
            this.updateStats(responseTime);

            return {
                success: true,
                price: priceData.price,
                source: priceData.source,
                liquidity: priceData.liquidity,
                poolCount: priceData.poolCount,
                lastUpdated: priceData.timestamp,
                responseTime
            };

        } catch (error) {
            this.stats.errors++;
            console.error(`[${new Date().toISOString()}] ❌ Error in getSolPrice:`, error.message);
            
            return {
                success: false,
                price: 150, // Fallback цена
                source: 'error_fallback',
                error: error.message,
                responseTime: Date.now() - startTime
            };
        }
    }

    // Получение цен токенов batch с гибридным подходом
    async getTokenPrices(mintAddresses) {
        const startTime = Date.now();
        try {
            if (!mintAddresses || mintAddresses.length === 0) {
                return new Map();
            }

            console.log(`[${new Date().toISOString()}] 🔍 Enhanced batch price request for ${mintAddresses.length} tokens`);

            const results = new Map();
            const uncachedMints = [];
            
            // Проверить кэш для всех токенов
            for (const mint of mintAddresses) {
                const cached = await this.getCachedTokenPrice(mint);
                if (cached) {
                    results.set(mint, cached);
                    this.stats.cacheHits++;
                } else {
                    uncachedMints.push(mint);
                    this.stats.cacheMisses++;
                }
            }

            if (uncachedMints.length === 0) {
                console.log(`[${new Date().toISOString()}] ✅ All prices served from cache`);
                return results;
            }

            console.log(`[${new Date().toISOString()}] 🔄 Fetching fresh data for ${uncachedMints.length} tokens`);

            let onchainResults = new Map();
            let externalResults = new Map();

            // Попробовать получить через OnChain
            if (this.USE_ONCHAIN_FIRST) {
                try {
                    console.log(`[${new Date().toISOString()}] 🔗 Fetching onchain data for ${uncachedMints.length} tokens`);
                    onchainResults = await this.onChainService.getTokensBatch(uncachedMints);
                    this.stats.onchainRequests += uncachedMints.length;
                } catch (onchainError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ OnChain batch failed: ${onchainError.message}`);
                }
            }

            // Определить какие токены не получены через OnChain
            const remainingMints = [];
            for (const mint of uncachedMints) {
                const onchainData = onchainResults.get(mint);
                if (onchainData && onchainData.price > 0) {
                    const priceData = {
                        price: onchainData.price,
                        change24h: 0, // OnChain не предоставляет изменения
                        volume24h: onchainData.liquidity || 0,
                        liquidity: onchainData.liquidity || 0,
                        marketCap: onchainData.marketCap || 0,
                        source: 'onchain',
                        poolCount: onchainData.poolCount || 0,
                        timestamp: Date.now()
                    };
                    
                    results.set(mint, priceData);
                    
                    // Кэшировать OnChain результат
                    await this.cacheTokenPrice(mint, priceData);
                } else {
                    remainingMints.push(mint);
                }
            }

            // Fallback к внешним API для оставшихся токенов
            if (remainingMints.length > 0 && this.FALLBACK_TO_EXTERNAL) {
                console.log(`[${new Date().toISOString()}] 🌐 Fetching external data for ${remainingMints.length} tokens`);
                
                try {
                    externalResults = await this.fetchTokenPricesFromExternal(remainingMints);
                    this.stats.externalRequests += remainingMints.length;
                    
                    // Добавить внешние результаты
                    for (const [mint, data] of externalResults) {
                        if (data) {
                            results.set(mint, data);
                            await this.cacheTokenPrice(mint, data);
                        }
                    }
                } catch (externalError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ External API batch failed: ${externalError.message}`);
                }
            }

            const responseTime = Date.now() - startTime;
            this.updateStats(responseTime);

            console.log(`[${new Date().toISOString()}] ✅ Enhanced batch completed in ${responseTime}ms:`);
            console.log(`  - OnChain: ${onchainResults.size} tokens`);
            console.log(`  - External: ${externalResults.size} tokens`);
            console.log(`  - Cached: ${mintAddresses.length - uncachedMints.length} tokens`);
            console.log(`  - Total: ${results.size}/${mintAddresses.length} tokens`);

            return results;

        } catch (error) {
            this.stats.errors++;
            console.error(`[${new Date().toISOString()}] ❌ Error in enhanced batch request:`, error.message);
            return new Map();
        }
    }

    // Получение одной цены токена
    async getTokenPrice(mintAddress) {
        const results = await this.getTokenPrices([mintAddress]);
        return results.get(mintAddress) || null;
    }

    // Получение цены SOL из внешних источников
    async fetchSolPriceFromExternal() {
        try {
            this.stats.externalRequests++;
            
            // Попробовать несколько источников
            const sources = [
                () => this.fetchFromDexScreener('So11111111111111111111111111111111111111112'),
                () => this.fetchFromJupiter(['SOL']),
                () => this.fetchFromCoinGecko(['solana'])
            ];

            for (const fetchFn of sources) {
                try {
                    const result = await Promise.race([
                        fetchFn(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), this.EXTERNAL_API_TIMEOUT))
                    ]);

                    if (result && result.price > 0) {
                        return {
                            price: result.price,
                            source: result.source || 'external',
                            timestamp: Date.now()
                        };
                    }
                } catch (sourceError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ External source failed: ${sourceError.message}`);
                    continue;
                }
            }

            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ All external SOL price sources failed:`, error.message);
            return null;
        }
    }

    // Получение цен токенов из внешних источников
    async fetchTokenPricesFromExternal(mintAddresses) {
        const results = new Map();
        
        try {
            // DexScreener batch
            const dexScreenerResults = await this.fetchTokenPricesFromDexScreener(mintAddresses);
            for (const [mint, data] of dexScreenerResults) {
                if (data) results.set(mint, data);
            }

            // Jupiter для оставшихся
            const remainingMints = mintAddresses.filter(mint => !results.has(mint));
            if (remainingMints.length > 0) {
                const jupiterResults = await this.fetchTokenPricesFromJupiter(remainingMints);
                for (const [mint, data] of jupiterResults) {
                    if (data) results.set(mint, data);
                }
            }

            return results;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ External token prices batch failed:`, error.message);
            return results;
        }
    }

    // Получение цен из DexScreener
    async fetchFromDexScreener(mintAddress) {
        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, {
                timeout: this.EXTERNAL_API_TIMEOUT,
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
                
                return {
                    price: parseFloat(bestPair.priceUsd || 0),
                    change24h: parseFloat(bestPair.priceChange?.h24 || 0),
                    volume24h: parseFloat(bestPair.volume?.h24 || 0),
                    liquidity: parseFloat(bestPair.liquidity?.usd || 0),
                    source: 'dexscreener'
                };
            }
            
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ DexScreener fetch failed for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Batch получение из DexScreener
    async fetchTokenPricesFromDexScreener(mintAddresses) {
        const results = new Map();
        const BATCH_SIZE = 10;

        for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
            const batch = mintAddresses.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (mint) => {
                const data = await this.fetchFromDexScreener(mint);
                return { mint, data };
            });

            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mint, data }) => {
                if (data) {
                    results.set(mint, {
                        ...data,
                        timestamp: Date.now()
                    });
                }
            });

            // Пауза между батчами
            if (i + BATCH_SIZE < mintAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return results;
    }

    // Получение цен из Jupiter
    async fetchFromJupiter(symbols) {
        try {
            const symbolsStr = Array.isArray(symbols) ? symbols.join(',') : symbols;
            const response = await fetch(`https://price.jup.ag/v6/price?ids=${symbolsStr}`, {
                timeout: this.EXTERNAL_API_TIMEOUT,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.data) {
                const prices = {};
                for (const [symbol, priceData] of Object.entries(data.data)) {
                    prices[symbol] = {
                        price: parseFloat(priceData.price || 0),
                        source: 'jupiter'
                    };
                }
                return prices;
            }
            
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Jupiter fetch failed:`, error.message);
            return null;
        }
    }

    // Batch получение из Jupiter
    async fetchTokenPricesFromJupiter(mintAddresses) {
        const results = new Map();
        
        try {
            const response = await this.fetchFromJupiter(mintAddresses);
            if (response) {
                for (const [mint, data] of Object.entries(response)) {
                    results.set(mint, {
                        ...data,
                        timestamp: Date.now()
                    });
                }
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Jupiter batch failed:`, error.message);
        }
        
        return results;
    }

    // Получение цен из CoinGecko (для популярных токенов)
    async fetchFromCoinGecko(ids) {
        try {
            const idsStr = Array.isArray(ids) ? ids.join(',') : ids;
            const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${idsStr}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`, {
                timeout: this.EXTERNAL_API_TIMEOUT,
                headers: { 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data) {
                const prices = {};
                for (const [id, priceData] of Object.entries(data)) {
                    prices[id] = {
                        price: priceData.usd || 0,
                        change24h: priceData.usd_24h_change || 0,
                        volume24h: priceData.usd_24h_vol || 0,
                        source: 'coingecko'
                    };
                }
                return prices;
            }
            
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ CoinGecko fetch failed:`, error.message);
            return null;
        }
    }

    // Получение кэшированной цены токена
    async getCachedTokenPrice(mintAddress) {
        try {
            // Сначала проверить кэш в памяти
            const memoryKey = `token_price:${mintAddress}`;
            const memoryData = this.memoryCache.get(memoryKey);
            if (memoryData && (Date.now() - memoryData.timestamp) < this.TOKEN_PRICE_CACHE_TTL * 1000) {
                return memoryData;
            }

            // Проверить Redis кэш
            const redisKey = `enhanced_token_price:${mintAddress}`;
            const redisData = await this.redis.get(redisKey);
            if (redisData) {
                const parsed = JSON.parse(redisData);
                if (Date.now() - parsed.timestamp < this.TOKEN_PRICE_CACHE_TTL * 1000) {
                    // Обновить кэш памяти
                    this.memoryCache.set(memoryKey, parsed);
                    return parsed;
                }
            }

            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting cached price:`, error.message);
            return null;
        }
    }

    // Кэширование цены токена
    async cacheTokenPrice(mintAddress, priceData) {
        try {
            const cacheData = {
                ...priceData,
                timestamp: Date.now()
            };

            // Кэшировать в памяти
            const memoryKey = `token_price:${mintAddress}`;
            this.memoryCache.set(memoryKey, cacheData);

            // Кэшировать в Redis
            const redisKey = `enhanced_token_price:${mintAddress}`;
            await this.redis.setex(redisKey, this.TOKEN_PRICE_CACHE_TTL * 2, JSON.stringify(cacheData));

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error caching token price:`, error.message);
        }
    }

    // Кэширование данных цены
    async cachePriceData(cacheKey, priceData) {
        try {
            // Кэш в памяти
            this.memoryCache.set(cacheKey, priceData);

            // Кэш в Redis
            await this.redis.setex(cacheKey, this.SOL_PRICE_CACHE_TTL * 2, JSON.stringify(priceData));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error caching price data:`, error.message);
        }
    }

    // Фоновое обновление цены SOL
    async updateSolPriceInBackground() {
        try {
            const priceData = await this.getSolPrice();
            if (priceData.success) {
                console.log(`[${new Date().toISOString()}] ✅ Background SOL price update: ${priceData.price} (${priceData.source})`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
        }
    }

    // Очистка кэша памяти
    cleanMemoryCache() {
        if (this.memoryCache.size <= this.maxMemoryCacheSize) return;

        const entries = Array.from(this.memoryCache.entries());
        const now = Date.now();
        
        // Удалить устаревшие записи
        const validEntries = entries.filter(([key, value]) => 
            (now - value.timestamp) < (this.TOKEN_PRICE_CACHE_TTL * 1000 * 2)
        );

        // Если все еще слишком много, оставить только самые свежие
        if (validEntries.length > this.maxMemoryCacheSize) {
            validEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            validEntries.length = this.maxMemoryCacheSize;
        }

        // Пересоздать кэш
        this.memoryCache.clear();
        validEntries.forEach(([key, value]) => {
            this.memoryCache.set(key, value);
        });

        console.log(`[${new Date().toISOString()}] 🧹 Memory cache cleaned: ${validEntries.length} entries remaining`);
    }

    // Обновление статистики
    updateStats(responseTime) {
        this.stats.totalRequests++;
        const totalTime = this.stats.avgResponseTime * (this.stats.totalRequests - 1) + responseTime;
        this.stats.avgResponseTime = Math.round(totalTime / this.stats.totalRequests);
    }

    // Получение детальной статистики
    getDetailedStats() {
        const onchainStats = this.onChainService ? this.onChainService.getStats() : {};
        
        return {
            performance: {
                totalRequests: this.stats.totalRequests,
                cacheHitRate: this.stats.totalRequests > 0 ? 
                    Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100) : 0,
                avgResponseTime: this.stats.avgResponseTime,
                errorRate: this.stats.totalRequests > 0 ? 
                    Math.round((this.stats.errors / this.stats.totalRequests) * 100) : 0
            },
            sources: {
                onchainRequests: this.stats.onchainRequests,
                externalRequests: this.stats.externalRequests,
                cacheHits: this.stats.cacheHits,
                cacheMisses: this.stats.cacheMisses
            },
            cache: {
                memorySize: this.memoryCache.size,
                maxMemorySize: this.maxMemoryCacheSize,
                memoryCacheUtilization: Math.round((this.memoryCache.size / this.maxMemoryCacheSize) * 100)
            },
            settings: {
                useOnchainFirst: this.USE_ONCHAIN_FIRST,
                fallbackToExternal: this.FALLBACK_TO_EXTERNAL,
                solPriceCacheTTL: this.SOL_PRICE_CACHE_TTL,
                tokenPriceCacheTTL: this.TOKEN_PRICE_CACHE_TTL,
                externalApiTimeout: this.EXTERNAL_API_TIMEOUT
            },
            onchainService: onchainStats
        };
    }

    // Получение базовой статистики (совместимость с текущим API)
    getStats() {
        return {
            totalRequests: this.stats.totalRequests,
            onchainRequests: this.stats.onchainRequests,
            externalRequests: this.stats.externalRequests,
            cacheHits: this.stats.cacheHits,
            cacheMisses: this.stats.cacheMisses,
            errors: this.stats.errors,
            avgResponseTime: this.stats.avgResponseTime,
            memoryCache: {
                size: this.memoryCache.size,
                maxSize: this.maxMemoryCacheSize
            }
        };
    }

    // Закрытие сервиса
    async close() {
        if (this.onChainService) {
            await this.onChainService.close();
        }
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ Enhanced PriceService closed`);
    }
}

module.exports = EnhancedPriceService;