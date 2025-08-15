import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [useEnhanced, setUseEnhanced] = useState(true);

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

  // Функция для получения enhanced данных с сервера
  const fetchEnhancedTokens = async (hours, groupId) => {
    try {
      const url = `${API_BASE}/tokens/tracker/enhanced?hours=${hours}${groupId ? `&groupId=${groupId}` : ''}`;
      console.log('Fetching enhanced tokens from:', url);
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Enhanced API error: ${response.status}`);
      }
      
      const result = await response.json();
      console.log('Enhanced tokens response:', result);
      
      if (result.success && result.data) {
        return result.data;
      } else {
        throw new Error('Invalid response format');
      }
    } catch (error) {
      console.error('Error fetching enhanced tokens:', error);
      throw error;
    }
  };

  // Обновляем items при изменении transactions, hours или groupId
  useEffect(() => {
    const loadTokens = async () => {
      setLoading(true);
      setError(null);
      
      try {
        if (useEnhanced) {
          console.log('Loading enhanced tokens with prices...');
          const enhancedTokens = await fetchEnhancedTokens(hours, groupId);
          console.log('Enhanced tokens loaded:', enhancedTokens.length);
          setItems(enhancedTokens);
        } else {
          console.log('Using local aggregation...');
          const aggregatedTokens = aggregateTokens(transactions, hours, groupId);
          setItems(aggregatedTokens);
        }
      } catch (error) {
        console.error('Error loading tokens, falling back to local aggregation:', error);
        setError(`Enhanced mode failed: ${error.message}. Using local data.`);
        setUseEnhanced(false);
        try {
          const fallbackTokens = aggregateTokens(transactions, hours, groupId);
          setItems(fallbackTokens);
        } catch (fallbackError) {
          setError(`Failed to load token data: ${fallbackError.message}`);
        }
      } finally {
        setLoading(false);
      }
    };

    loadTokens();
  }, [hours, groupId, useEnhanced]); // Removed transactions dependency for enhanced mode

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

  const toggleMode = () => {
    setUseEnhanced(!useEnhanced);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-4">
          <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
          <button
            onClick={toggleMode}
            className={`text-xs px-2 py-1 rounded ${
              useEnhanced 
                ? 'bg-green-100 text-green-800' 
                : 'bg-gray-100 text-gray-800'
            }`}
            title={useEnhanced ? 'Using enhanced mode with live prices' : 'Using local aggregation'}
          >
            {useEnhanced ? '🟢 Enhanced' : '🔴 Basic'}
          </button>
        </div>
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
      
      {error && (
        <div className="mb-4 p-2 bg-yellow-100 border border-yellow-400 text-yellow-700 rounded text-sm">
          {error}
        </div>
      )}
      
      {loading ? (
        <div className="text-gray-500">Loading{useEnhanced ? ' enhanced data with prices' : ''}...</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500">No token data for selected group/timeframe</div>
      ) : (
        <div>
          <div className="mb-4 text-sm text-gray-600">
            Showing {items.length} tokens
            {useEnhanced && (
              <span className="ml-2">
                ({items.filter(t => t.priceData).length} with live prices)
              </span>
            )}
          </div>
          {items.map((token) => (
            <div key={token.mint} className="mb-4">
              <TokenCard 
                token={token} 
                onOpenChart={() => openGmgnChart(token.mint)}
                enhanced={useEnhanced}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;