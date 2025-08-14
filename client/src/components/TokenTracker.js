import React, { useState, useEffect, useRef } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [priceUpdates, setPriceUpdates] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const eventSourceRef = useRef(null);

  // Функция для получения данных с сервера
  const fetchTokenData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        hours,
        includePnL: 'true'
      });
      
      if (groupId) {
        params.append('groupId', groupId);
      }

      const response = await fetch(`/api/tokens/tracker?${params}`);
      if (!response.ok) {
        throw new Error('Failed to fetch token data');
      }

      const data = await response.json();
      console.log('Fetched token data with PnL:', data);
      setItems(data);
      setError(null);
    } catch (e) {
      console.error('Error fetching token data:', e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Подключение к real-time обновлениям цен
  useEffect(() => {
    if (!autoRefresh) return;

    // Подключаемся к SSE для получения обновлений цен
    const eventSource = new EventSource('/api/prices/stream');
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.prices) {
          setPriceUpdates(data.prices);
          console.log('Price updates received:', Object.keys(data.prices).length);
        }
      } catch (error) {
        console.error('Error parsing price update:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      eventSource.close();
      // Переподключаемся через 5 секунд
      setTimeout(() => {
        if (autoRefresh && eventSourceRef.current === eventSource) {
          console.log('Reconnecting to price stream...');
        }
      }, 5000);
    };

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [autoRefresh]);

  // Обновление данных при изменении цен
  useEffect(() => {
    if (Object.keys(priceUpdates).length === 0) return;

    // Обновляем PnL для токенов с новыми ценами
    setItems(prevItems => {
      return prevItems.map(token => {
        const priceUpdate = priceUpdates[token.mint];
        if (!priceUpdate) return token;

        // Пересчитываем unrealized PnL для каждого кошелька
        const updatedWallets = token.wallets.map(wallet => {
          const currentValueSOL = (wallet.remainingTokens || 0) * priceUpdate.priceInSOL;
          const unrealizedPnL = currentValueSOL - (wallet.solSpent - wallet.solReceived);
          const totalPnL = wallet.pnlSol + unrealizedPnL;
          const percentChange = wallet.solSpent > 0 ? ((unrealizedPnL / wallet.solSpent) * 100) : 0;

          return {
            ...wallet,
            currentValueSOL,
            unrealizedPnL,
            totalPnL,
            percentChange
          };
        });

        // Обновляем общую статистику
        const totalUnrealizedPnL = updatedWallets.reduce((sum, w) => sum + (w.unrealizedPnL || 0), 0);
        const totalCurrentValue = updatedWallets.reduce((sum, w) => sum + (w.currentValueSOL || 0), 0);

        return {
          ...token,
          currentPrice: priceUpdate,
          wallets: updatedWallets,
          summary: {
            ...token.summary,
            totalUnrealizedPnL,
            totalPnL: token.summary.netSOL + totalUnrealizedPnL,
            totalCurrentValueSOL: totalCurrentValue
          }
        };
      });
    });
  }, [priceUpdates]);

  // Загрузка данных при монтировании и изменении параметров
  useEffect(() => {
    fetchTokenData();
    
    // Обновляем данные каждые 30 секунд
    const interval = setInterval(() => {
      if (autoRefresh) {
        fetchTokenData();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [hours, groupId]);

  // Синхронизация с timeframe prop
  useEffect(() => {
    setHours(timeframe);
  }, [timeframe]);

  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.location.href = gmgnUrl;
  };

  // Сортировка по total PnL
  const sortedItems = [...items].sort((a, b) => {
    const aTotalPnL = a.summary.totalPnL || a.summary.netSOL || 0;
    const bTotalPnL = b.summary.totalPnL || b.summary.netSOL || 0;
    return Math.abs(bTotalPnL) - Math.abs(aTotalPnL);
  });

  // Расчет общей статистики
  const totalStats = items.reduce((acc, token) => ({
    totalRealizedPnL: acc.totalRealizedPnL + (token.summary.netSOL || 0),
    totalUnrealizedPnL: acc.totalUnrealizedPnL + (token.summary.totalUnrealizedPnL || 0),
    totalPnL: acc.totalPnL + (token.summary.totalPnL || token.summary.netSOL || 0),
    totalSpent: acc.totalSpent + (token.summary.totalSpentSOL || 0),
    totalCurrentValue: acc.totalCurrentValue + (token.summary.totalCurrentValueSOL || 0),
    tokenCount: acc.tokenCount + 1
  }), {
    totalRealizedPnL: 0,
    totalUnrealizedPnL: 0,
    totalPnL: 0,
    totalSpent: 0,
    totalCurrentValue: 0,
    tokenCount: 0
  });

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
          {loading && (
            <div className="flex items-center text-sm text-blue-600">
              <svg className="animate-spin h-4 w-4 mr-1" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Updating...
            </div>
          )}
        </div>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span>Auto-refresh</span>
          </label>
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            <option value="1">Last 1 hour</option>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
          </select>
          <button
            onClick={fetchTokenData}
            className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Overall Statistics */}
      {totalStats.tokenCount > 0 && (
        <div className="bg-gradient-to-r from-gray-50 to-blue-50 rounded-lg p-4 mb-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <div className="text-xs text-gray-500">Total Spent</div>
              <div className="text-sm font-bold text-gray-900">
                {totalStats.totalSpent.toFixed(4)} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Current Value</div>
              <div className="text-sm font-bold text-gray-900">
                {totalStats.totalCurrentValue.toFixed(4)} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Realized P&L</div>
              <div className={`text-sm font-bold ${totalStats.totalRealizedPnL >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {totalStats.totalRealizedPnL >= 0 ? '+' : ''}{totalStats.totalRealizedPnL.toFixed(4)} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Unrealized P&L</div>
              <div className={`text-sm font-bold ${totalStats.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {totalStats.totalUnrealizedPnL >= 0 ? '+' : ''}{totalStats.totalUnrealizedPnL.toFixed(4)} SOL
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Total P&L</div>
              <div className={`text-sm font-bold ${totalStats.totalPnL >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {totalStats.totalPnL >= 0 ? '+' : ''}{totalStats.totalPnL.toFixed(4)} SOL
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {/* Token List */}
      {loading && items.length === 0 ? (
        <div className="text-gray-500 text-center py-8">Loading token data...</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500 text-center py-8">No token data for selected group/timeframe</div>
      ) : (
        <div className="space-y-4">
          {sortedItems.map((token) => (
            <TokenCard 
              key={token.mint} 
              token={token} 
              onOpenChart={() => openGmgnChart(token.mint)} 
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;