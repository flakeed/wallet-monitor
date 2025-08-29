// client/src/hooks/useEnhancedPrices.js - Обновленный хук для получения OnChain данных
import { useState, useEffect, useRef, useCallback } from 'react';

// Глобальный кэш для всех экземпляров хука
const globalPriceCache = new Map();
const pendingRequests = new Map();

const CACHE_TTL = 30000; // 30 секунд
const BATCH_DELAY = 100; // 100ms задержка для батчинга
const MAX_BATCH_SIZE = 50;

// Helper function to get auth headers
const getAuthHeaders = () => {
  const sessionToken = localStorage.getItem('sessionToken');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  };
};

// Очередь для батчинга запросов токенов
let batchQueue = new Set();
let batchTimer = null;

const processBatch = async () => {
  if (batchQueue.size === 0) return;
  
  const mints = Array.from(batchQueue);
  batchQueue.clear();
  
  console.log(`[Enhanced] Processing batch request for ${mints.length} tokens`);
  
  try {
    const response = await fetch('/api/tokens/prices/enhanced', {
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
      
      // Кэшировать все результаты
      Object.entries(data.prices).forEach(([mint, priceData]) => {
        globalPriceCache.set(`token-${mint}`, {
          data: priceData,
          timestamp: now,
          source: priceData?.source || 'enhanced'
        });
        
        // Разрешить ожидающие промисы
        const pending = pendingRequests.get(mint);
        if (pending) {
          pending.forEach(({ resolve }) => resolve(priceData));
          pendingRequests.delete(mint);
        }
      });

      // Логирование статистики
      if (data.stats) {
        console.log(`[Enhanced] Batch stats - OnChain: ${data.stats.onchain}, External: ${data.stats.external}, Cached: ${data.stats.cached}`);
      }
    }
  } catch (error) {
    console.error('[Enhanced] Batch request failed:', error);
    
    // Отклонить все ожидающие промисы
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
    // Добавить в ожидающие запросы
    if (!pendingRequests.has(mint)) {
      pendingRequests.set(mint, []);
    }
    pendingRequests.get(mint).push({ resolve, reject });
    
    // Добавить в очередь батчинга
    batchQueue.add(mint);
    
    // Установить таймер батчинга
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    
    batchTimer = setTimeout(processBatch, BATCH_DELAY);
  });
};

