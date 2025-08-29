const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const NodeCache = require('node-cache');
const Redis = require('ioredis');

// Initialize Solana connection with custom node
const connection = new Connection('http://45.134.108.254:50111', 'confirmed');

// Initialize Redis with the same URL as in your main application
const redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');

// Cache for token prices (TTL: 30 seconds)
const priceCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

// Supported DEXs
const DEXS = {
  RAYDIUM: 'raydium',
  ORCA: 'orca',
  METEORA: 'meteora',
  JUPITER: 'jupiter'
};

// Program IDs for DEXs
const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const ORCA_PROGRAM_ID = new PublicKey('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP');
const METEORA_PROGRAM_ID = new PublicKey('DLendnZuH1w3qhwk6zSzw6sBdsnR7U1Z2D4T3V7W85x1'); // Verify this ID for Meteora

class PriceService {
  // Fetch SOL price (in USD)
  async getSolPrice() {
    const cacheKey = 'solana-price';
    const redisKey = 'solana:price';

    // Check local cache first
    const cached = priceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check Redis cache
    try {
      const redisCached = await redis.get(redisKey);
      if (redisCached) {
        const priceData = JSON.parse(redisCached);
        priceCache.set(cacheKey, priceData);
        return priceData;
      }
    } catch (redisError) {
      console.error(`[PriceService] Error checking Redis cache for SOL price:`, redisError.message);
    }

    // Try Jupiter API
    try {
      const response = await axios.get('https://price.jup.ag/v4/price?ids=SOL', { timeout: 5000 });
      const data = response.data.data.SOL;

      if (!data || !data.price) {
        throw new Error('No price data found for SOL');
      }

      const priceData = {
        success: true,
        price: data.price,
        timestamp: new Date().toISOString()
      };

      // Cache in both local cache and Redis
      priceCache.set(cacheKey, priceData);
      try {
        await redis.set(redisKey, JSON.stringify(priceData), 'EX', 300); // 5-minute TTL
      } catch (redisError) {
        console.error(`[PriceService] Error caching SOL price in Redis:`, redisError.message);
      }
      return priceData;
    } catch (error) {
      console.error(`[PriceService] Error fetching SOL price from Jupiter:`, error.message);
      // Fallback to CoinGecko
      try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
        const data = response.data.solana;

        if (!data || !data.usd) {
          throw new Error('No price data found for SOL on CoinGecko');
        }

        const priceData = {
          success: true,
          price: data.usd,
          timestamp: new Date().toISOString()
        };

        priceCache.set(cacheKey, priceData);
        try {
          await redis.set(redisKey, JSON.stringify(priceData), 'EX', 300);
        } catch (redisError) {
          console.error(`[PriceService] Error caching SOL price in Redis:`, redisError.message);
        }
        return priceData;
      } catch (fallbackError) {
        console.error(`[PriceService] Error fetching SOL price from CoinGecko:`, fallbackError.message);
        // Fallback to cached Redis price if available
        try {
          const redisFallback = await redis.get(redisKey);
          if (redisFallback) {
            const priceData = JSON.parse(redisFallback);
            priceCache.set(cacheKey, priceData);
            return priceData;
          }
        } catch (redisError) {
          console.error(`[PriceService] Error fetching fallback SOL price from Redis:`, redisError.message);
        }
        return {
          success: false,
          price: null,
          timestamp: new Date().toISOString(),
          error: 'Failed to fetch SOL price from all sources'
        };
      }
    }
  }

  // Fetch token price from a specific DEX
  async fetchPriceFromDex(tokenMint, dex) {
    try {
      const mintKey = new PublicKey(tokenMint);
      let poolData;

      switch (dex) {
        case DEXS.RAYDIUM:
          poolData = await this.getRaydiumPoolData(mintKey);
          break;
        case DEXS.ORCA:
          poolData = await this.getOrcaPoolData(mintKey);
          break;
        case DEXS.METEORA:
          poolData = await this.getMeteoraPoolData(mintKey);
          break;
        default:
          throw new Error(`Unsupported DEX: ${dex}`);
      }

      if (!poolData) {
        throw new Error(`No liquidity pool found for ${tokenMint} on ${dex}`);
      }

      return {
        price: poolData.price,
        liquidity: poolData.liquidity,
        marketCap: poolData.marketCap,
        deployTime: poolData.deployTime,
        timeSinceDeployMs: Date.now() - new Date(poolData.deployTime).getTime()
      };
    } catch (error) {
      console.error(`[PriceService] Error fetching price from ${dex} for ${tokenMint}:`, error.message);
      throw error;
    }
  }

  // Fetch Raydium pool data
  async getRaydiumPoolData(mintKey) {
    try {
      const accounts = await connection.getProgramAccounts(RAYDIUM_PROGRAM_ID, {
        filters: [
          { dataSize: 560 }, // Raydium AMM pool account size
          { memcmp: { offset: 32, bytes: mintKey.toBase58() } }, // Token A mint
          { memcmp: { offset: 64, bytes: mintKey.toBase58() } }  // Token B mint
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      const { price, liquidity } = await this.calculatePoolPrice(poolAccount);
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
        liquidity,
        marketCap: price * totalSupply,
        deployTime
      };
    } catch (error) {
      console.error(`[PriceService] Error fetching Raydium pool for ${mintKey.toBase58()}:`, error.message);
      return null;
    }
  }

  // Fetch Orca pool data
  async getOrcaPoolData(mintKey) {
    try {
      const accounts = await connection.getProgramAccounts(ORCA_PROGRAM_ID, {
        filters: [
          { dataSize: 712 }, // Orca pool account size
          { memcmp: { offset: 8, bytes: mintKey.toBase58() } },  // Token A mint
          { memcmp: { offset: 40, bytes: mintKey.toBase58() } }  // Token B mint
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      const { price, liquidity } = await this.calculatePoolPrice(poolAccount);
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
        liquidity,
        marketCap: price * totalSupply,
        deployTime
      };
    } catch (error) {
      console.error(`[PriceService] Error fetching Orca pool for ${mintKey.toBase58()}:`, error.message);
      return null;
    }
  }

  // Fetch Meteora pool data
  async getMeteoraPoolData(mintKey) {
    try {
      const accounts = await connection.getProgramAccounts(METEORA_PROGRAM_ID, {
        filters: [
          { dataSize: 600 }, // Example Meteora pool account size (verify)
          { memcmp: { offset: 16, bytes: mintKey.toBase58() } } // Token mint (verify offset)
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      const { price, liquidity } = await this.calculatePoolPrice(poolAccount);
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
        liquidity,
        marketCap: price * totalSupply,
        deployTime
      };
    } catch (error) {
      console.error(`[PriceService] Error fetching Meteora pool for ${mintKey.toBase58()}:`, error.message);
      return null;
    }
  }

  // Placeholder for calculating price from pool data
  async calculatePoolPrice(poolAccount) {
    // TODO: Implement actual logic using DEX SDK (e.g., Raydium SDK, Orca SDK)
    // Example: price = (reserve_token_b / reserve_token_a) * solPrice
    // For now, return placeholder values
    return {
      price: 0.1234, // Placeholder
      liquidity: 100000 // Placeholder
    };
  }

  // Fetch price from Jupiter API as a fallback
  async fetchPriceFromJupiter(tokenMint) {
    try {
      const response = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenMint}`, { timeout: 5000 });
      const data = response.data.data[tokenMint];

      if (!data) {
        throw new Error(`No price data found for ${tokenMint}`);
      }

      const totalSupply = await this.getTokenSupply(tokenMint);
      const deployTime = await this.getTokenDeployTime(tokenMint);

      return {
        price: data.price,
        liquidity: data.liquidity || 0, // Jupiter may not provide liquidity
        marketCap: data.price * totalSupply,
        deployTime,
        timeSinceDeployMs: Date.now() - new Date(deployTime).getTime()
      };
    } catch (error) {
      console.error(`[PriceService] Error fetching price from Jupiter for ${tokenMint}:`, error.message);
      throw error;
    }
  }

  // Fetch token total supply
  async getTokenSupply(tokenMint) {
    try {
      const mintKey = new PublicKey(tokenMint);
      const mintInfo = await connection.getAccountInfo(mintKey);
      if (!mintInfo) {
        throw new Error(`Mint ${tokenMint} not found`);
      }
      // Parse supply from mint account data (SPL token layout)
      const supply = mintInfo.data.readBigUInt64LE(36); // Offset for supply in mint account
      return Number(supply) / 1e9; // Adjust for decimals (assuming 9 decimals)
    } catch (error) {
      console.error(`[PriceService] Error fetching token supply for ${tokenMint}:`, error.message);
      return 1_000_000_000; // Fallback supply
    }
  }

  // Fetch token deploy time
  async getTokenDeployTime(tokenMint) {
    try {
      const mintKey = new PublicKey(tokenMint);
      const signatures = await connection.getSignaturesForAddress(mintKey, { limit: 1 });
      if (signatures.length === 0) {
        return new Date().toISOString();
      }
      const tx = await connection.getTransaction(signatures[0].signature, { maxSupportedTransactionVersion: 0 });
      return new Date(tx.blockTime * 1000).toISOString();
    } catch (error) {
      console.error(`[PriceService] Error fetching deploy time for ${tokenMint}:`, error.message);
      return new Date().toISOString();
    }
  }

  // Main method to fetch token price
  async getTokenPrice(tokenMint) {
    const cacheKey = `price-${tokenMint}`;
    const redisKey = `token:price:${tokenMint}`;
    
    // Check local cache
    const cached = priceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Check Redis cache
    try {
      const redisCached = await redis.get(redisKey);
      if (redisCached) {
        const priceData = JSON.parse(redisCached);
        priceCache.set(cacheKey, priceData);
        return priceData;
      }
    } catch (redisError) {
      console.error(`[PriceService] Error checking Redis cache for ${tokenMint}:`, redisError.message);
    }

    const dexes = [DEXS.RAYDIUM, DEXS.ORCA, DEXS.METEORA];

    for (const dex of dexes) {
      try {
        const priceData = await this.fetchPriceFromDex(tokenMint, dex);
        priceCache.set(cacheKey, priceData);
        try {
          await redis.set(redisKey, JSON.stringify(priceData), 'EX', 300);
        } catch (redisError) {
          console.error(`[PriceService] Error caching price for ${tokenMint} in Redis:`, redisError.message);
        }
        return priceData;
      } catch (error) {
        console.warn(`[PriceService] Failed to fetch price from ${dex} for ${tokenMint}, trying next DEX`);
      }
    }

    // Fallback to Jupiter API
    try {
      const priceData = await this.fetchPriceFromJupiter(tokenMint);
      priceCache.set(cacheKey, priceData);
      try {
        await redis.set(redisKey, JSON.stringify(priceData), 'EX', 300);
      } catch (redisError) {
        console.error(`[PriceService] Error caching price for ${tokenMint} in Redis:`, redisError.message);
      }
      return priceData;
    } catch (error) {
      console.error(`[PriceService] All price sources failed for ${tokenMint}`);
      try {
        const redisFallback = await redis.get(redisKey);
        if (redisFallback) {
          const priceData = JSON.parse(redisFallback);
          priceCache.set(cacheKey, priceData);
          return priceData;
        }
      } catch (redisError) {
        console.error(`[PriceService] Error fetching fallback price from Redis for ${tokenMint}:`, redisError.message);
      }
      return {
        price: null,
        liquidity: null,
        marketCap: null,
        deployTime: null,
        timeSinceDeployMs: null,
        error: `All price sources failed for ${tokenMint}`
      };
    }
  }

  // Batch fetch token prices
  async getTokenPrices(tokenMints) {
    const results = new Map();
    const promises = tokenMints.map(async (mint) => {
      try {
        const priceData = await this.getTokenPrice(mint);
        results.set(mint, priceData);
      } catch (error) {
        results.set(mint, {
          price: null,
          liquidity: null,
          marketCap: null,
          deployTime: null,
          timeSinceDeployMs: null,
          error: error.message
        });
      }
    });

    await Promise.all(promises);
    return results;
  }

  // Get price service stats
  getStats() {
    return {
      totalRequests: priceCache.getStats().keys,
      cacheHits: priceCache.getStats().hits,
      cacheMisses: priceCache.getStats().misses,
      lastRequest: new Date().toISOString()
    };
  }
}

module.exports = new PriceService();