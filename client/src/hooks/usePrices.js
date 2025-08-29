// client/src/hooks/usePrices.js - Updated for enhanced token data

import { useState, useEffect, useRef, useCallback } from 'react';

// Global cache shared across all hook instances
const globalTokenCache = new Map();
const pendingRequests = new Map();

const CACHE_TTL = 30000; // 30 seconds
const BATCH_DELAY = 100; // 100ms delay for batching requests
const MAX_BATCH_SIZE = 50; // Reduced for enhanced data

// Helper function to get auth headers
const getAuthHeaders = () => {
  const sessionToken = localStorage.getItem('sessionToken');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  };
};

// Batch queue for enhanced token data requests
let batchQueue = new Set();
let batchTimer = null;

const processBatch = async () => {
  if (batchQueue.size === 0) return;
  
  const mints = Array.from(batchQueue);
  batchQueue.clear();
  
  console.log(`[usePrices] Processing enhanced batch request for ${mints.length} tokens`);
  
  try {
    const response = await fetch('/api/tokens/batch-data', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mints })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.success && result.data) {
      const now = Date.now();
      
      // Cache all results
      Object.entries(result.data).forEach(([mint, tokenData]) => {
        globalTokenCache.set(`token-${mint}`, {
          data: tokenData,
          timestamp: now
        });
        
        // Resolve pending requests
        const pending = pendingRequests.get(mint);
        if (pending) {
          pending.forEach(({ resolve }) => resolve(tokenData));
          pendingRequests.delete(mint);
        }
      });
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

const queueEnhancedTokenData = (mint) => {
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
    const cached = globalTokenCache.get('sol-price');
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setSolPrice(cached.data.price);
      return cached.data.price;
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
        globalTokenCache.set('sol-price', {
          data: { price, ...data },
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

export const useEnhancedTokenData = (tokenMint) => {
  const [tokenData, setTokenData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenData = useCallback(async () => {
    if (!tokenMint) return null;

    // Check cache first
    const cached = globalTokenCache.get(`token-${tokenMint}`);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setTokenData(cached.data);
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await queueEnhancedTokenData(tokenMint);
      
      if (isMountedRef.current) {
        setTokenData(result);
      }
      return result;
    } catch (err) {
      console.error(`[useEnhancedTokenData] Error for ${tokenMint}:`, err);
      if (isMountedRef.current) {
        setError(err.message);
        setTokenData(null);
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
      fetchTokenData();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [tokenMint, fetchTokenData]);

  return { tokenData, loading, error, refetch: fetchTokenData };
};

// Legacy hook for backward compatibility - now uses enhanced data
export const useTokenPrice = (tokenMint) => {
  const { tokenData, loading, error, refetch } = useEnhancedTokenData(tokenMint);
  
  // Transform enhanced data to legacy format
  const priceData = tokenData ? {
    price: tokenData.price,
    change24h: tokenData.change24h || 0,
    volume24h: tokenData.volume24h || 0,
    liquidity: tokenData.liquidity || 0,
    marketCap: tokenData.marketCap,
    // Enhanced fields
    priceInSol: tokenData.priceInSol,
    pools: tokenData.pools,
    bestPool: tokenData.bestPool,
    ageInHours: tokenData.age?.ageInHours,
    isNew: tokenData.age?.isNew,
    symbol: tokenData.token?.symbol,
    name: tokenData.token?.name
  } : null;

  return { priceData, loading, error, refetch };
};

// Hook for multiple enhanced token data
export const useEnhancedTokenDataBatch = (tokenMints) => {
  const [tokenDataMap, setTokenDataMap] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchBatchTokenData = useCallback(async () => {
    if (!tokenMints || tokenMints.length === 0) return;

    const now = Date.now();
    const cachedData = new Map();
    const uncachedMints = [];

    // Check cache for all mints
    tokenMints.forEach(mint => {
      const cached = globalTokenCache.get(`token-${mint}`);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        cachedData.set(mint, cached.data);
      } else {
        uncachedMints.push(mint);
      }
    });

    // Set cached data immediately
    if (cachedData.size > 0 && isMountedRef.current) {
      setTokenDataMap(prev => new Map([...prev, ...cachedData]));
    }

    // Fetch uncached data
    if (uncachedMints.length > 0) {
      setLoading(true);
      setError(null);

      try {
        const promises = uncachedMints.map(mint => queueEnhancedTokenData(mint));
        const results = await Promise.all(promises);
        
        const newData = new Map();
        uncachedMints.forEach((mint, index) => {
          newData.set(mint, results[index]);
        });

        if (isMountedRef.current) {
          setTokenDataMap(prev => new Map([...prev, ...newData]));
        }
      } catch (err) {
        console.error('[useEnhancedTokenDataBatch] Error:', err);
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
    fetchBatchTokenData();
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchBatchTokenData]);

  return { tokenDataMap, loading, error, refetch: fetchBatchTokenData };
};

// Legacy hook for multiple token prices - now enhanced
export const useTokenPrices = (tokenMints) => {
  const { tokenDataMap, loading, error, refetch } = useEnhancedTokenDataBatch(tokenMints);
  
  // Transform to legacy format
  const prices = new Map();
  tokenDataMap.forEach((data, mint) => {
    if (data) {
      prices.set(mint, {
        price: data.price,
        change24h: 0,
        volume24h: data.volume24h || 0,
        liquidity: data.liquidity || 0
      });
    }
  });

  return { prices, loading, error, refetch };
};

// Combined hook for both SOL and enhanced token data
export const usePrices = (tokenMint = null) => {
  const { solPrice, loading: solLoading, error: solError } = useSolPrice();
  const { tokenData, loading: tokenLoading, error: tokenError } = useEnhancedTokenData(tokenMint);

  // Transform for backward compatibility
  const tokenPrice = tokenData ? {
    price: tokenData.price,
    change24h: 0,
    volume24h: tokenData.volume24h || 0,
    liquidity: tokenData.liquidity || 0,
    // Enhanced fields
    marketCap: tokenData.marketCap,
    priceInSol: tokenData.priceInSol,
    pools: tokenData.pools,
    ageInHours: tokenData.age?.ageInHours,
    isNew: tokenData.age?.isNew
  } : undefined;

  return {
    solPrice,
    tokenPrice,
    // Enhanced token data
    enhancedTokenData: tokenData,
    loading: solLoading || tokenLoading,
    error: solError || tokenError,
    ready: solPrice !== null && (!tokenMint || tokenPrice !== undefined)
  };
};