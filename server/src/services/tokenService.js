const axios = require('axios');
const Redis = require('ioredis');

class FastTokenService {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        
        // Локальные кеши для максимальной скорости
        this.tokenCache = new Map();
        this.priceCache = new Map();
        
        // Константы
        this.TOKEN_CACHE_TTL = 3600; // 1 час
        this.PRICE_CACHE_TTL = 30; // 30 секунд
        this.BATCH_SIZE = 10;
        
        // Очередь запросов
        this.tokenQueue = new Set();
        this.processingTokens = false;
        
        // Статистика
        this.stats = {
            cacheHits: 0,
            apiCalls: 0,
            errors: 0
        };
        
        console.log('⚡ Fast Token Service initialized');
    }

    // Быстрое получение метаданных токена
    async getTokenMetadata(mint) {
        // Сначала проверяем локальный кеш
        if (this.tokenCache.has(mint)) {
            this.stats.cacheHits++;
            return this.tokenCache.get(mint);
        }
        
        try {
            // Проверяем Redis кеш
            const cached = await this.redis.get(`token:${mint}`);
            if (cached) {
                const tokenData = JSON.parse(cached);
                this.tokenCache.set(mint, tokenData);
                this.stats.cacheHits++;
                return tokenData;
            }
        } catch (error) {
            console.warn(`⚠️ Redis error for token ${mint}:`, error.message);
        }
        
        // Если нет в кешах, добавляем в очередь и возвращаем fallback
        this.tokenQueue.add(mint);
        
        // Запускаем обработку очереди если не активна
        if (!this.processingTokens) {
            setImmediate(() => this.processTokenQueue());
        }
        
        // Возвращаем базовые данные немедленно
        const fallback = {
            address: mint,
            symbol: mint.slice(0, 4).toUpperCase(),
            name: 'Unknown Token',
            logoURI: null,
            decimals: 6
        };
        
        // Кешируем fallback временно
        this.tokenCache.set(mint, fallback);
        
        return fallback;
    }

    // Обработка очереди токенов в фоне
    async processTokenQueue() {
        if (this.processingTokens || this.tokenQueue.size === 0) return;
        
        this.processingTokens = true;
        
        try {
            // Берем батч токенов из очереди
            const batch = Array.from(this.tokenQueue).slice(0, this.BATCH_SIZE);
            batch.forEach(mint => this.tokenQueue.delete(mint));
            
            console.log(`🔄 Processing token batch: ${batch.length} tokens`);
            
            // Обрабатываем батч параллельно
            await Promise.allSettled(batch.map(mint => this.fetchTokenMetadata(mint)));
            
        } catch (error) {
            console.error('❌ Error processing token queue:', error.message);
        }
        
        this.processingTokens = false;
        
        // Если есть еще токены в очереди, продолжаем
        if (this.tokenQueue.size > 0) {
            setTimeout(() => this.processTokenQueue(), 100);
        }
    }

    // Получение метаданных через Helius API
    async fetchTokenMetadata(mint) {
        try {
            const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
            if (!HELIUS_API_KEY) {
                console.warn('⚠️ HELIUS_API_KEY not set');
                return;
            }
            
            this.stats.apiCalls++;
            
            const response = await axios.post(
                `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
                { mintAccounts: [mint] },
                { 
                    timeout: 3000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.data && response.data.length > 0) {
                const meta = response.data[0];
                
                let logoURI = null;
                
                // Пытаемся получить логотип из URI
                const metadataUri = meta?.onChainMetadata?.metadata?.data?.uri;
                if (metadataUri) {
                    try {
                        const uriResponse = await axios.get(metadataUri, {
                            timeout: 2000,
                            responseType: 'json',
                            headers: {
                                'Accept': 'application/json',
                                'User-Agent': 'Mozilla/5.0'
                            }
                        });
                        
                        if (uriResponse.data && uriResponse.data.image) {
                            logoURI = this.normalizeImageUrl(uriResponse.data.image);
                        }
                    } catch (uriError) {
                        console.warn(`⚠️ Failed to fetch logo for ${mint}:`, uriError.message);
                    }
                }
                
                const tokenData = {
                    address: mint,
                    symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
                    name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
                    decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 6,
                    logoURI: logoURI
                };
                
                // Сохраняем в кеши
                this.tokenCache.set(mint, tokenData);
                await this.redis.setex(`token:${mint}`, this.TOKEN_CACHE_TTL, JSON.stringify(tokenData));
                
                console.log(`✅ Fetched metadata for ${tokenData.symbol} (${mint.slice(0, 8)}...)`);
                
                return tokenData;
            } else {
                console.warn(`⚠️ No metadata found for ${mint}`);
            }
        } catch (error) {
            this.stats.errors++;
            console.error(`❌ Error fetching metadata for ${mint}:`, error.message);
        }
    }

    // Нормализация URL изображения
    normalizeImageUrl(imageUrl) {
        if (!imageUrl) return null;
        
        if (imageUrl.startsWith('ipfs://')) {
            return imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }
        
        return imageUrl;
    }

    // Быстрое получение цены SOL
    async getSolPrice() {
        const cacheKey = 'solprice:current';
        const now = Date.now();
        
        // Проверяем локальный кеш
        if (this.priceCache.has(cacheKey)) {
            const cached = this.priceCache.get(cacheKey);
            if (now - cached.timestamp < this.PRICE_CACHE_TTL * 1000) {
                return cached.price;
            }
        }
        
        try {
            // Проверяем Redis кеш
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                const price = parseFloat(cached);
                this.priceCache.set(cacheKey, { price, timestamp: now });
                return price;
            }
        } catch (error) {
            console.warn('⚠️ Redis error getting SOL price:', error.message);
        }
        
        // Запускаем фоновое обновление цены
        setImmediate(() => this.updateSolPriceBackground());
        
        // Возвращаем последнюю известную цену или fallback
        const lastPrice = this.priceCache.get(cacheKey);
        return lastPrice ? lastPrice.price : 180; // fallback price
    }

    // Фоновое обновление цены SOL
    async updateSolPriceBackground() {
        try {
            console.log('💰 Updating SOL price...');
            
            const response = await axios.get(
                'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
                { timeout: 2000 }
            );
            
            if (response.data && response.data.price) {
                const price = parseFloat(response.data.price);
                const now = Date.now();
                
                // Обновляем локальный кеш
                this.priceCache.set('solprice:current', { price, timestamp: now });
                
                // Обновляем Redis кеш
                await this.redis.setex('solprice:current', this.PRICE_CACHE_TTL * 2, price.toString());
                
                console.log(`✅ Updated SOL price: ${price}`);
                return price;
            }
        } catch (error) {
            console.error('❌ Error updating SOL price:', error.message);
        }
    }

    // Получение исторической цены SOL (упрощенная версия)
    async getHistoricalSolPrice(timestamp) {
        // Для оптимизации используем текущую цену для недавних транзакций
        const now = Date.now();
        const txTime = new Date(timestamp).getTime();
        
        // Если транзакция не старше 1 часа, используем текущую цену
        if (now - txTime < 3600000) {
            return await this.getSolPrice();
        }
        
        // Для старых транзакций пытаемся получить из кеша или используем текущую цену
        const dateKey = new Date(timestamp).toISOString().slice(0, 13); // YYYY-MM-DDTHH
        const cacheKey = `solprice:${dateKey}`;
        
        try {
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return parseFloat(cached);
            }
        } catch (error) {
            console.warn('⚠️ Redis error for historical price:', error.message);
        }
        
        // Fallback: используем текущую цену
        const currentPrice = await this.getSolPrice();
        
        // Кешируем как историческую цену
        try {
            await this.redis.setex(cacheKey, 86400, currentPrice.toString());
        } catch (error) {
            console.warn('⚠️ Error caching historical price:', error.message);
        }
        
        return currentPrice;
    }

    // Предварительная загрузка популярных токенов
    async preloadPopularTokens() {
        const popularMints = [
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT  
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
            'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
            'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
        ];
        
        console.log('🔄 Preloading popular tokens...');
        
        for (const mint of popularMints) {
            this.tokenQueue.add(mint);
        }
        
        if (!this.processingTokens) {
            setImmediate(() => this.processTokenQueue());
        }
    }

    // Очистка кешей
    async clearCaches() {
        this.tokenCache.clear();
        this.priceCache.clear();
        
        try {
            const keys = await this.redis.keys('token:*');
            if (keys.length > 0) {
                await this.redis.del(...keys);
            }
            
            await this.redis.del('solprice:current');
            
            console.log('✅ Token service caches cleared');
        } catch (error) {
            console.error('❌ Error clearing caches:', error.message);
        }
    }

    // Получение статистики
    getStats() {
        return {
            ...this.stats,
            localTokenCache: this.tokenCache.size,
            localPriceCache: this.priceCache.size,
            queueSize: this.tokenQueue.size,
            processing: this.processingTokens
        };
    }

    // Закрытие сервиса
    async close() {
        console.log('⏹️ Closing Fast Token Service...');
        
        this.tokenQueue.clear();
        this.tokenCache.clear();
        this.priceCache.clear();
        
        await this.redis.quit();
        
        console.log('✅ Fast Token Service closed');
    }
}

// Создаем глобальный экземпляр
const fastTokenService = new FastTokenService();

// Запускаем предварительную загрузку
setTimeout(() => {
    fastTokenService.preloadPopularTokens();
    fastTokenService.updateSolPriceBackground();
}, 1000);

module.exports = {
    fastTokenService,
    
    // Экспортируем основные функции для совместимости
    async fetchTokenMetadata(mint) {
        return await fastTokenService.getTokenMetadata(mint);
    },
    
    async fetchHistoricalSolPrice(timestamp) {
        return await fastTokenService.getHistoricalSolPrice(timestamp);
    },
    
    async getSolPrice() {
        return await fastTokenService.getSolPrice();
    },
    
    normalizeImageUrl(imageUrl) {
        return fastTokenService.normalizeImageUrl(imageUrl);
    },
    
    // Redis instance для совместимости
    redis: fastTokenService.redis
};