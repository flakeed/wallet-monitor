import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [portfolioStats, setPortfolioStats] = useState(null);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [useEnhanced, setUseEnhanced] = useState(true);
  const [solPrice, setSolPrice] = useState(null);

  // Функция для получения цены SOL
  const fetchSOLPrice = async () => {
    try {
      const response = await fetch(`${API_BASE}/sol/price`);
      if (response.ok) {
        const data = await response.json();
        setSolPrice(data.price);
      }
    } catch (error) {
      console.error('Error fetching SOL price:', error);
    }
  };

  // Функция для получения расширенных данных с API
  const fetchEnhancedData = async (hours, groupId) => {
    try {
      const url = `${API_BASE}/tokens/tracker-enhanced?hours=${hours}${groupId ? `&groupId=${groupId}` : ''}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error('Failed to fetch enhanced data');
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error fetching enhanced data:', error);
      throw error;
    }
  };

  // Функция для агрегации данных о токенах из транзакций (fallback)
  const aggregateTokens = (transactions, hours, groupId) => {
    const byToken = new Map();

    // Фильтруем транзакции по времени и groupId
    const now = new Date();
    const filteredTransactions = transactions.filter((tx) => {
      const txTime = new Date(tx.time);
      const hoursDiff = (now - txTime) / (1000 * 60 * 60);
      const matchesTimeframe = hoursDiff <= parseInt(hours);
      const matchesGroup = !groupId || tx.wallet.group_id === groupId;
      return matchesTimeframe && matchesGroup;
    });

    // Агрегируем данные по токенам
    filteredTransactions.forEach((tx) => {
      const tokens = tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold;
      if (!tokens || tokens.length === 0) return;

      tokens.forEach((token) => {
        if (!byToken.has(token.mint)) {
          byToken.set(token.mint, {
            mint: token.mint,
            symbol: token.symbol || 'Unknown',
            name: token.name || 'Unknown Token',
            decimals: token.decimals || 6,
            wallets: [],
            summary: {
              uniqueWallets: new Set(),
              totalBuys: 0,
              totalSells: 0,
              totalSpentSOL: 0,
              totalReceivedSOL: 0,
              netSOL: 0,
            },
          });
        }

        const tokenData = byToken.get(token.mint);
        const walletAddress = tx.wallet.address;
        const wallet = tokenData.wallets.find((w) => w.address === walletAddress);

        // Обновляем статистику кошелька
        if (!wallet) {
          tokenData.wallets.push({
            address: walletAddress,
            name: tx.wallet.name || null,
            groupId: tx.wallet.group_id,
            groupName: tx.wallet.group_name,
            txBuys: tx.transactionType === 'buy' ? 1 : 0,
            txSells: tx.transactionType === 'sell' ? 1 : 0,
            solSpent: tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0,
            solReceived: tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0,
            tokensBought: tx.transactionType === 'buy' ? token.amount || 0 : 0,
            tokensSold: tx.transactionType === 'sell' ? token.amount || 0 : 0,
            pnlSol: (tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0) - 
                    (tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0),
            lastActivity: tx.time,
          });
          tokenData.summary.uniqueWallets.add(walletAddress);
        } else {
          wallet.txBuys += tx.transactionType === 'buy' ? 1 : 0;
          wallet.txSells += tx.transactionType === 'sell' ? 1 : 0;
          wallet.solSpent += tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0;
          wallet.solReceived += tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0;
          wallet.tokensBought += tx.transactionType === 'buy' ? token.amount || 0 : 0;
          wallet.tokensSold += tx.transactionType === 'sell' ? token.amount || 0 : 0;
          wallet.pnlSol = wallet.solReceived - wallet.solSpent;
          wallet.lastActivity = tx.time > wallet.lastActivity ? tx.time : wallet.lastActivity;
        }

        // Обновляем summary
        tokenData.summary.totalBuys += tx.transactionType === 'buy' ? 1 : 0;
        tokenData.summary.totalSells += tx.transactionType === 'sell' ? 1 : 0;
        tokenData.summary.totalSpentSOL += tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0;
        tokenData.summary.totalReceivedSOL += tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0;
      });
    });

    // Формируем итоговый массив токенов
    const result = Array.from(byToken.values()).map((t) => ({
      ...t,
      summary: {
        ...t.summary,
        uniqueWallets: t.summary.uniqueWallets.size,
        netSOL: +(t.summary.totalReceivedSOL - t.summary.totalSpentSOL).toFixed(6),
      },
    }));

    // Сортируем по абсолютному значению netSOL
    result.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));

    return result;
  };

  // Основная функция загрузки данных
  const loadData = async (hours, groupId) => {
    setLoading(true);
    setError(null);
    
    try {
      if (useEnhanced) {
        // Пытаемся получить расширенные данные с сервера
        try {
          const enhancedData = await fetchEnhancedData(hours, groupId);
          setItems(enhancedData.tokens);
          setPortfolioStats(enhancedData.portfolio);
          console.log('Enhanced data loaded:', enhancedData);
        } catch (enhancedError) {
          console.warn('Enhanced data failed, falling back to local aggregation:', enhancedError);
          // Fallback к локальной агрегации
          const localData = aggregateTokens(transactions, hours, groupId);
          setItems(localData);
          setPortfolioStats(null);
        }
      } else {
        // Используем локальную агрегацию
        const localData = aggregateTokens(transactions, hours, groupId);
        setItems(localData);
        setPortfolioStats(null);
      }
    } catch (e) {
      setError(e.message);
      console.error('Error loading token tracker data:', e);
    } finally {
      setLoading(false);
    }
  };

  // Обновляем данные при изменении dependencies
  useEffect(() => {
    loadData(hours, groupId);
  }, [hours, groupId, useEnhanced]);

  // Загружаем данные при изменении транзакций (для fallback режима)
  useEffect(() => {
    if (!useEnhanced) {
      loadData(hours, groupId);
    }
  }, [transactions]);

  // Синхронизируем hours с timeframe из пропсов
  useEffect(() => {
    setHours(timeframe);
  }, [timeframe]);

  // Загружаем цену SOL
  useEffect(() => {
    fetchSOLPrice();
    const interval = setInterval(fetchSOLPrice, 5 * 60 * 1000); // Обновляем каждые 5 минут
    return () => clearInterval(interval);
  }, []);

  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.location.href = gmgnUrl;
  };

  const formatUSD = (solAmount) => {
    if (!solPrice || !solAmount) return 'N/A';
    return `$${(solAmount * solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        <div className="flex items-center space-x-3">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={useEnhanced}
              onChange={(e) => setUseEnhanced(e.target.checked)}
              className="rounded border-gray-300"
            />
            <span className="text-sm text-gray-600">Enhanced (with PnL)</span>
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
        </div>
      </div>

      {/* Portfolio Stats */}
      {portfolioStats && (
        <div className="mb-6 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border">
          <h4 className="text-lg font-semibold text-gray-900 mb-3">Portfolio Summary</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center">
              <div className={`text-2xl font-bold ${portfolioStats.totalRealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolioStats.totalRealizedPnL >= 0 ? '+' : ''}{portfolioStats.totalRealizedPnL.toFixed(4)} SOL
              </div>
              <div className="text-sm text-gray-600">Realized PnL</div>
              <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalRealizedPnL)}</div>
            </div>
            
            <div className="text-center">
              <div className={`text-2xl font-bold ${portfolioStats.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolioStats.totalUnrealizedPnL >= 0 ? '+' : ''}{portfolioStats.totalUnrealizedPnL.toFixed(4)} SOL
              </div>
              <div className="text-sm text-gray-600">Unrealized PnL</div>
              <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalUnrealizedPnL)}</div>
            </div>
            
            <div className="text-center">
              <div className={`text-2xl font-bold ${portfolioStats.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolioStats.totalPnL >= 0 ? '+' : ''}{portfolioStats.totalPnL.toFixed(4)} SOL
              </div>
              <div className="text-sm text-gray-600">Total PnL</div>
              <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalPnL)}</div>
            </div>
            
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {portfolioStats.totalSolSpent.toFixed(4)} SOL
              </div>
              <div className="text-sm text-gray-600">Total Invested</div>
              <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalSolSpent)}</div>
            </div>
          </div>
          
          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-600">
            <div className="text-center">
              <span className="font-medium">Current Value: </span>
              <span className="font-semibold">{portfolioStats.totalCurrentValue.toFixed(4)} SOL</span>
              <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalCurrentValue)}</div>
            </div>
            
            <div className="text-center">
              <span className="font-medium">Tokens with Price: </span>
              <span className="font-semibold">{portfolioStats.totalTokensWithPrice}/{portfolioStats.totalTokens}</span>
              <div className="text-xs text-gray-500">{(portfolioStats.priceDataCoverage * 100).toFixed(1)}% coverage</div>
            </div>
            
            {solPrice && (
              <div className="text-center">
                <span className="font-medium">SOL Price: </span>
                <span className="font-semibold">${solPrice.toFixed(2)}</span>
              </div>
            )}
            
            <div className="text-center">
              <span className="font-medium">ROI: </span>
              <span className={`font-semibold ${(portfolioStats.totalPnL / portfolioStats.totalSolSpent * 100) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolioStats.totalSolSpent > 0 ? (portfolioStats.totalPnL / portfolioStats.totalSolSpent * 100).toFixed(2) : '0.00'}%
              </span>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <span className="text-gray-500">Loading token data...</span>
        </div>
      ) : error ? (
        <div className="text-center py-8">
          <div className="text-red-600 mb-2">{error}</div>
          <button
            onClick={() => loadData(hours, groupId)}
            className="text-blue-600 hover:text-blue-700 text-sm"
          >
            Try Again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <p className="text-gray-500 text-lg">No token data available</p>
          <p className="text-sm text-gray-400 mt-1">
            {useEnhanced ? 
              'No tokens found for the selected group/timeframe' : 
              'No token transactions detected in the selected timeframe'
            }
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Фильтры и сортировка */}
          <div className="flex items-center justify-between bg-gray-50 p-3 rounded">
            <div className="text-sm text-gray-600">
              Showing {items.length} tokens
              {portfolioStats && (
                <span className="ml-2">
                  • {portfolioStats.totalTokensWithPrice} with price data
                </span>
              )}
            </div>
            
            {/* Refresh button */}
            <button
              onClick={() => loadData(hours, groupId)}
              disabled={loading}
              className="flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Refresh</span>
            </button>
          </div>

          {/* Token List */}
          {items.map((token) => (
            <div key={token.mint} className="mb-4">
              <TokenCard 
                token={token} 
                onOpenChart={() => openGmgnChart(token.mint)}
                enhanced={useEnhanced}
                solPrice={solPrice}
              />
            </div>
          ))}
        </div>
      )}
      
      {/* Footer Info */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div>
            {useEnhanced ? (
              <span>✨ Enhanced mode with live prices and PnL calculations</span>
            ) : (
              <span>📊 Basic mode using transaction data only</span>
            )}
          </div>
          
          <div className="flex items-center space-x-4">
            {solPrice && (
              <span>SOL: ${solPrice.toFixed(2)}</span>
            )}
            <span>Updated: {new Date().toLocaleTimeString()}</span>
          </div>
        </div>
        
        {useEnhanced && portfolioStats && (
          <div className="mt-2 text-xs text-gray-400">
            Price data coverage: {(portfolioStats.priceDataCoverage * 100).toFixed(1)}% 
            • Prices from DexScreener • Updates every minute
          </div>
        )}
      </div>
    </div>
  );
}

export default TokenTracker;