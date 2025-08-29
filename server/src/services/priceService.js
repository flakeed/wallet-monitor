const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const NodeCache = require('node-cache');

// Initialize Solana connection with custom node
const connection = new Connection('http://45.134.108.254:50111', 'confirmed');

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
const METEORA_PROGRAM_ID = new PublicKey('DLendnZuH1w3qhwk6zSzw6sBdsnR7U1Z2D4T3V7W85x1'); // Example Meteora program ID

class PriceService {
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
          { memcmp: { offset: 32, bytes: mintKey.toBase58() } } // Token A or B mint
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      // Placeholder: Parse pool data to extract price (use Raydium SDK for real implementation)
      const price = await this.calculatePoolPrice(poolAccount); // Implement actual logic
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
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
          { memcmp: { offset: 8, bytes: mintKey.toBase58() } } // Token A or B mint
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      const price = await this.calculatePoolPrice(poolAccount); // Implement actual logic
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
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
          { dataSize: 600 }, // Example Meteora pool account size
          { memcmp: { offset: 16, bytes: mintKey.toBase58() } } // Token mint
        ]
      });

      if (accounts.length === 0) {
        return null;
      }

      // Simplified: Assume first account is the pool
      const poolAccount = accounts[0];
      const price = await this.calculatePoolPrice(poolAccount); // Implement actual logic
      const totalSupply = await this.getTokenSupply(mintKey);
      const deployTime = await this.getTokenDeployTime(mintKey);

      return {
        price,
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
    // Implement actual logic to parse pool reserves and calculate price
    // Example: price = (reserve_token_b / reserve_token_a) * solPrice
    return 0.1234; // Placeholder
  }

  // Fetch price from Jupiter API as a fallback
  async fetchPriceFromJupiter(tokenMint) {
    try {
      const response = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenMint}`);
      const data = response.data.data[tokenMint];

      if (!data) {
        throw new Error(`No price data found for ${tokenMint}`);
      }

      const totalSupply = await this.getTokenSupply(tokenMint);
      const deployTime = await this.getTokenDeployTime(tokenMint);

      return {
        price: data.price,
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
    const cached = priceCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const dexes = [DEXS.RAYDIUM, DEXS.ORCA, DEXS.METEORA];

    for (const dex of dexes) {
      try {
        const priceData = await this.fetchPriceFromDex(tokenMint, dex);
        priceCache.set(cacheKey, priceData);
        return priceData;
      } catch (error) {
        console.warn(`[PriceService] Failed to fetch price from ${dex} for ${tokenMint}, trying next DEX`);
      }
    }

    // Fallback to Jupiter API
    try {
      const priceData = await this.fetchPriceFromJupiter(tokenMint);
      priceCache.set(cacheKey, priceData);
      return priceData;
    } catch (error) {
      console.error(`[PriceService] All price sources failed for ${tokenMint}`);
      return {
        price: null,
        marketCap: null,
        deployTime: null,
        timeSinceDeployMs: null
      };
    }
  }

  // Batch fetch token prices
  async getTokenPrices(tokenMints) {
    const results = {};
    const promises = tokenMints.map(async (mint) => {
      try {
        const priceData = await this.getTokenPrice(mint);
        results[mint] = priceData;
      } catch (error) {
        results[mint] = {
          price: null,
          marketCap: null,
          deployTime: null,
          timeSinceDeployMs: null
        };
      }
    });

    await Promise.all(promises);
    return { success: true, prices: results };
  }
}

module.exports = new PriceService();