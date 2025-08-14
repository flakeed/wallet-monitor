import React, { useState, useEffect, useCallback } from 'react';

// Mock components - replace with your actual components
const TokenCard = ({ token, onOpenChart, currentPrice }) => (
  <div className="border rounded p-4 mb-2">
    <div className="flex justify-between">
      <div>
        <div className="font-bold">{token.symbol}</div>
        <div className="text-sm text-gray-600">{token.name}</div>
      </div>
      <div className="text-right">
        <div className="font-bold">Net: {token.summary.netSOL.toFixed(4)} SOL</div>
        {currentPrice && (
          <div className="text-sm">Price: ${currentPrice.toFixed(6)}</div>
        )}
      </div>
    </div>
    <button onClick={onOpenChart} className="mt-2 px-4 py-2 bg-blue-600 text-white rounded">
      Open Chart
    </button>
  </div>
);

function TokenTracker({ groupId, timeframe = '24' }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tokenPrices, setTokenPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(false);

  // Fetch token data from API
  const fetchTokenData = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const params = new URLSearchParams();
      params.append('hours', hours);
      if (groupId) params.append('groupId', groupId);
      
      const response = await fetch(`/api/tokens/tracker?${params}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch token data: ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log('Fetched token data:', data);
      setItems(data);
      
      // Fetch prices for tokens with remaining balances
      const mintsWithBalance = data
        .filter(token => token.summary.totalTokensRemaining > 0)
        .map(token => token.mint);
      
      if (mintsWithBalance.length > 0) {
        fetchTokenPrices(mintsWithBalance);
      }
    } catch (e) {
      console.error('Error fetching token data:', e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [hours, groupId]);

  // Fetch current token prices (you'll need to implement this based on your price API)
  const fetchTokenPrices = async (mints) => {
    setPriceLoading(true);
    try {
      // Example using Jupiter Price API
      const response = await fetch(
        `https://price.jup.ag/v4/price?ids=${mints.join(',')}`
      );
      
      if (response.ok) {
        const data = await response.json();
        const prices = {};
        
        Object.entries(data.data || {}).forEach(([mint, priceData]) => {
          prices[mint] = priceData.price || null;
        });
        
        setTokenPrices(prices);
      }
    } catch (e) {
      console.error('Error fetching token prices:', e);
    } finally {
      setPriceLoading(false);
    }
  };

  // Calculate unrealized PnL for each token
  const calculateUnrealizedPnL = (token, currentPrice) => {
    if (!currentPrice || token.summary.totalTokensRemaining <= 0) {
      return 0;
    }
    
    // Current value of remaining tokens
    const currentValue = currentPrice * token.summary.totalTokensRemaining;
    
    // Average cost basis for remaining tokens
    const avgCostBasis = token.summary.avgBuyPrice * token.summary.totalTokensRemaining;
    
    // Unrealized PnL in SOL (assuming price is in SOL terms)
    return currentValue - avgCostBasis;
  };

  // Enhanced items with unrealized PnL
  const enhancedItems = items.map(token => {
    const currentPrice = tokenPrices[token.mint];
    const unrealizedPnl = calculateUnrealizedPnL(token, currentPrice);
    
    // Enhance wallets with unrealized PnL
    const enhancedWallets = token.wallets.map(wallet => {
      const walletUnrealizedPnl = currentPrice && wallet.tokensRemaining > 0
        ? (currentPrice * wallet.tokensRemaining) - (wallet.avgBuyPrice * wallet.tokensRemaining)
        : 0;
      
      return {
        ...wallet,
        unrealizedPnl: walletUnrealizedPnl,
        totalPnl: wallet.pnlSol + walletUnrealizedPnl,
      };
    });
    
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
  });

  // Load data on mount and when dependencies change
  useEffect(() => {
    fetchTokenData();
  }, [fetchTokenData]);

  // Update hours when timeframe prop changes
  useEffect(() => {
    setHours(timeframe);
  }, [timeframe]);

  // Open GMGN chart
  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.open(gmgnUrl, '_blank');
  };

  // Summary statistics
  const totals = enhancedItems.reduce((acc, token) => {
    acc.totalSpentSOL += token.summary.totalSpentSOL;
    acc.totalReceivedSOL += token.summary.totalReceivedSOL;
    acc.realizedPnL += token.summary.netSOL;
    acc.unrealizedPnL += token.summary.unrealizedPnl || 0;
    acc.totalPnL += token.summary.totalPnl || token.summary.netSOL;
    acc.uniqueTokens += 1;
    acc.tokensWithBalance += token.summary.totalTokensRemaining > 0 ? 1 : 0;
    return acc;
  }, {
    totalSpentSOL: 0,
    totalReceivedSOL: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalPnL: 0,
    uniqueTokens: 0,
    tokensWithBalance: 0,
  });

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      {/* Header */}
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

      {/* Summary Statistics */}
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
            <div className="text-xs text-gray-600 uppercase tracking-wider">
              Unrealized PnL
              {priceLoading && <span className="ml-1 text-gray-400">(loading...)</span>}
            </div>
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

      {/* Total PnL Summary */}
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

      {/* Content */}
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