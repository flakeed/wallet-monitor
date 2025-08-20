import React, { useState, useEffect, useRef } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('latest');
  const [newPurchases, setNewPurchases] = useState(new Set()); // Отслеживание новых покупок
  const [newPurchaseDetails, setNewPurchaseDetails] = useState(new Map()); // Детали новых покупок
  const previousTransactionsRef = useRef([]);

  const aggregateTokens = (transactions, hours, groupId) => {
    const EXCLUDED_TOKENS = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'So11111111111111111111111111111111111111112',  
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 
    ];

    const byToken = new Map();

    const now = new Date();
    // ИСПРАВЛЕНИЕ: сортируем транзакции по времени (новые сверху) ДО фильтрации
    const sortedTransactions = [...transactions].sort((a, b) => {
      const timeA = new Date(a.time);
      const timeB = new Date(b.time);
      return timeB - timeA; // Новые сверху
    });

    const filteredTransactions = sortedTransactions.filter((tx) => {
      const txTime = new Date(tx.time);
      const hoursDiff = (now - txTime) / (1000 * 60 * 60);
      const matchesTimeframe = hoursDiff <= parseInt(hours);
      const matchesGroup = !groupId || tx.wallet.group_id === groupId;
      return matchesTimeframe && matchesGroup;
    });

    console.log(`Processing ${filteredTransactions.length} filtered transactions (sorted by time DESC)`);

    filteredTransactions.forEach((tx) => {
      const tokens = tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold;
      if (!tokens || tokens.length === 0) return;

      tokens.forEach((token) => {
        if (EXCLUDED_TOKENS.includes(token.mint)) {
          console.log(`Excluding token ${token.symbol || token.mint} from tracker`);
          return;
        }

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
              latestActivity: null,
              firstBuyTime: null,  
            },
          });
        }

        const tokenData = byToken.get(token.mint);
        const walletAddress = tx.wallet.address;
        const wallet = tokenData.wallets.find((w) => w.address === walletAddress);
        const txTime = new Date(tx.time);

        // ИСПРАВЛЕНИЕ: правильно отслеживаем самую свежую активность
        if (!tokenData.summary.latestActivity || txTime > new Date(tokenData.summary.latestActivity)) {
          tokenData.summary.latestActivity = tx.time;
        }
        
        // ИСПРАВЛЕНИЕ: отслеживаем самую СВЕЖУЮ покупку (не первую по времени)
        if (tx.transactionType === 'buy') {
          if (!tokenData.summary.firstBuyTime || txTime > new Date(tokenData.summary.firstBuyTime)) {
            tokenData.summary.firstBuyTime = tx.time; // Переименуем в latestBuyTime
          }
        }

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
            firstBuyTime: tx.transactionType === 'buy' ? tx.time : null,
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
          
          if (txTime > new Date(wallet.lastActivity)) {
            wallet.lastActivity = tx.time;
          }
          
          // ИСПРАВЛЕНИЕ: обновляем время последней покупки
          if (tx.transactionType === 'buy') {
            if (!wallet.firstBuyTime || txTime > new Date(wallet.firstBuyTime)) {
              wallet.firstBuyTime = tx.time;
            }
          }
        }

        tokenData.summary.totalBuys += tx.transactionType === 'buy' ? 1 : 0;
        tokenData.summary.totalSells += tx.transactionType === 'sell' ? 1 : 0;
        tokenData.summary.totalSpentSOL += tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0;
        tokenData.summary.totalReceivedSOL += tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0;
      });
    });

    const result = Array.from(byToken.values()).map((t) => ({
      ...t,
      summary: {
        ...t.summary,
        uniqueWallets: t.summary.uniqueWallets.size,
        netSOL: +(t.summary.totalReceivedSOL - t.summary.totalSpentSOL).toFixed(6),
      },
      // ИСПРАВЛЕНИЕ: сортируем кошельки по времени последней активности (новые сверху)
      wallets: t.wallets.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
    }));

    console.log(`Aggregated ${result.length} unique tokens (excluded ${EXCLUDED_TOKENS.length} system tokens)`);

    return result;
  };

  // Функция для обнаружения новых покупок с деталями по кошелькам
  const detectNewPurchases = (currentTransactions, previousTransactions) => {
    const newPurchaseTokens = new Set();
    const newPurchaseDetails = new Map(); // Детали по токенам и кошелькам
    
    // Создаем Set из предыдущих транзакций для быстрого поиска
    const previousSignatures = new Set(previousTransactions.map(tx => tx.signature));
    
    // Находим новые buy транзакции
    currentTransactions.forEach(tx => {
      if (tx.transactionType === 'buy' && !previousSignatures.has(tx.signature)) {
        // Это новая покупка
        console.log(`🎉 New purchase detected: ${tx.signature} by wallet ${tx.wallet.address.slice(0, 8)}...`);
        
        if (tx.tokensBought && tx.tokensBought.length > 0) {
          tx.tokensBought.forEach(token => {
            newPurchaseTokens.add(token.mint);
            
            // Сохраняем детали покупки
            if (!newPurchaseDetails.has(token.mint)) {
              newPurchaseDetails.set(token.mint, {
                wallets: new Set(),
                latestPurchaseTime: tx.time
              });
            }
            
            const tokenDetails = newPurchaseDetails.get(token.mint);
            tokenDetails.wallets.add(tx.wallet.address);
            
            // Обновляем время последней покупки если эта новее
            if (new Date(tx.time) > new Date(tokenDetails.latestPurchaseTime)) {
              tokenDetails.latestPurchaseTime = tx.time;
            }
          });
        }
      }
    });
    
    return { tokens: newPurchaseTokens, details: newPurchaseDetails };
  };

  const sortTokens = (tokens, sortBy) => {
    const sortedTokens = [...tokens];
    
    switch (sortBy) {
      case 'latest':
        return sortedTokens.sort((a, b) => {
          const timeA = new Date(a.summary.latestActivity || 0);
          const timeB = new Date(b.summary.latestActivity || 0);
          return timeB - timeA; // Новые сверху
        });
      
      case 'firstBuy':
        // ИСПРАВЛЕНИЕ: переименовываем в 'recentPurchases' и сортируем по времени последней покупки
        return sortedTokens.sort((a, b) => {
          const timeA = new Date(a.summary.firstBuyTime || 0);
          const timeB = new Date(b.summary.firstBuyTime || 0);
          return timeB - timeA; // Самые свежие покупки сверху
        });
      
      case 'profit':
        return sortedTokens.sort((a, b) => b.summary.netSOL - a.summary.netSOL);
      
      case 'loss':
        return sortedTokens.sort((a, b) => a.summary.netSOL - b.summary.netSOL);
      
      case 'volume':
        return sortedTokens.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));
      
      case 'activity':
        return sortedTokens.sort((a, b) => 
          (b.summary.totalBuys + b.summary.totalSells) - (a.summary.totalBuys + a.summary.totalSells)
        );
      
      default:
        return sortedTokens;
    }
  };

  useEffect(() => {
    setLoading(true);
    try {
      // Обнаруживаем новые покупки
      const { tokens: newPurchaseTokens, details } = detectNewPurchases(transactions, previousTransactionsRef.current);
      setNewPurchases(newPurchaseTokens);
      setNewPurchaseDetails(details);
      
      // Обновляем ссылку на предыдущие транзакции
      previousTransactionsRef.current = [...transactions];
      
      // Агрегируем токены
      const aggregatedTokens = aggregateTokens(transactions, hours, groupId);
      const sortedTokens = sortTokens(aggregatedTokens, sortBy);
      console.log('Aggregated and sorted tokens:', sortedTokens);
      setItems(sortedTokens);
      setError(null);
      
      // Очищаем новые покупки через 8 секунд (чуть больше чем у кошельков)
      if (newPurchaseTokens.size > 0) {
        setTimeout(() => {
          setNewPurchases(new Set());
          setNewPurchaseDetails(new Map());
        }, 8000);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [transactions, hours, groupId, sortBy]);

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
        <div className="flex items-center space-x-3">
          <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
          {newPurchases.size > 0 && (
            <div className="flex items-center space-x-2 bg-green-100 text-green-800 px-3 py-1 rounded-full text-sm font-medium">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span>{newPurchases.size} new purchase{newPurchases.size > 1 ? 's' : ''}!</span>
            </div>
          )}
        </div>
        <div className="flex items-center space-x-4">
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
          {items.map((token) => {
            const tokenDetails = newPurchaseDetails.get(token.mint);
            return (
              <div key={token.mint}>
                <TokenCard 
                  token={token} 
                  onOpenChart={() => openGmgnChart(token.mint)}
                  isNewPurchase={newPurchases.has(token.mint)}
                  newPurchaseDetails={tokenDetails}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;