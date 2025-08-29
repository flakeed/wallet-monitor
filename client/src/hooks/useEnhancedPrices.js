// client/src/hooks/useEnhancedPrices.js - Обновленные хуки для работы с пулами

import { useState, useEffect, useRef, useCallback } from 'react';

// Глобальный кэш цен с поддержкой источников
const globalPriceCache = new Map();
const pendingRequests = new Map();

const CACHE_TTL = 45000; // 45 секунд (меньше чем у сервера)
const BATCH_DELAY = 150; // Немного больше задержка для пулов
const MAX_BATCH_SIZE = 40; // Меньше размер батча для стабильности

// Helper function to get auth headers
const getAuthHeaders = () => {
  const sessionToken = localStorage.getItem('sessionToken');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${sessionToken}`
  };
};

// Обновленная очередь батчей с приоритетом
let batchQueue = new Set();
let priorityQueue = new Set(); // Для популярных токенов
let batchTimer = null;

const processBatch = async () => {
  if (batchQueue.size === 0 && priorityQueue.size === 0) return;
  
  // Сначала обрабатываем приоритетные токены
  const priorityMints = Array.from(priorityQueue);
  const regularMints = Array.from(batchQueue);
  
  // Комбинируем, приоритет идет первым
  const allMints = [...priorityMints, ...regularMints].slice(0, MAX_BATCH_SIZE);
  
  batchQueue.clear();
  priorityQueue.clear();
  
  console.log(`[usePrices] Processing enhanced batch: ${allMints.length} tokens (${priorityMints.length} priority)`);
  
  try {
    const response = await fetch('/api/tokens/prices', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ mints: allMints })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.prices) {
      const now = Date.now();
      
      // Кэшируем все результаты с метаданными источника
      Object.entries(data.prices).forEach(([mint, priceData]) => {
        const enhancedData = {
          ...priceData,
          source: priceData?.source || 'hybrid',
          fetchedAt: now,
          duration: data.duration
        };
        
        globalPriceCache.set(`token-${mint}`, {
          data: enhancedData,
          timestamp: now
        });
        
        // Разрешаем pending запросы
        const pending = pendingRequests.get(mint);
        if (pending) {
          pending.forEach(({ resolve }) => resolve(enhancedData));
          pendingRequests.delete(mint);
        }
      });
      
      console.log(`[usePrices] Enhanced batch completed: ${Object.keys(data.prices).length} prices updated (${data.duration}ms, ${data.source})`);
    }
  } catch (error) {
    console.error('[usePrices] Enhanced batch request failed:', error);
    
    // Отклоняем все pending запросы
    allMints.forEach(mint => {
      const pending = pendingRequests.get(mint);
      if (pending) {
        pending.forEach(({ reject }) => reject(error));
        pendingRequests.delete(mint);
      }
    });
  }
};

const queueTokenPrice = (mint, priority = false) => {
  return new Promise((resolve, reject) => {
    // Добавляем в pending запросы
    if (!pendingRequests.has(mint)) {
      pendingRequests.set(mint, []);
    }
    pendingRequests.get(mint).push({ resolve, reject });
    
    // Добавляем в соответствующую очередь
    if (priority) {
      priorityQueue.add(mint);
    } else {
      batchQueue.add(mint);
    }
    
    // Устанавливаем таймер
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    
    batchTimer = setTimeout(processBatch, BATCH_DELAY);
  });
};

// Список популярных токенов (получают приоритет)
const POPULAR_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
]);

// Улучшенный хук для цены SOL
export const useEnhancedSolPrice = () => {
  const [solPrice, setSolPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const isMountedRef = useRef(true);

  const fetchSolPrice = useCallback(async () => {
    // Проверяем кэш
    const cached = globalPriceCache.get('sol-price');
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setSolPrice(cached.data.price);
      setSource(cached.data.source);
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
        const enhancedData = {
          price: data.price,
          source: data.source,
          lastUpdated: data.lastUpdated
        };
        
        // Кэшируем результат
        globalPriceCache.set('sol-price', {
          data: enhancedData,
          timestamp: Date.now()
        });

        if (isMountedRef.current) {
          setSolPrice(enhancedData.price);
          setSource(enhancedData.source);
        }
        return enhancedData.price;
      } else {
        throw new Error(data.error || 'Failed to fetch SOL price');
      }
    } catch (err) {
      console.error('[useEnhancedSolPrice] Error:', err);
      if (isMountedRef.current) {
        setError(err.message);
        setSolPrice(150); // Fallback
        setSource('fallback');
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

  return { 
    solPrice, 
    loading, 
    error, 
    source, 
    refetch: fetchSolPrice 
  };
};

// Улучшенный хук для цены токена
export const useEnhancedTokenPrice = (tokenMint) => {
  const [priceData, setPriceData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const isMountedRef = useRef(true);

  const fetchTokenPrice = useCallback(async () => {
    if (!tokenMint) return null;

    // Проверяем кэш
    const cached = globalPriceCache.get(`token-${tokenMint}`);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      setPriceData(cached.data);
      setSource(cached.data.source);
      return cached.data;
    }

    setLoading(true);
    setError(null);

    try {
      const isPopular = POPULAR_TOKENS.has(tokenMint);
      const result = await queueTokenPrice(tokenMint, isPopular);
      
      if (isMountedRef.current) {
        setPriceData(result);
        setSource(result?.source);
      }
      return result;
    } catch (err) {
      console.error(`[useEnhancedTokenPrice] Error for ${tokenMint}:`, err);
      if (isMountedRef.current) {
        setError(err.message);
        setPriceData(null);
        setSource(null);
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
    source, 
    refetch: fetchTokenPrice 
  };
};

// Хук для получения лучшей цены токена (использует все источники)
export const useBestTokenPrice = (tokenMint) => {
  const [bestPrice, setBestPrice] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchBestPrice = useCallback(async () => {
    if (!tokenMint) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/price/${tokenMint}/best`, {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('No price data found for this token');
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        setBestPrice(data.price);
        setAlternatives(data.price.alternatives || []);
      }
    } catch (err) {
      console.error(`[useBestTokenPrice] Error for ${tokenMint}:`, err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tokenMint]);

  useEffect(() => {
    if (tokenMint) {
      fetchBestPrice();
    }
  }, [tokenMint, fetchBestPrice]);

  return { 
    bestPrice, 
    alternatives, 
    loading, 
    error, 
    refetch: fetchBestPrice 
  };
};

