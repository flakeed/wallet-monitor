// client/src/hooks/useTokenPnL.js - Optimized PnL data hook

import { useState, useEffect, useCallback, useRef } from 'react';

export const useTokenPnL = (tokens, options = {}) => {
  const [pnlData, setPnlData] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  
  const abortControllerRef = useRef(null);
  const cacheRef = useRef(new Map());
  const pendingRequestRef = useRef(null);

  const {
    enableCaching = true,
    cacheTimeout = 30000, // 30 seconds
    batchTimeout = 100, // 100ms debounce
    maxRetries = 3
  } = options;

  // Helper function to get auth headers
  const getAuthHeaders = useCallback(() => {
    const sessionToken = localStorage.getItem('sessionToken');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    };
  }, []);

  // Check if data is cached and still valid
  const getCachedData = useCallback((tokenMint) => {
    if (!enableCaching) return null;
    
    const cached = cacheRef.current.get(tokenMint);
    if (cached && Date.now() - cached.timestamp < cacheTimeout) {
      return cached.data;
    }
    return null;
  }, [enableCaching, cacheTimeout]);

  // Cache PnL data
  const setCachedData = useCallback((tokenMint, data) => {
    if (!enableCaching) return;
    
    cacheRef.current.set(tokenMint, {
      data,
      timestamp: Date.now()
    });

    // Clean old cache entries
    if (cacheRef.current.size > 100) {
      const now = Date.now();
      for (const [mint, cached] of cacheRef.current.entries()) {
        if (now - cached.timestamp > cacheTimeout * 2) {
          cacheRef.current.delete(mint);
        }
      }
    }
  }, [enableCaching, cacheTimeout]);

  // Fetch PnL data for tokens
  const fetchPnLData = useCallback(async (tokensToFetch, retryCount = 0) => {
    if (!tokensToFetch || tokensToFetch.length === 0) return;

    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    setError(null);

    try {
      console.log(`[useTokenPnL] Fetching PnL for ${tokensToFetch.length} tokens`);
      const startTime = Date.now();

      const response = await fetch('/api/tokens/pnl', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ tokens: tokensToFetch }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Failed to fetch PnL data');
      }

      const duration = Date.now() - startTime;
      console.log(`[useTokenPnL] PnL data fetched in ${duration}ms: ${result.pnlData.length} tokens`);

      // Update state with new data
      const newPnlData = new Map(pnlData);
      
      result.pnlData.forEach(tokenPnL => {
        newPnlData.set(tokenPnL.mint, tokenPnL);
        setCachedData(tokenPnL.mint, tokenPnL);
      });

      setPnlData(newPnlData);
      setLastUpdate(Date.now());

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[useTokenPnL] Request aborted');
        return;
      }

      console.error('[useTokenPnL] Error fetching PnL data:', error);

      // Retry logic
      if (retryCount < maxRetries) {
        console.log(`[useTokenPnL] Retrying... (${retryCount + 1}/${maxRetries})`);
        setTimeout(() => {
          fetchPnLData(tokensToFetch, retryCount + 1);
        }, Math.pow(2, retryCount) * 1000); // Exponential backoff
        return;
      }

      setError(error.message);
    }
  }, [pnlData, getAuthHeaders, setCachedData, maxRetries]);

  // Debounced fetch function
  const debouncedFetch = useCallback((tokensToFetch) => {
    if (pendingRequestRef.current) {
      clearTimeout(pendingRequestRef.current);
    }

    pendingRequestRef.current = setTimeout(() => {
      setLoading(true);
      fetchPnLData(tokensToFetch).finally(() => {
        setLoading(false);
      });
    }, batchTimeout);
  }, [fetchPnLData, batchTimeout]);

  // Main effect to process tokens
  useEffect(() => {
    if (!tokens || tokens.length === 0) {
      setPnlData(new Map());
      return;
    }

    const tokensToFetch = [];
    const cachedResults = new Map();

    // Check cache first
    tokens.forEach(token => {
      if (!token.mint) return;

      const cached = getCachedData(token.mint);
      if (cached) {
        cachedResults.set(token.mint, cached);
      } else {
        tokensToFetch.push(token);
      }
    });

    // Update with cached data immediately
    if (cachedResults.size > 0) {
      setPnlData(prevData => {
        const newData = new Map(prevData);
        cachedResults.forEach((data, mint) => {
          newData.set(mint, data);
        });
        return newData;
      });
    }

    // Fetch missing data
    if (tokensToFetch.length > 0) {
      debouncedFetch(tokensToFetch);
    }

    // Cleanup
    return () => {
      if (pendingRequestRef.current) {
        clearTimeout(pendingRequestRef.current);
      }
    };
  }, [tokens, getCachedData, debouncedFetch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (pendingRequestRef.current) {
        clearTimeout(pendingRequestRef.current);
      }
    };
  }, []);

  // Get PnL data for a specific token
  const getTokenPnL = useCallback((mint) => {
    return pnlData.get(mint) || null;
  }, [pnlData]);

  // Refresh data manually
  const refresh = useCallback(() => {
    if (tokens && tokens.length > 0) {
      // Clear cache for these tokens
      tokens.forEach(token => {
        if (token.mint) {
          cacheRef.current.delete(token.mint);
        }
      });
      
      setLoading(true);
      fetchPnLData(tokens).finally(() => {
        setLoading(false);
      });
    }
  }, [tokens, fetchPnLData]);

  // Get cache statistics
  const getCacheStats = useCallback(() => {
    return {
      cacheSize: cacheRef.current.size,
      pnlDataSize: pnlData.size,
      lastUpdate,
      loading,
      error
    };
  }, [pnlData.size, lastUpdate, loading, error]);

  return {
    pnlData,
    loading,
    error,
    lastUpdate,
    getTokenPnL,
    refresh,
    getCacheStats
  };
};

export default useTokenPnL;