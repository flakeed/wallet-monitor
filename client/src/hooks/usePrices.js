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

// Batch queue for token price requests
let batchQueue = new Set();
let batchTimer = null;

const processBatch = async () => {
  if (batchQueue.size === 0) return;
  
  const mints = Array.from(batchQueue);
  batchQueue.clear();
  
  console.log(`[usePrices] Processing batch request for ${mints.length} tokens`);
  
  try {
    const response = await fetch('/api/tokens/prices', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mints })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.prices) {
      const now = Date.now();
      
      // Cache all results
      Object.entries(data.prices).forEach(([mint, priceData]) => {
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
    }
  } catch (error) {
    console.error('[usePrices] Batch request failed:', error);
    
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

export const useTokenPrices = (tokenMints) => {
  const [prices, setPrices] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
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
        uncachedMints.forEach((mint, index) => {
          newPrices.set(mint, results[index]);
        });

        if (isMountedRef.current) {
          setPrices(prev => new Map([...prev, ...newPrices]));
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

  return { prices, loading, error, refetch: fetchTokenPrices };
};

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