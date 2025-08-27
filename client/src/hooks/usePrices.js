import { useState, useEffect, useRef, useCallback } from 'react';

// Global cache shared across all hook instances
const globalPriceCache = new Map();
const pendingRequests = new Map();

const CACHE_TTL = 30000; // 30 seconds
const BATCH_DELAY = 100; // 100ms delay for batching requests
const MAX_BATCH_SIZE = 50;

// Helper function to get auth headers
const getAuthHeaders = () => {
  const sessionToken = localStorage.getItem('sessionToken');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  };
};

// Enhanced batch queue for token price requests with metadata
let batchQueue = new Set();
let batchTimer = null;

const processBatch = async () => {
  if (batchQueue.size === 0) return;
  
  const mints = Array.from(batchQueue);
  batchQueue.clear();
  
  console.log(`[usePrices] Processing enhanced batch request for ${mints.length} tokens`);
  
  try {
    // Use the enhanced metadata endpoint
    const response = await fetch('/api/tokens/enhanced-metadata', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mints })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const responseData = await response.json();
    
    if (responseData.success && responseData.data) {
      const now = Date.now();
      
      // Cache all results with enhanced data
      Object.entries(responseData.data).forEach(([mint, enhancedData]) => {
        const priceData = {
          // Core price data
          price: enhancedData.price,
          change24h: enhancedData.change24h,
          volume24h: enhancedData.volume24h,
          liquidity: enhancedData.liquidity,
          marketCap: enhancedData.marketCap,
          
          // Token age data
          deployedAt: enhancedData.deployedAt,
          ageInHours: enhancedData.ageInHours,
          ageInDays: enhancedData.ageInDays,
          ageFormatted: enhancedData.ageFormatted,
          
          // Additional metadata
          symbol: enhancedData.symbol,
          name: enhancedData.name,
          pairAddress: enhancedData.pairAddress,
          dexId: enhancedData.dexId,
          
          // Data quality flags
          hasAgeData: enhancedData.hasAgeData,
          hasMarketData: enhancedData.hasMarketData,
          
          // Cache metadata
          lastUpdated: now,
          source: 'enhanced_api'
        };
        
        globalPriceCache.set(`token-${mint}`, {
          data: priceData,
          timestamp: now
        });
        
        // Resolve pending requests
        const pending = pendingRequests.get(mint);
        if (pending) {
          pending.forEach(({ resolve }) => resolve(priceData));
          pendingRequests.delete(mint);
        }
      });

      // Log summary of enhanced data
      const summary = responseData.summary;
      if (summary) {
        console.log(`[usePrices] Enhanced batch summary: ${summary.withAgeData}/${mints.length} with age data, ${summary.newTokens} new tokens, ${summary.highLiquidityRisk} high-risk liquidity`);
      }
    }
  } catch (error) {
    console.error('[usePrices] Enhanced batch request failed:', error);
    
    // Reject all pending requests for this batch
    mints.forEach(mint => {
      const pending = pendingRequests.get(mint);
      if (pending) {
        pending.forEach(({ reject }) => reject(error));
        pendingRequests.delete(mint);
      }
    });
  }
};

const queueTokenPrice = (mint) => {
  return new Promise((resolve, reject) => {
    // Add to pending requests
    if (!pendingRequests.has(mint)) {
      pendingRequests.set(mint, []);
    }
    pendingRequests.get(mint).push({ resolve, reject });
    
    // Add to batch queue
    batchQueue.add(mint);
    
    // Set batch timer
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    
    batchTimer = setTimeout(processBatch, BATCH_DELAY);
  });
};

export const useSolPrice = () => {
  const [solPrice, setSolPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchSolPrice = useCallback(async () => {
    // Check cache first
    const cached = globalPriceCache.get('sol-price');
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setSolPrice(cached.data);
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/solana/price', {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        const price = data.price;
        
        // Cache the result
        globalPriceCache.set('sol-price', {
          data: price,
          timestamp: Date.now()
        });

        if (isMountedRef.current) {
          setSolPrice(price);
        }
        return price;
      } else {
        throw new Error(data.error || 'Failed to fetch SOL price');
      }
    } catch (err) {
      console.error('[useSolPrice] Error:', err);
      if (isMountedRef.current) {
        setError(err.message);
        setSolPrice(150); // Fallback
      }
      return 150;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchSolPrice();
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchSolPrice]);

  return { solPrice, loading, error, refetch: fetchSolPrice };
};