// Enhanced SOL Price Hook
export const useEnhancedSolPrice = () => {
  const [solPrice, setSolPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const isMountedRef = useRef(true);

  const fetchSolPrice = useCallback(async () => {
    // Проверить кэш
    const cached = globalPriceCache.get('sol-price-enhanced');
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setSolPrice(cached.data.price);
      setMetadata(cached.data);
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/solana/price/enhanced', {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        // Кэшировать результат
        globalPriceCache.set('sol-price-enhanced', {
          data: data,
          timestamp: Date.now()
        });

        if (isMountedRef.current) {
          setSolPrice(data.price);
          setMetadata({
            source: data.source,
            liquidity: data.liquidity,
            poolCount: data.poolCount,
            lastUpdated: data.lastUpdated,
            responseTime: data.responseTime
          });
        }
        return data;
      } else {
        throw new Error(data.error || 'Failed to fetch enhanced SOL price');
      }
    } catch (err) {
      console.error('[Enhanced SOL] Error:', err);
      if (isMountedRef.current) {
        setError(err.message);
        setSolPrice(150); // Fallback
      }
      return { price: 150, source: 'fallback' };
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

  return { 
    solPrice, 
    loading, 
    error, 
    metadata, 
    refetch: fetchSolPrice 
  };
};

// Enhanced Token Price Hook
export const useEnhancedTokenPrice = (tokenMint) => {
  const [priceData, setPriceData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPrice = useCallback(async () => {
    if (!tokenMint) return null;

    // Проверить кэш
    const cached = globalPriceCache.get(`token-${tokenMint}`);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setPriceData(cached.data);
      setMetadata({
        source: cached.source,
        timestamp: cached.timestamp,
        fromCache: true
      });
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await queueTokenPrice(tokenMint);
      
      if (isMountedRef.current) {
        setPriceData(result);
        setMetadata({
          source: result?.source || 'enhanced',
          timestamp: Date.now(),
          fromCache: false
        });
      }
      return result;
    } catch (err) {
      console.error(`[Enhanced Token] Error for ${tokenMint}:`, err);
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

  return { 
    priceData, 
    loading, 
    error, 
    metadata, 
    refetch: fetchTokenPrice 
  };
};

// Hook для получения полной информации о токене
export const useTokenInfo = (tokenMint) => {
  const [tokenInfo, setTokenInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenInfo = useCallback(async () => {
    if (!tokenMint) return null;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/${tokenMint}/info`, {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Token not found');
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        if (isMountedRef.current) {
          setTokenInfo(data.token);
        }
        return data.token;
      } else {
        throw new Error(data.error || 'Failed to fetch token info');
      }
    } catch (err) {
      console.error(`[Token Info] Error for ${tokenMint}:`, err);
      if (isMountedRef.current) {
        setError(err.message);
        setTokenInfo(null);
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
      fetchTokenInfo();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [tokenMint, fetchTokenInfo]);

  return { 
    tokenInfo, 
    loading, 
    error, 
    refetch: fetchTokenInfo 
  };
};

// Hook для получения пулов токена
export const useTokenPools = (tokenMint) => {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPools = useCallback(async () => {
    if (!tokenMint) return [];

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/${tokenMint}/pools`, {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        if (isMountedRef.current) {
          setPools(data.pools || []);
          setSummary(data.summary || null);
        }
        return data.pools || [];
      } else {
        throw new Error(data.error || 'Failed to fetch token pools');
      }
    } catch (err) {
      console.error(`[Token Pools] Error for ${tokenMint}:`, err);
      if (isMountedRef.current) {
        setError(err.message);
        setPools([]);
        setSummary(null);
      }
      return [];
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [tokenMint]);

  useEffect(() => {
    isMountedRef.current = true;
    if (tokenMint) {
      fetchTokenPools();
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [tokenMint, fetchTokenPools]);

  return { 
    pools, 
    summary, 
    loading, 
    error, 
    refetch: fetchTokenPools 
  };
};

// Hook для множественных цен токенов с enhanced функционалом
export const useEnhancedTokenPrices = (tokenMints) => {
  const [prices, setPrices] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPrices = useCallback(async () => {
    if (!tokenMints || tokenMints.length === 0) return new Map();

    const now = Date.now();
    const cachedPrices = new Map();
    const uncachedMints = [];

    // Проверить кэш для всех токенов
    tokenMints.forEach(mint => {
      const cached = globalPriceCache.get(`token-${mint}`);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        cachedPrices.set(mint, cached.data);
      } else {
        uncachedMints.push(mint);
      }
    });

    // Установить кэшированные цены сразу
    if (cachedPrices.size > 0 && isMountedRef.current) {
      setPrices(prev => new Map([...prev, ...cachedPrices]));
    }

    // Получить некэшированные цены
    if (uncachedMints.length > 0) {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch('/api/tokens/prices/enhanced', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ mints: uncachedMints })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        
        if (data.success) {
          const newPrices = new Map();
          
          Object.entries(data.prices).forEach(([mint, priceData]) => {
            newPrices.set(mint, priceData);
            
            // Кэшировать результат
            globalPriceCache.set(`token-${mint}`, {
              data: priceData,
              timestamp: now,
              source: priceData?.source || 'enhanced'
            });
          });

          if (isMountedRef.current) {
            setPrices(prev => new Map([...prev, ...newPrices]));
            setStats(data.stats);
          }
        } else {
          throw new Error(data.error || 'Failed to fetch enhanced token prices');
        }
      } catch (err) {
        console.error('[Enhanced Tokens] Error:', err);
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

  return { 
    prices, 
    loading, 
    error, 
    stats, 
    refetch: fetchTokenPrices 
  };
};

// Комбинированный hook для SOL и токенов с enhanced функционалом
export const useEnhancedPrices = (tokenMint = null) => {
  const { solPrice, loading: solLoading, error: solError, metadata: solMetadata } = useEnhancedSolPrice();
  const { priceData: tokenPrice, loading: tokenLoading, error: tokenError, metadata: tokenMetadata } = useEnhancedTokenPrice(tokenMint);

  return {
    solPrice,
    tokenPrice,
    loading: solLoading || tokenLoading,
    error: solError || tokenError,
    ready: solPrice !== null && (!tokenMint || tokenPrice !== undefined),
    metadata: {
      sol: solMetadata,
      token: tokenMetadata
    },
    isEnhanced: true // Флаг что используется enhanced версия
  };
};

// Utility функции для работы с кэшем
export const clearPriceCache = () => {
  globalPriceCache.clear();
  console.log('[Enhanced] Price cache cleared');
};

export const getPriceCacheStats = () => {
  const now = Date.now();
  const cacheEntries = Array.from(globalPriceCache.entries());
  
  const stats = {
    totalEntries: cacheEntries.length,
    validEntries: 0,
    expiredEntries: 0,
    sources: {
      onchain: 0,
      external: 0,
      cache: 0
    }
  };

  cacheEntries.forEach(([key, value]) => {
    const age = now - value.timestamp;
    
    if (age < CACHE_TTL) {
      stats.validEntries++;
    } else {
      stats.expiredEntries++;
    }

    if (value.source === 'onchain' || value.source === 'onchain_pools') {
      stats.sources.onchain++;
    } else if (value.source === 'memory_cache' || value.source === 'redis_cache') {
      stats.sources.cache++;
    } else {
      stats.sources.external++;
    }
  });

  return stats;
};

// Preload функция для предварительной загрузки популярных токенов
export const preloadTokenPrices = async (popularMints) => {
  if (!popularMints || popularMints.length === 0) return;

  try {
    console.log(`[Enhanced] Preloading ${popularMints.length} popular token prices`);
    
    const response = await fetch('/api/tokens/prices/enhanced', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mints: popularMints })
    });

    if (response.ok) {
      const data = await response.json();
      
      if (data.success && data.prices) {
        const now = Date.now();
        
        Object.entries(data.prices).forEach(([mint, priceData]) => {
          globalPriceCache.set(`token-${mint}`, {
            data: priceData,
            timestamp: now,
            source: priceData?.source || 'enhanced'
          });
        });

        console.log(`[Enhanced] Preloaded ${Object.keys(data.prices).length} token prices`);
        
        if (data.stats) {
          console.log(`[Enhanced] Preload stats - OnChain: ${data.stats.onchain}, External: ${data.stats.external}`);
        }
      }
    }
  } catch (error) {
    console.warn('[Enhanced] Preload failed:', error.message);
  }
};