const { Connection, PublicKey } = require('@solana/web3.js');
const { getAccount, getMint } = require('@solana/spl-token');
const Redis = require('ioredis');
const { Liquidity, Token, TokenAmount } = require('@raydium-io/raydium-sdk');

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
    this.raydiumProgramId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
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

    this.monitorNewTokenPools();
  }

  async updateSolPriceInBackground() {
    try {
      const SOL_USDC_POOL = new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'); // Replace with actual SOL/USDC pool
      const price = await this.getPriceFromPool(SOL_USDC_POOL, true);
      this.solPriceCache = {
        price: price || 150,
        lastUpdated: Date.now(),
        cacheTimeout: 30000
      };
      await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
      console.log(`[${new Date().toISOString()}] ✅ Updated SOL price in background: $${price}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Failed to update SOL price:`, error.message);
    }
  }

  async getPriceFromPool(poolAddress, isBaseToken0) {
    try {
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys: { id: poolAddress, programId: this.raydiumProgramId }
      });
      
      const baseToken = new Token(poolInfo.baseMint, poolInfo.baseDecimals);
      const quoteToken = new Token(poolInfo.quoteMint, poolInfo.quoteDecimals);
      const baseReserve = new TokenAmount(baseToken, poolInfo.baseReserve.toString());
      const quoteReserve = new TokenAmount(quoteToken, poolInfo.quoteReserve.toString());

      const price = isBaseToken0
        ? quoteReserve.raw.toNumber() / baseReserve.raw.toNumber()
        : baseReserve.raw.toNumber() / quoteReserve.raw.toNumber();

      return price;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error fetching pool price for ${poolAddress.toString()}:`, error.message);
      return null;
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

      const SOL_USDC_POOL = new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
      const newPrice = await this.getPriceFromPool(SOL_USDC_POOL, true);
      this.solPriceCache = {
        price: newPrice || 150,
        lastUpdated: now,
        cacheTimeout: 30000
      };
      await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));
      return {
        success: true,
        price: newPrice || 150,
        source: 'fresh',
        lastUpdated: now
      };
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
      return {
        success: true,
        price: this.solPriceCache.price,
        source: 'fallback',
        lastUpdated: this.solPriceCache.lastUpdated,
        error: error.message
      };
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
            let priceData = await this.getTokenPriceData(mint);
            if (!priceData) {
              // Fallback to Dexscreener
              priceData = await this.getTokenPriceFromDexscreener(mint);
            }

            this.tokenPriceCache.set(mint, {
              data: priceData,
              timestamp: now
            });
            return { mint, data: priceData };
          } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${mint}:`, error.message);
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

  async getTokenPriceData(tokenMint) {
    try {
      const poolAddress = await this.findPoolForToken(tokenMint);
      if (!poolAddress) throw new Error(`No pool found for ${tokenMint}`);

      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys: { id: poolAddress, programId: this.raydiumProgramId }
      });

      const isBaseToken0 = poolInfo.baseMint.toString() === tokenMint;
      const price = await this.getPriceFromPool(poolAddress, isBaseToken0);
      const marketCap = await this.getMarketCap(tokenMint, price);
      const deploymentTime = await this.getTokenDeploymentTime(tokenMint);
      const liquidity = (poolInfo.baseReserve.toNumber() / Math.pow(10, poolInfo.baseDecimals)) * price +
                       (poolInfo.quoteReserve.toNumber() / Math.pow(10, poolInfo.quoteDecimals));

      return {
        price: price || 0,
        change24h: 0, // Requires historical data; implement if needed
        volume24h: 0, // Requires additional pool data; implement if needed
        liquidity,
        marketCap,
        deploymentTime
      };
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error fetching token data for ${tokenMint}:`, error.message);
      return null;
    }
  }

  async getTokenPriceFromDexscreener(tokenMint) {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
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
        return {
          price: parseFloat(bestPair.priceUsd || 0),
          change24h: parseFloat(bestPair.priceChange?.h24 || 0),
          volume24h: parseFloat(bestPair.volume?.h24 || 0),
          liquidity: parseFloat(bestPair.liquidity?.usd || 0),
          marketCap: 0, // Dexscreener doesn't provide this reliably
          deploymentTime: null
        };
      }
      return null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Dexscreener fallback failed for ${tokenMint}:`, error.message);
      return null;
    }
  }

  async findPoolForToken(tokenMint) {
    try {
      const filters = [
        { dataSize: 664 }, // Raydium AMM pool size
        {
          memcmp: {
            offset: 32, // Base or quote mint offset in pool data
            bytes: tokenMint
          }
        }
      ];
      const accounts = await this.connection.getProgramAccounts(this.raydiumProgramId, { filters });
      if (accounts.length === 0) return null;

      // Select pool with highest liquidity
      let bestPool = null;
      let maxLiquidity = 0;
      for (const account of accounts) {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys: { id: account.pubkey, programId: this.raydiumProgramId }
        });
        const liquidity = poolInfo.baseReserve.toNumber() + poolInfo.quoteReserve.toNumber();
        if (liquidity > maxLiquidity) {
          maxLiquidity = liquidity;
          bestPool = account.pubkey;
        }
      }
      return bestPool;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error finding pool for ${tokenMint}:`, error.message);
      return null;
    }
  }

  async getMarketCap(tokenMint, price) {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const mintInfo = await getMint(this.connection, mintPubkey);
      const totalSupply = mintInfo.supply.toNumber() / Math.pow(10, mintInfo.decimals);
      return totalSupply * (price || 0);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error fetching market cap for ${tokenMint}:`, error.message);
      return 0;
    }
  }

  async getTokenDeploymentTime(tokenMint) {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 });
      if (signatures.length === 0) return null;
      return new Date(signatures[0].blockTime * 1000).toISOString();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error fetching deployment time for ${tokenMint}:`, error.message);
      return null;
    }
  }

  async monitorNewTokenPools() {
    try {
      const subscriptionId = this.connection.onProgramAccountChange(
        this.raydiumProgramId,
        async (accountInfo) => {
          const poolAddress = accountInfo.accountId.toString();
          console.log(`[${new Date().toISOString()}] 🆕 New pool detected: ${poolAddress}`);
          try {
            const poolInfo = await Liquidity.fetchInfo({
              connection: this.connection,
              poolKeys: { id: accountInfo.accountId, programId: this.raydiumProgramId }
            });
            const tokenMint = poolInfo.baseMint.toString() !== 'So11111111111111111111111111111111111111112'
              ? poolInfo.baseMint.toString()
              : poolInfo.quoteMint.toString();
            const priceData = await this.getTokenPrices([tokenMint]);
            console.log(`[${new Date().toISOString()}] ✅ New token: ${tokenMint}`, priceData.get(tokenMint));
            await this.redis.lpush('new_tokens', JSON.stringify({
              mint: tokenMint,
              priceData: priceData.get(tokenMint),
              poolAddress,
              timestamp: Date.now()
            }));
          } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing new pool ${poolAddress}:`, error.message);
          }
        },
        'confirmed',
        [{ dataSize: 664 }]
      );
      console.log(`[${new Date().toISOString()}] 🔍 Monitoring Raydium pools with subscription ID: ${subscriptionId}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error setting up pool monitoring:`, error.message);
    }
  }

  cleanTokenPriceCache() {
    if (this.tokenPriceCache.size <= this.maxCacheSize) return;
    const now = Date.now();
    const entries = Array.from(this.tokenPriceCache.entries());
    const validEntries = entries.filter(([, value]) => (now - value.timestamp) < 300000);
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