export const useTokenPrice = (tokenMint) => {
  const [priceData, setPriceData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPrice = useCallback(async () => {
    if (!tokenMint) return null;

    // Check cache first
    const cached = globalPriceCache.get(`token-${tokenMint}`);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setPriceData(cached.data);
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await queueTokenPrice(tokenMint);
      
      if (isMountedRef.current) {
        setPriceData(result);
      }
      return result;
    } catch (err) {
      console.error(`[useTokenPrice] Error for ${tokenMint}:`, err);
      if (isMountedRef.current) {
        setError(err.message);
        setPriceData(null);
      }
      return null;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [tokenMint]);

  useEffect(() => {
    isMountedRef.current = true;
    if (tokenMint) {
      fetchTokenPrice();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [tokenMint, fetchTokenPrice]);

  return { priceData, loading, error, refetch: fetchTokenPrice };
};

// Enhanced hook for multiple token prices with metadata
export const useTokenPrices = (tokenMints) => {
  const [prices, setPrices] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPrices = useCallback(async () => {
    if (!tokenMints || tokenMints.length === 0) return;

    const now = Date.now();
    const cachedPrices = new Map();
    const uncachedMints = [];

    // Check cache for all mints
    tokenMints.forEach(mint => {
      const cached = globalPriceCache.get(`token-${mint}`);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        cachedPrices.set(mint, cached.data);
      } else {
        uncachedMints.push(mint);
      }
    });

    // Set cached prices immediately
    if (cachedPrices.size > 0 && isMountedRef.current) {
      setPrices(prev => new Map([...prev, ...cachedPrices]));
    }

    // Fetch uncached prices
    if (uncachedMints.length > 0) {
      setLoading(true);
      setError(null);

      try {
        const promises = uncachedMints.map(mint => queueTokenPrice(mint));
        const results = await Promise.all(promises);
        
        const newPrices = new Map();
        const enhancedMetadata = {
          withAgeData: 0,
          withMarketData: 0,
          averageAge: 0
        };

        let totalAgeHours = 0;
        let tokensWithAge = 0;

        uncachedMints.forEach((mint, index) => {
          const data = results[index];
          newPrices.set(mint, data);
          
          if (data) {
            if (data.hasAgeData) {
              enhancedMetadata.withAgeData++;
              if (data.ageInHours) {
                totalAgeHours += data.ageInHours;
                tokensWithAge++;
              }
            }
            if (data.hasMarketData) enhancedMetadata.withMarketData++;
          }
        });

        if (tokensWithAge > 0) {
          enhancedMetadata.averageAge = Math.round(totalAgeHours / tokensWithAge);
        }

        if (isMountedRef.current) {
          setPrices(prev => new Map([...prev, ...newPrices]));
          setMetadata(enhancedMetadata);
        }
      } catch (err) {
        console.error('[useTokenPrices] Error:', err);
        if (isMountedRef.current) {
          setError(err.message);
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    }
  }, [tokenMints]);

  useEffect(() => {
    isMountedRef.current = true;
    fetchTokenPrices();
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchTokenPrices]);

  return { prices, loading, error, metadata, refetch: fetchTokenPrices };
};

// Enhanced combined hook for both SOL and token price with metadata
export const usePrices = (tokenMint = null) => {
  const { solPrice, loading: solLoading, error: solError } = useSolPrice();
  const { priceData: tokenPrice, loading: tokenLoading, error: tokenError } = useTokenPrice(tokenMint);

  return {
    solPrice,
    tokenPrice,
    loading: solLoading || tokenLoading,
    error: solError || tokenError,
    ready: solPrice !== null && (!tokenMint || tokenPrice !== undefined)
  };
};