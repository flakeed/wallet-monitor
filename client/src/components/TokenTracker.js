import React, { useState, useEffect, useCallback } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, timeframe = '24', transactions }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tokenPrices, setTokenPrices] = useState({});

  const fetchTokenData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/tracker?hours=${hours}${groupId ? `&groupId=${groupId}` : ''}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch token data: ${response.statusText}`);
      }

      const responseData = await response.json();
      console.log('Fetched token data:', responseData);

      if (!responseData || typeof responseData !== 'object') {
        throw new Error('Invalid API response: response is not an object');
      }

      if (!responseData.success) {
        throw new Error(`API error: ${responseData.message || 'Request failed'}`);
      }

      if (!Array.isArray(responseData.data)) {
        console.error('Invalid API response: data is not an array', responseData.data);
        throw new Error('Invalid API response: data is not an array');
      }

      const data = responseData.data;
      setItems(data);

      // Fetch prices for tokens with remaining balance
      const mintsWithBalance = data.filter(token => token?.summary?.totalTokensRemaining > 0);
      if (mintsWithBalance.length > 0) {
        try {
          const priceResponse = await fetch(`/api/tokens/price/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mints: mintsWithBalance.map(token => token.mint) }),
          });
          if (!priceResponse.ok) {
            throw new Error(`Failed to fetch token prices: ${priceResponse.statusText}`);
          }
          const priceData = await priceResponse.json();
          const prices = {};
          Object.entries(priceData.data || {}).forEach(([mint, priceData]) => {
            prices[mint] = priceData?.priceNative || null;
          });
          setTokenPrices(prices);
        } catch (e) {
          console.error('Error fetching token prices:', e);
        }
      }
    } catch (e) {
      console.error('Error fetching token data:', e);
      setError(e.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [hours, groupId]);

  // Обновление items на основе новых транзакций
  useEffect(() => {
    if (!transactions || transactions.length === 0) return;

    setItems((prevItems) => {
      const updatedItems = [...prevItems];

      transactions.forEach((tx) => {
        if (!tx.tokensBought?.length && !tx.tokensSold?.length) return;

        const tokens = tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold;
        tokens.forEach((token) => {
          const mint = token.mint;
          const tokenAmount = token.amount;
          const solAmount = parseFloat(tx.solSpent || tx.solReceived || 0);

          let tokenIndex = updatedItems.findIndex((item) => item.mint === mint);
          if (tokenIndex === -1) {
            // Новый токен
            updatedItems.push({
              mint,
              symbol: token.symbol || 'Unknown',
              name: token.name || 'Unknown Token',
              wallets: [],
              summary: {
                totalBuys: 0,
                totalSells: 0,
                totalSpentSOL: 0,
                totalReceivedSOL: 0,
                totalTokensRemaining: 0,
                uniqueWallets: 0,
                netSOL: 0,
                avgBuyPrice: 0,
              },
            });
            tokenIndex = updatedItems.length - 1;
          }

          const tokenData = updatedItems[tokenIndex];
          const walletIndex = tokenData.wallets.findIndex((w) => w.address === tx.wallet.address);

          if (walletIndex === -1) {
            // Новый кошелек
            tokenData.wallets.push({
              address: tx.wallet.address,
              name: tx.wallet.name || null,
              tokensBought: 0,
              tokensSold: 0,
              tokensRemaining: 0,
              solSpent: 0,
              solReceived: 0,
              txBuys: 0,
              txSells: 0,
              avgBuyPrice: 0,
              avgSellPrice: 0,
              pnlSol: 0,
            });
          }

          const wallet = tokenData.wallets[walletIndex === -1 ? tokenData.wallets.length - 1 : walletIndex];

          if (tx.transactionType === 'buy') {
            wallet.tokensBought = (wallet.tokensBought || 0) + tokenAmount;
            wallet.solSpent = (wallet.solSpent || 0) + solAmount;
            wallet.txBuys = (wallet.txBuys || 0) + 1;
            tokenData.summary.totalBuys = (tokenData.summary.totalBuys || 0) + 1;
            tokenData.summary.totalSpentSOL = (tokenData.summary.totalSpentSOL || 0) + solAmount;
            // Обновляем среднюю цену покупки
            const totalTokensBought = wallet.tokensBought;
            wallet.avgBuyPrice = totalTokensBought
              ? ((wallet.avgBuyPrice || 0) * (totalTokensBought - tokenAmount) + solAmount) / totalTokensBought
              : solAmount / tokenAmount;
          } else if (tx.transactionType === 'sell') {
            wallet.tokensSold = (wallet.tokensSold || 0) + tokenAmount;
            wallet.solReceived = (wallet.solReceived || 0) + solAmount;
            wallet.txSells = (wallet.txSells || 0) + 1;
            tokenData.summary.totalSells = (tokenData.summary.totalSells || 0) + 1;
            tokenData.summary.totalReceivedSOL = (tokenData.summary.totalReceivedSOL || 0) + solAmount;
            // Обновляем среднюю цену продажи
            const totalTokensSold = wallet.tokensSold;
            wallet.avgSellPrice = totalTokensSold
              ? ((wallet.avgSellPrice || 0) * (totalTokensSold - tokenAmount) + solAmount) / totalTokensSold
              : solAmount / tokenAmount;
          }

          wallet.tokensRemaining = wallet.tokensBought - wallet.tokensSold;
          wallet.pnlSol = wallet.solReceived - wallet.solSpent;
          tokenData.summary.totalTokensRemaining = tokenData.wallets.reduce(
            (sum, w) => sum + (w.tokensRemaining || 0),
            0
          );
          tokenData.summary.netSOL = tokenData.summary.totalReceivedSOL - tokenData.summary.totalSpentSOL;
          tokenData.summary.uniqueWallets = tokenData.wallets.length;

          // Обновляем среднюю цену покупки для токена
          tokenData.summary.avgBuyPrice = tokenData.summary.totalBuys
            ? tokenData.summary.totalSpentSOL / tokenData.wallets.reduce((sum, w) => sum + (w.tokensBought || 0), 0)
            : 0;
        });
      });

      return updatedItems;
    });

    // Обновляем цены для новых токенов
    const mintsWithBalance = transactions
      .flatMap((tx) => (tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold) || [])
      .map((token) => token.mint)
      .filter((mint, index, self) => self.indexOf(mint) === index && mint);

    if (mintsWithBalance.length > 0) {
      fetch(`/api/tokens/price/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mints: mintsWithBalance }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch token prices: ${res.statusText}`);
          return res.json();
        })
        .then((priceData) => {
          const prices = {};
          Object.entries(priceData.data || {}).forEach(([mint, priceData]) => {
            prices[mint] = priceData?.priceNative || null;
          });
          setTokenPrices((prev) => ({ ...prev, ...prices }));
        })
        .catch((e) => console.error('Error fetching token prices for new transactions:', e));
    }
  }, [transactions, groupId]);

  useEffect(() => {
    fetchTokenData();
  }, [fetchTokenData]);

  // Остальная часть кода остается без изменений
  const calculateUnrealizedPnL = (token, currentPrice) => {
    if (!currentPrice || token.summary.totalTokensRemaining <= 0) {
      return 0;
    }
    const currentValue = currentPrice * token.summary.totalTokensRemaining;
    const avgCostBasis = token.summary.avgBuyPrice * token.summary.totalTokensRemaining;
    return currentValue - avgCostBasis;
  };

  console.log('Items before mapping:', items);
  const enhancedItems = Array.isArray(items)
    ? items.map((token) => {
        if (!token || !token.mint || !token.wallets || !token.summary) {
          console.warn('Invalid token data:', token);
          return null;
        }

        const currentPrice = tokenPrices[token.mint];
        const unrealizedPnl = calculateUnrealizedPnL(token, currentPrice);

        const enhancedWallets = Array.isArray(token.wallets)
          ? token.wallets.map((wallet) => {
              if (!wallet || typeof wallet !== 'object') {
                console.warn('Invalid wallet data:', wallet);
                return null;
              }
              const walletUnrealizedPnl = currentPrice && wallet.tokensRemaining > 0
                ? (currentPrice * wallet.tokensRemaining) - (wallet.avgBuyPrice * wallet.tokensRemaining)
                : 0;

              return {
                ...wallet,
                unrealizedPnl: walletUnrealizedPnl,
                totalPnl: wallet.pnlSol + walletUnrealizedPnl,
              };
            }).filter((wallet) => wallet !== null)
          : [];

        return {
          ...token,
          wallets: enhancedWallets,
          currentPrice,
          summary: {
            ...token.summary,
            unrealizedPnl,
            totalPnl: token.summary.netSOL + unrealizedPnl,
          },
        };
      }).filter((token) => token !== null)
    : [];

  useEffect(() => {
    setHours(timeframe);
  }, [timeframe]);

  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.open(gmgnUrl, '_blank');
  };

  const totals = enhancedItems.reduce(
    (acc, token) => {
      acc.totalSpentSOL += token.summary.totalSpentSOL;
      acc.totalReceivedSOL += token.summary.totalReceivedSOL;
      acc.realizedPnL += token.summary.netSOL;
      acc.unrealizedPnL += token.summary.unrealizedPnl || 0;
      acc.totalPnL += token.summary.totalPnl || token.summary.netSOL;
      acc.uniqueTokens += 1;
      acc.tokensWithBalance += token.summary.totalTokensRemaining > 0 ? 1 : 0;
      return acc;
    },
    {
      totalSpentSOL: 0,
      totalReceivedSOL: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalPnL: 0,
      uniqueTokens: 0,
      tokensWithBalance: 0,
    }
  );

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
          <p className="text-sm text-gray-500 mt-1">
            Track token performance across all monitored wallets
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <select
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="text-sm border border-gray-300 rounded px-3 py-1.5"
          >
            <option value="1">Last 1 hour</option>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="48">Last 48 hours</option>
            <option value="168">Last 7 days</option>
          </select>
          <button
            onClick={fetchTokenData}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition"
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {enhancedItems.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg">
          <div>
            <div className="text-xs text-gray-600 uppercase tracking-wider">Total Spent</div>
            <div className="text-lg font-bold text-red-600">
              -{totals.totalSpentSOL.toFixed(4)} SOL
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-600 uppercase tracking-wider">Total Received</div>
            <div className="text-lg font-bold text-green-600">
              +{totals.totalReceivedSOL.toFixed(4)} SOL
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-600 uppercase tracking-wider">Realized PnL</div>
            <div className={`text-lg font-bold ${totals.realizedPnL >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              {totals.realizedPnL >= 0 ? '+' : ''}{totals.realizedPnL.toFixed(4)} SOL
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-600 uppercase tracking-wider">Unrealized PnL</div>
            <div className={`text-lg font-bold ${totals.unrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {totals.unrealizedPnL !== 0 ? (
                <>
                  {totals.unrealizedPnL >= 0 ? '+' : ''}{totals.unrealizedPnL.toFixed(4)} SOL
                </>
              ) : (
                <span className="text-gray-400">-</span>
              )}
            </div>
          </div>
        </div>
      )}

      {enhancedItems.length > 0 && totals.unrealizedPnL !== 0 && (
        <div className="mb-6 p-4 bg-gradient-to-r from-gray-50 to-gray-100 rounded-lg">
          <div className="flex justify-between items-center">
            <div>
              <div className="text-sm text-gray-600">Total PnL (Realized + Unrealized)</div>
              <div className="text-xs text-gray-500 mt-1">
                {totals.uniqueTokens} tokens · {totals.tokensWithBalance} with remaining balance
              </div>
            </div>
            <div className={`text-2xl font-bold ${totals.totalPnL >= 0 ? 'text-green-800' : 'text-red-800'}`}>
              {totals.totalPnL >= 0 ? '+' : ''}{totals.totalPnL.toFixed(4)} SOL
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="text-gray-500">Loading token data...</div>
        </div>
      ) : error ? (
        <div className="text-red-600 p-4 bg-red-50 rounded-lg">{error}</div>
      ) : enhancedItems.length === 0 ? (
        <div className="text-gray-500 text-center py-12">
          No token data available for selected timeframe
          {groupId && ' and group'}
        </div>
      ) : (
        <div className="space-y-4">
          {enhancedItems.map((token) => (
            <TokenCard
              key={token.mint}
              token={token}
              currentPrice={token.currentPrice}
              onOpenChart={() => openGmgnChart(token.mint)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;