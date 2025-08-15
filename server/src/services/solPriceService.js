// client/src/services/solPriceService.js

class SolPriceService {
    constructor() {
      this.solPrice = 100; // Начальная цена по умолчанию
      this.lastUpdated = null;
      this.updateInterval = 5 * 60 * 1000; // 5 минут
      this.isUpdating = false;
      
      // Запускаем обновление цены при создании сервиса
      this.updateSolPrice();
      
      // Устанавливаем интервал обновления
      setInterval(() => {
        this.updateSolPrice();
      }, this.updateInterval);
    }
  
    async updateSolPrice() {
      if (this.isUpdating) return;
      
      this.isUpdating = true;
      try {
        // Пробуем несколько источников для получения цены SOL
        const sources = [
          this.getCoinGeckoPrice.bind(this),
          this.getDexScreenerPrice.bind(this),
          this.getJupiterPrice.bind(this)
        ];
  
        for (const getPrice of sources) {
          try {
            const price = await getPrice();
            if (price && price > 0) {
              this.solPrice = price;
              this.lastUpdated = new Date();
              console.log(`SOL price updated: $${price.toFixed(2)}`);
              break;
            }
          } catch (error) {
            console.warn('Failed to get SOL price from source:', error.message);
          }
        }
      } catch (error) {
        console.error('Error updating SOL price:', error);
      } finally {
        this.isUpdating = false;
      }
    }
  
    async getCoinGeckoPrice() {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (!response.ok) throw new Error('CoinGecko API error');
      const data = await response.json();
      return data.solana?.usd;
    }
  
    async getDexScreenerPrice() {
      // SOL/USDC pair на Raydium
      const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
      if (!response.ok) throw new Error('DexScreener API error');
      const data = await response.json();
      
      if (data.pairs && data.pairs.length > 0) {
        // Берем пару с наибольшей ликвидностью
        const bestPair = data.pairs.reduce((best, current) => {
          const bestLiquidity = parseFloat(best.liquidity?.usd || 0);
          const currentLiquidity = parseFloat(current.liquidity?.usd || 0);
          return currentLiquidity > bestLiquidity ? current : best;
        });
        
        return parseFloat(bestPair.priceUsd);
      }
      
      return null;
    }
  
    async getJupiterPrice() {
      // Jupiter Price API
      const response = await fetch('https://price.jup.ag/v4/price?ids=SOL');
      if (!response.ok) throw new Error('Jupiter API error');
      const data = await response.json();
      return data.data?.SOL?.price;
    }
  
    getSolPrice() {
      return this.solPrice;
    }
  
    getLastUpdated() {
      return this.lastUpdated;
    }
  
    // Метод для конвертации USD в SOL
    usdToSol(usdAmount) {
      return usdAmount / this.solPrice;
    }
  
    // Метод для конвертации SOL в USD
    solToUsd(solAmount) {
      return solAmount * this.solPrice;
    }
  
    // Метод для расчета нереализованного PnL
    calculateUnrealizedPnL(tokenAmount, tokenPriceUSD, solSpent) {
      if (!tokenAmount || !tokenPriceUSD || tokenAmount <= 0) {
        return 0;
      }
      
      const currentValueUSD = tokenAmount * tokenPriceUSD;
      const currentValueSOL = this.usdToSol(currentValueUSD);
      return currentValueSOL - solSpent;
    }
  }
  
  // Создаем единственный экземпляр сервиса
  const solPriceService = new SolPriceService();
  
  export default solPriceService;