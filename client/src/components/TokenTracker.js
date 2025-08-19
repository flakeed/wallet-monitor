import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('latest'); // новое состояние для сортировки

  // Функция для агрегации данных о токенах из транзакций
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
              latestActivity: null, // добавляем время последней активности
              firstBuyTime: null,   // время первой покупки
            },
          });
        }

        const tokenData = byToken.get(token.mint);
        const walletAddress = tx.wallet.address;
        const wallet = tokenData.wallets.find((w) => w.address === walletAddress);
        const txTime = new Date(tx.time);

        // Обновляем время последней активности и первой покупки
        if (!tokenData.summary.latestActivity || txTime > new Date(tokenData.summary.latestActivity)) {
          tokenData.summary.latestActivity = tx.time;
        }
        
        if (tx.transactionType === 'buy') {
          if (!tokenData.summary.firstBuyTime || txTime < new Date(tokenData.summary.firstBuyTime)) {
            tokenData.summary.firstBuyTime = tx.time;
          }
        }

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
            firstBuyTime: tx.transactionType === 'buy' ? tx.time : null, // время первой покупки кошелька
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
          
          // Обновляем время последней активности кошелька
          if (txTime > new Date(wallet.lastActivity)) {
            wallet.lastActivity = tx.time;
          }
          
          // Обновляем время первой покупки кошелька
          if (tx.transactionType === 'buy') {
            if (!wallet.firstBuyTime || txTime < new Date(wallet.firstBuyTime)) {
              wallet.firstBuyTime = tx.time;
            }
          }
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
      // Сортируем кошельки внутри токена по времени последней активности
      wallets: t.wallets.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    }));

    return result;
  };

  // Функция сортировки токенов
  const sortTokens = (tokens, sortBy) => {
    const sortedTokens = [...tokens];
    
    switch (sortBy) {
      case 'latest':
        // Сортировка по времени последней активности (самые свежие первыми)
        return sortedTokens.sort((a, b) => {
          const timeA = new Date(a.summary.latestActivity || 0);
          const timeB = new Date(b.summary.latestActivity || 0);
          return timeB - timeA;
        });
      
      case 'firstBuy':
        // Сортировка по времени первой покупки (самые свежие покупки первыми)
        return sortedTokens.sort((a, b) => {
          const timeA = new Date(a.summary.firstBuyTime || 0);
          const timeB = new Date(b.summary.firstBuyTime || 0);
          return timeB - timeA;
        });
      
      case 'profit':
        // Сортировка по прибыли (самые прибыльные первыми)
        return sortedTokens.sort((a, b) => b.summary.netSOL - a.summary.netSOL);
      
      case 'loss':
        // Сортировка по убыткам (самые убыточные первыми)
        return sortedTokens.sort((a, b) => a.summary.netSOL - b.summary.netSOL);
      
      case 'volume':
        // Сортировка по объему (абсолютное значение netSOL)
        return sortedTokens.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));
      
      case 'activity':
        // Сортировка по количеству транзакций
        return sortedTokens.sort((a, b) => 
          (b.summary.totalBuys + b.summary.totalSells) - (a.summary.totalBuys + a.summary.totalSells)
        );
      
      default:
        return sortedTokens;
    }
  };

  // Обновляем items при изменении transactions, hours, groupId или sortBy
  useEffect(() => {
    setLoading(true);
    try {
      const aggregatedTokens = aggregateTokens(transactions, hours, groupId);
      const sortedTokens = sortTokens(aggregatedTokens, sortBy);
      console.log('Aggregated and sorted tokens:', sortedTokens);
      setItems(sortedTokens);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transactions, hours, groupId, sortBy]);

  // Синхронизируем hours с timeframe из пропсов
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

  const formatTime = (timeString) => {
    if (!timeString) return 'N/A';
    const date = new Date(timeString);
    const now = new Date();
    const diffInMinutes = Math.floor((now - date) / (1000 * 60));
    
    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
    return `${Math.floor(diffInMinutes / 1440)}d ago`;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        <div className="flex items-center space-x-4">
          {/* Селектор сортировки */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="latest">Latest Activity</option>
              <option value="firstBuy">Recent Purchases</option>
              <option value="profit">Most Profitable</option>
              <option value="loss">Biggest Losses</option>
              <option value="volume">Highest Volume</option>
              <option value="activity">Most Active</option>
            </select>
          </div>
          
          {/* Селектор периода */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">Period:</span>
            <select
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="1">Last 1 hour</option>
              <option value="6">Last 6 hours</option>
              <option value="24">Last 24 hours</option>
            </select>
          </div>
        </div>
      </div>
      
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <span className="text-gray-500">Loading token data...</span>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-red-700 font-medium">Error loading data</div>
          <div className="text-red-600 text-sm mt-1">{error}</div>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} 
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <p className="text-gray-500 text-lg">No token activity found</p>
          <p className="text-sm text-gray-400 mt-1">
            No token transactions detected for the selected timeframe and group
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Показываем информацию о сортировке */}
          <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span>
                Showing {items.length} tokens sorted by{' '}
                <span className="font-medium">
                  {sortBy === 'latest' && 'Latest Activity'}
                  {sortBy === 'firstBuy' && 'Recent Purchases'}
                  {sortBy === 'profit' && 'Most Profitable'}
                  {sortBy === 'loss' && 'Biggest Losses'}
                  {sortBy === 'volume' && 'Highest Volume'}
                  {sortBy === 'activity' && 'Most Active'}
                </span>
              </span>
              {items.length > 0 && items[0].summary.latestActivity && (
                <span className="text-gray-500">
                  Latest: {formatTime(items[0].summary.latestActivity)}
                </span>
              )}
            </div>
          </div>

          {items.map((token) => (
            <div key={token.mint}>
              <TokenCard token={token} onOpenChart={() => openGmgnChart(token.mint)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;