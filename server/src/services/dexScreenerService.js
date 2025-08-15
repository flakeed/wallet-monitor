// server/src/services/dexScreenerService.js
// Сервис для работы с API DexScreener

class DexScreenerService {
    constructor() {
      this.baseUrl = 'https://api.dexscreener.com/latest/dex';
      this.userAgent = 'WalletMonitor/1.0';
      this.rateLimit = {
        requests: 0,
        resetTime: Date.now() + 60000, // сброс через минуту
        maxRequests: 300 // 300 запросов в минуту
      };
    }
  
    // Проверка rate limit
    checkRateLimit() {
      const now = Date.now();
      if (now > this.rateLimit.resetTime) {
        this.rateLimit.requests = 0;
        this.rateLimit.resetTime = now + 60000;
      }
      
      if (this.rateLimit.requests >= this.rateLimit.maxRequests) {
        const waitTime = this.rateLimit.resetTime - now;
        throw new Error(`Rate limit exceeded. Wait ${Math.ceil(waitTime / 1000)} seconds`);
      }
      
      this.rateLimit.requests++;
    }
  
    // Базовый метод для запросов к API
    async makeRequest(endpoint, options = {}) {
      this.checkRateLimit();
      
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          ...options.headers
        },
        ...options
      });
  
      if (!response.ok) {
        throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
      }
  
      return response.json();
    }
  
    // Получение информации о токенах по mint адресам
    async getTokensByMints(mints) {
      const BATCH_SIZE = 30; // Лимит DexScreener
      const results = new Map();
      
      // Разбиваем на пакеты
      for (let i = 0; i < mints.length; i += BATCH_SIZE) {
        const batch = mints.slice(i, i + BATCH_SIZE);
        const mintList = batch.join(',');
        
        try {
          console.log(`[${new Date().toISOString()}] 🔍 Fetching DexScreener data for batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(mints.length/BATCH_SIZE)}`);
          
          const data = await this.makeRequest(`/tokens/${mintList}`);
          
          if (data.pairs) {
            // Группируем пары по токенам
            const tokenPairs = new Map();
            
            data.pairs.forEach(pair => {
              if (!pair.baseToken?.address || !pair.priceUsd) return;
              
              const mint = pair.baseToken.address;
              if (!batch.includes(mint)) return;
              
              // Вычисляем score для выбора лучшей пары
              const liquidity = parseFloat(pair.liquidity?.usd || 0);
              const volume24h = parseFloat(pair.volume?.h24 || 0);
              const fdv = parseFloat(pair.fdv || 0);
              const score = liquidity + (volume24h * 0.5) + (fdv * 0.1);
              
              const currentBest = tokenPairs.get(mint);
              if (!currentBest || score > currentBest.score) {
                tokenPairs.set(mint, {
                  mint,
                  symbol: pair.baseToken.symbol || 'UNKNOWN',
                  name: pair.baseToken.name || 'Unknown Token',
                  priceUsd: parseFloat(pair.priceUsd),
                  priceNative: parseFloat(pair.priceNative || 0),
                  liquidity: liquidity,
                  volume24h: volume24h,
                  fdv: fdv,
                  marketCap: parseFloat(pair.marketCap || 0),
                  priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
                  dexId: pair.dexId,
                  pairAddress: pair.pairAddress,
                  chainId: pair.chainId,
                  score
                });
              }
            });
            
            // Добавляем лучшие пары в результат
            tokenPairs.forEach((tokenData, mint) => {
              results.set(mint, tokenData);
            });
          }
          
          // Пауза между запросами для соблюдения rate limits
          if (i + BATCH_SIZE < mints.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error) {
          console.error(`Error fetching DexScreener data for batch starting at ${i}:`, error.message);
          // Продолжаем с следующим пакетом
          continue;
        }
      }
      
      return results;
    }
  
    // Получение цены SOL в USD
    async getSolPrice() {
      try {
        const data = await this.makeRequest('/tokens/So11111111111111111111111111111111111111112');
        
        if (data.pairs && data.pairs.length > 0) {
          // Находим лучшую пару SOL (обычно SOL/USDC)
          const bestPair = data.pairs.reduce((best, current) => {
            const currentLiquidity = parseFloat(current.liquidity?.usd || 0);
            const bestLiquidity = parseFloat(best.liquidity?.usd || 0);
            return currentLiquidity > bestLiquidity ? current : best;
          });
          
          return {
            priceUsd: parseFloat(bestPair.priceUsd),
            liquidity: parseFloat(bestPair.liquidity?.usd || 0),
            volume24h: parseFloat(bestPair.volume?.h24 || 0),
            priceChange24h: parseFloat(bestPair.priceChange?.h24 || 0)
          };
        }
        
        return null;
      } catch (error) {
        console.error('Error fetching SOL price from DexScreener:', error.message);
        return null;
      }
    }
  
    // Поиск токенов по символу или названию
    async searchTokens(query, limit = 10) {
      try {
        const data = await this.makeRequest(`/search?q=${encodeURIComponent(query)}`);
        
        if (data.pairs) {
          // Фильтруем и сортируем результаты
          const results = data.pairs
            .filter(pair => pair.chainId === 'solana' && pair.baseToken?.address)
            .map(pair => ({
              mint: pair.baseToken.address,
              symbol: pair.baseToken.symbol,
              name: pair.baseToken.name,
              priceUsd: parseFloat(pair.priceUsd || 0),
              liquidity: parseFloat(pair.liquidity?.usd || 0),
              volume24h: parseFloat(pair.volume?.h24 || 0),
              dexId: pair.dexId,
              pairAddress: pair.pairAddress
            }))
            .sort((a, b) => (b.liquidity + b.volume24h) - (a.liquidity + a.volume24h))
            .slice(0, limit);
          
          return results;
        }
        
        return [];
      } catch (error) {
        console.error('Error searching tokens on DexScreener:', error.message);
        return [];
      }
    }
  
    // Получение топ токенов по объему торгов
    async getTopTokens(timeframe = '24h', limit = 50) {
      try {
        // DexScreener не предоставляет прямой endpoint для топ токенов
        // Используем поиск популярных токенов
        const popularSymbols = ['BONK', 'WIF', 'BOME', 'SLERF', 'MOTHER', 'DADDY', 'POPCAT', 'MEW'];
        const results = [];
        
        for (const symbol of popularSymbols) {
          try {
            const tokens = await this.searchTokens(symbol, 5);
            results.push(...tokens);
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            console.warn(`Failed to fetch data for ${symbol}:`, error.message);
          }
        }
        
        // Сортируем по ликвидности и объему
        return results
          .sort((a, b) => (b.liquidity + b.volume24h) - (a.liquidity + a.volume24h))
          .slice(0, limit);
          
      } catch (error) {
        console.error('Error fetching top tokens from DexScreener:', error.message);
        return [];
      }
    }
  
    // Получение исторических данных по токену (ограниченно)
    async getTokenHistory(pairAddress, timeframe = '24h') {
      try {
        // DexScreener не предоставляет исторические данные через публичный API
        // Возвращаем только текущие данные пары
        const data = await this.makeRequest(`/pairs/solana/${pairAddress}`);
        
        if (data.pair) {
          return {
            pairAddress: data.pair.pairAddress,
            baseToken: data.pair.baseToken,
            quoteToken: data.pair.quoteToken,
            priceUsd: parseFloat(data.pair.priceUsd || 0),
            liquidity: parseFloat(data.pair.liquidity?.usd || 0),
            volume24h: parseFloat(data.pair.volume?.h24 || 0),
            priceChange24h: parseFloat(data.pair.priceChange?.h24 || 0),
            dexId: data.pair.dexId,
            url: data.pair.url
          };
        }
        
        return null;
      } catch (error) {
        console.error('Error fetching token history from DexScreener:', error.message);
        return null;
      }
    }
  
    // Получение данных для конкретной пары
    async getPairData(pairAddress) {
      try {
        const data = await this.makeRequest(`/pairs/solana/${pairAddress}`);
        return data.pair || null;
      } catch (error) {
        console.error(`Error fetching pair data for ${pairAddress}:`, error.message);
        return null;
      }
    }
  
    // Конвертация цен в SOL
    convertPricesToSol(tokensData, solPriceUsd) {
      const result = new Map();
      
      tokensData.forEach((tokenData, mint) => {
        const priceSol = tokenData.priceUsd / solPriceUsd;
        result.set(mint, {
          ...tokenData,
          priceSol,
          solPriceUsd
        });
      });
      
      return result;
    }
  
    // Основной метод для получения цен токенов в SOL
    async getTokenPricesInSol(mints) {
      try {
        // Получаем цену SOL
        const solPrice = await this.getSolPrice();
        const solPriceUsd = solPrice?.priceUsd || 150; // fallback
        
        console.log(`[${new Date().toISOString()}] 💰 SOL Price: ${solPriceUsd}`);
        
        // Получаем данные токенов
        const tokensData = await this.getTokensByMints(Array.from(mints));
        
        // Конвертируем цены в SOL
        const pricesInSol = new Map();
        tokensData.forEach((tokenData, mint) => {
          pricesInSol.set(mint, {
            priceUsd: tokenData.priceUsd,
            priceSol: tokenData.priceUsd / solPriceUsd,
            liquidity: tokenData.liquidity,
            volume24h: tokenData.volume24h,
            marketCap: tokenData.marketCap,
            priceChange24h: tokenData.priceChange24h,
            dexId: tokenData.dexId,
            pairAddress: tokenData.pairAddress,
            source: 'dexscreener'
          });
        });
        
        console.log(`[${new Date().toISOString()}] ✅ Retrieved prices for ${pricesInSol.size}/${mints.size} tokens`);
        return pricesInSol;
        
      } catch (error) {
        console.error('Error getting token prices in SOL:', error.message);
        return new Map();
      }
    }
  
    // Получение статистики использования API
    getApiStats() {
      return {
        requests: this.rateLimit.requests,
        maxRequests: this.rateLimit.maxRequests,
        resetTime: new Date(this.rateLimit.resetTime).toISOString(),
        remainingRequests: Math.max(0, this.rateLimit.maxRequests - this.rateLimit.requests)
      };
    }
  }
  
  module.exports = DexScreenerService;