const Redis = require('ioredis');

class PriceService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.PRICE_CACHE_TTL = 60; // 1 минута кэш для цен
        this.SOL_PRICE_CACHE_TTL = 300; // 5 минут кэш для цены SOL
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.REQUEST_DELAY = 200; // Задержка между запросами к DexScreener
        
        // Инициализируем цену SOL
        this.initSOLPrice();
        
        // Обновляем цену SOL каждые 5 минут
        setInterval(() => this.updateSOLPrice(), 5 * 60 * 1000);

        console.log(`[${new Date().toISOString()}] 💰 PriceService initialized`);
    }

    async initSOLPrice() {
        try {
            await this.updateSOLPrice();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to initialize SOL price:`, error.message);
        }
    }

    async updateSOLPrice() {
        try {
            // Получаем цену SOL с CoinGecko (более надежный источник для SOL)
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            if (!response.ok) throw new Error('Failed to fetch SOL price');
            
            const data = await response.json();
            const solPrice = data.solana?.usd;
            
            if (solPrice) {
                await this.redis.set('price:SOL:USD', solPrice, 'EX', this.SOL_PRICE_CACHE_TTL);
                console.log(`[${new Date().toISOString()}] 💰 Updated SOL price: $${solPrice}`);
                return solPrice;
            } else {
                throw new Error('Invalid SOL price response');
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating SOL price:`, error.message);
            // Возвращаем кэшированную цену или дефолтную
            const cachedPrice = await this.redis.get('price:SOL:USD');
            return cachedPrice ? parseFloat(cachedPrice) : 100; // Дефолтная цена $100
        }
    }

    async getSOLPrice() {
        try {
            const cachedPrice = await this.redis.get('price:SOL:USD');
            if (cachedPrice) {
                return parseFloat(cachedPrice);
            }
            
            // Если нет в кэше, обновляем
            return await this.updateSOLPrice();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting SOL price:`, error.message);
            return 100; // Дефолтная цена
        }
    }

    async getTokenPrice(mint) {
        try {
            // Проверяем кэш
            const cachedPrice = await this.redis.get(`price:${mint}:SOL`);
            if (cachedPrice) {
                return JSON.parse(cachedPrice);
            }

            // Если нет в кэше, добавляем в очередь
            return new Promise((resolve, reject) => {
                this.requestQueue.push({ mint, resolve, reject });
                
                if (!this.isProcessingQueue) {
                    setImmediate(() => this.processQueue());
                }
                
                // Таймаут для предотвращения зависания
                setTimeout(() => {
                    reject(new Error('Price request timeout'));
                }, 30000);
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token price for ${mint}:`, error.message);
            return null;
        }
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const batch = this.requestQueue.splice(0, 10); // Обрабатываем по 10 токенов за раз
            
            await Promise.all(
                batch.map(async (request) => {
                    try {
                        const priceData = await this.fetchTokenPriceFromDexScreener(request.mint);
                        request.resolve(priceData);
                    } catch (error) {
                        request.reject(error);
                    }
                })
            );

            // Задержка между батчами
            if (this.requestQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.REQUEST_DELAY));
            }
        }

        this.isProcessingQueue = false;
    }

    async fetchTokenPriceFromDexScreener(mint) {
        try {
            console.log(`[${new Date().toISOString()}] 💱 Fetching price for token: ${mint}`);
            
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
            if (!response.ok) {
                throw new Error(`DexScreener API error: ${response.status}`);
            }

            const data = await response.json();
            
            if (!data.pairs || data.pairs.length === 0) {
                throw new Error('No trading pairs found');
            }

            // Ищем пару с SOL с наибольшей ликвидностью
            const solPairs = data.pairs.filter(pair => 
                pair.baseToken.address === mint && 
                (pair.quoteToken.symbol === 'SOL' || pair.quoteToken.symbol === 'WSOL')
            );

            if (solPairs.length === 0) {
                // Если нет прямой пары с SOL, ищем USD пару и конвертируем
                const usdPairs = data.pairs.filter(pair => 
                    pair.baseToken.address === mint && 
                    (pair.quoteToken.symbol === 'USDC' || pair.quoteToken.symbol === 'USDT')
                );

                if (usdPairs.length > 0) {
                    // Выбираем пару с наибольшей ликвидностью
                    const bestUsdPair = usdPairs.reduce((best, current) => 
                        (parseFloat(current.liquidity?.usd || 0) > parseFloat(best.liquidity?.usd || 0)) ? current : best
                    );

                    const solPrice = await this.getSOLPrice();
                    const tokenPriceUsd = parseFloat(bestUsdPair.priceUsd);
                    const tokenPriceSOL = tokenPriceUsd / solPrice;

                    const priceData = {
                        priceSOL: tokenPriceSOL,
                        priceUSD: tokenPriceUsd,
                        liquidity: bestUsdPair.liquidity?.usd || '0',
                        pair: bestUsdPair.pairAddress,
                        source: 'USD_PAIR_CONVERTED',
                        timestamp: Date.now()
                    };

                    // Кэшируем результат
                    await this.redis.set(
                        `price:${mint}:SOL`, 
                        JSON.stringify(priceData), 
                        'EX', 
                        this.PRICE_CACHE_TTL
                    );

                    return priceData;
                }

                throw new Error('No suitable trading pairs found');
            }

            // Выбираем пару с наибольшей ликвидностью
            const bestSolPair = solPairs.reduce((best, current) => 
                (parseFloat(current.liquidity?.usd || 0) > parseFloat(best.liquidity?.usd || 0)) ? current : best
            );

            const tokenPriceSOL = parseFloat(bestSolPair.priceNative || 0);
            const tokenPriceUSD = parseFloat(bestSolPair.priceUsd || 0);

            if (tokenPriceSOL === 0) {
                throw new Error('Invalid price data from DexScreener');
            }

            const priceData = {
                priceSOL: tokenPriceSOL,
                priceUSD: tokenPriceUSD,
                liquidity: bestSolPair.liquidity?.usd || '0',
                pair: bestSolPair.pairAddress,
                source: 'SOL_PAIR_DIRECT',
                timestamp: Date.now()
            };

            // Кэшируем результат
            await this.redis.set(
                `price:${mint}:SOL`, 
                JSON.stringify(priceData), 
                'EX', 
                this.PRICE_CACHE_TTL
            );

            console.log(`[${new Date().toISOString()}] ✅ Price cached for ${mint}: ${tokenPriceSOL} SOL`);
            return priceData;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${mint}:`, error.message);
            throw error;
        }
    }

    // Пакетное получение цен для множества токенов
    async getTokenPrices(mints) {
        const prices = new Map();
        const uncachedMints = [];

        // Сначала проверяем кэш
        const pipeline = this.redis.pipeline();
        mints.forEach(mint => {
            pipeline.get(`price:${mint}:SOL`);
        });

        const cachedResults = await pipeline.exec();
        
        cachedResults.forEach(([err, cachedPrice], index) => {
            if (!err && cachedPrice) {
                try {
                    prices.set(mints[index], JSON.parse(cachedPrice));
                } catch (e) {
                    uncachedMints.push(mints[index]);
                }
            } else {
                uncachedMints.push(mints[index]);
            }
        });

        // Получаем цены для некэшированных токенов
        if (uncachedMints.length > 0) {
            const pricePromises = uncachedMints.map(mint => 
                this.getTokenPrice(mint).catch(error => {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to get price for ${mint}:`, error.message);
                    return null;
                })
            );

            const fetchedPrices = await Promise.all(pricePromises);

            fetchedPrices.forEach((priceData, index) => {
                if (priceData) {
                    prices.set(uncachedMints[index], priceData);
                }
            });
        }

        return prices;
    }

    // Получение статистики по портфелю
    async calculatePortfolioStats(tokens) {
        try {
            const mints = tokens.map(token => token.mint);
            const prices = await this.getTokenPrices(mints);

            let totalRealizedPnL = 0;
            let totalUnrealizedPnL = 0;
            let totalSolSpent = 0;
            let totalCurrentValue = 0;
            let totalTokensWithPrice = 0;

            const enhancedTokens = tokens.map(token => {
                const priceData = prices.get(token.mint);
                const totalTokensHeld = token.wallets.reduce((sum, wallet) => {
                    const netTokens = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
                    return sum + Math.max(0, netTokens);
                }, 0);

                const tokenSolSpent = token.wallets.reduce((sum, wallet) => sum + wallet.solSpent, 0);
                
                totalRealizedPnL += token.summary.netSOL;
                totalSolSpent += tokenSolSpent;

                let unrealizedPnL = 0;
                let currentValue = 0;

                if (priceData && totalTokensHeld > 0) {
                    currentValue = totalTokensHeld * priceData.priceSOL;
                    unrealizedPnL = currentValue - tokenSolSpent;
                    totalUnrealizedPnL += unrealizedPnL;
                    totalCurrentValue += currentValue;
                    totalTokensWithPrice++;
                }

                return {
                    ...token,
                    priceData,
                    totalTokensHeld,
                    tokenSolSpent,
                    unrealizedPnL,
                    currentValue,
                    totalPnL: token.summary.netSOL + unrealizedPnL
                };
            });

            const portfolioStats = {
                totalRealizedPnL,
                totalUnrealizedPnL,
                totalPnL: totalRealizedPnL + totalUnrealizedPnL,
                totalSolSpent,
                totalCurrentValue,
                totalTokensWithPrice,
                totalTokens: tokens.length,
                priceDataCoverage: totalTokensWithPrice / tokens.length
            };

            return {
                tokens: enhancedTokens,
                portfolio: portfolioStats
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating portfolio stats:`, error.message);
            throw error;
        }
    }

    // Очистка старых цен из кэша
    async cleanupOldPrices() {
        try {
            const keys = await this.redis.keys('price:*:SOL');
            if (keys.length === 0) return;

            const pipeline = this.redis.pipeline();
            keys.forEach(key => {
                pipeline.get(key);
            });

            const results = await pipeline.exec();
            const expiredKeys = [];

            results.forEach(([err, value], index) => {
                if (!err && value) {
                    try {
                        const data = JSON.parse(value);
                        const age = Date.now() - data.timestamp;
                        // Удаляем цены старше 1 часа
                        if (age > 60 * 60 * 1000) {
                            expiredKeys.push(keys[index]);
                        }
                    } catch (e) {
                        expiredKeys.push(keys[index]);
                    }
                }
            });

            if (expiredKeys.length > 0) {
                await this.redis.del(...expiredKeys);
                console.log(`[${new Date().toISOString()}] 🧹 Cleaned up ${expiredKeys.length} expired price entries`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error cleaning up prices:`, error.message);
        }
    }

    // Получение статистики сервиса
    getServiceStats() {
        return {
            queueLength: this.requestQueue.length,
            isProcessing: this.isProcessingQueue,
            cacheSettings: {
                priceCacheTTL: this.PRICE_CACHE_TTL,
                solPriceCacheTTL: this.SOL_PRICE_CACHE_TTL,
                requestDelay: this.REQUEST_DELAY
            }
        };
    }

    async close() {
        try {
            await this.redis.quit();
            console.log(`[${new Date().toISOString()}] ✅ Price service closed`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error closing price service:`, error.message);
        }
    }
}

module.exports = PriceService;