// Хук для множественных цен токенов с улучшениями
export const useEnhancedTokenPrices = (tokenMints) => {
  const [prices, setPrices] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sources, setSources] = useState(new Map());
  const isMountedRef = useRef(true);

  const fetchTokenPrices = useCallback(async () => {
    if (!tokenMints || tokenMints.length === 0) return;

    const now = Date.now();
    const cachedPrices = new Map();
    const cachedSources = new Map();
    const uncachedMints = [];

    // Проверяем кэш для всех токенов
    tokenMints.forEach(mint => {
      const cached = globalPriceCache.get(`token-${mint}`);
      if (cached && (now - cached.timestamp) < CACHE_TTL) {
        cachedPrices.set(mint, cached.data);
        cachedSources.set(mint, cached.data.source);
      } else {
        uncachedMints.push(mint);
      }
    });

    // Устанавливаем кэшированные цены сразу
    if (cachedPrices.size > 0 && isMountedRef.current) {
      setPrices(prev => new Map([...prev, ...cachedPrices]));
      setSources(prev => new Map([...prev, ...cachedSources]));
    }

    // Загружаем некэшированные цены
    if (uncachedMints.length > 0) {
      setLoading(true);
      setError(null);

      try {
        const promises = uncachedMints.map(mint => {
          const isPopular = POPULAR_TOKENS.has(mint);
          return queueTokenPrice(mint, isPopular);
        });
        const results = await Promise.all(promises);
        
        const newPrices = new Map();
        const newSources = new Map();
        uncachedMints.forEach((mint, index) => {
          if (results[index]) {
            newPrices.set(mint, results[index]);
            newSources.set(mint, results[index].source);
          }
        });

        if (isMountedRef.current) {
          setPrices(prev => new Map([...prev, ...newPrices]));
          setSources(prev => new Map([...prev, ...newSources]));
        }
      } catch (err) {
        console.error('[useEnhancedTokenPrices] Error:', err);
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
    sources,
    loading, 
    error, 
    refetch: fetchTokenPrices 
  };
};

// Комбинированный хук для SOL и токена
export const useEnhancedPrices = (tokenMint = null) => {
  const { solPrice, loading: solLoading, error: solError, source: solSource } = useEnhancedSolPrice();
  const { priceData: tokenPrice, loading: tokenLoading, error: tokenError, source: tokenSource } = useEnhancedTokenPrice(tokenMint);

  return {
    solPrice,
    tokenPrice,
    loading: solLoading || tokenLoading,
    error: solError || tokenError,
    ready: solPrice !== null && (!tokenMint || tokenPrice !== undefined),
    sources: {
      sol: solSource,
      token: tokenSource
    }
  };
};

// Хук для принудительного обновления цены
export const useRefreshTokenPrice = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refreshPrice = useCallback(async (tokenMint) => {
    if (!tokenMint) return null;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/price/${tokenMint}/refresh`, {
        method: 'POST',
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        // Обновляем кэш
        globalPriceCache.set(`token-${tokenMint}`, {
          data: data.price,
          timestamp: Date.now()
        });
        
        console.log(`[useRefreshTokenPrice] Price refreshed for ${tokenMint.slice(0,8)}... (${data.duration}ms)`);
        return data.price;
      }
    } catch (err) {
      console.error(`[useRefreshTokenPrice] Error for ${tokenMint}:`, err);
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { refreshPrice, loading, error };
};

// Хук для получения информации о пулах
export const useTokenPools = (tokenMint) => {
  const [pools, setPools] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPools = useCallback(async () => {
    if (!tokenMint) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/pools/${tokenMint}`, {
        headers: getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        setPools(data.pools);
      }
    } catch (err) {
      console.error(`[useTokenPools] Error for ${tokenMint}:`, err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tokenMint]);

  useEffect(() => {
    if (tokenMint) {
      fetchPools();
    }
  }, [tokenMint, fetchPools]);

  return { pools, loading, error, refetch: fetchPools };
};