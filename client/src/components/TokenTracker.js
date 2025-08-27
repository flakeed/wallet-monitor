import TokenCard from './TokenCard';
import React, { useState, useEffect } from 'react';

function TokenTracker({ groupId, transactions, timeframe }) {
const [items, setItems] = useState([]);
const [hours, setHours] = useState(timeframe || '24');
const [loading, setLoading] = useState(false);
const [error, setError] = useState(null);
const [sortBy, setSortBy] = useState('latest');

// Age filter only (removed risk filter)
const [ageFilter, setAgeFilter] = useState('all');
const [showFilters, setShowFilters] = useState(false);
const [tokenMetrics, setTokenMetrics] = useState({
  total: 0,
  withAgeData: 0
});

const aggregateTokens = (transactions, hours, groupId) => {
const EXCLUDED_TOKENS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'So11111111111111111111111111111111111111112',  
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 
];

const byToken = new Map();

const now = new Date();
const filteredTransactions = transactions.filter((tx) => {
  const txTime = new Date(tx.time);
  const hoursDiff = (now - txTime) / (1000 * 60 * 60);
  const matchesTimeframe = hoursDiff <= parseInt(hours);
  const matchesGroup = !groupId || tx.wallet.group_id === groupId;
  return matchesTimeframe && matchesGroup;
});

console.log(`Processing ${filteredTransactions.length} filtered transactions`);

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
        },
      });
    }

    const tokenData = byToken.get(token.mint);
    const walletAddress = tx.wallet.address;
    const wallet = tokenData.wallets.find((w) => w.address === walletAddress);
    const txTime = new Date(tx.time);

    if (!tokenData.summary.latestActivity || txTime > new Date(tokenData.summary.latestActivity)) {
      tokenData.summary.latestActivity = tx.time;
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
  wallets: t.wallets.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
}));

console.log(`Aggregated ${result.length} unique tokens (excluded ${EXCLUDED_TOKENS.length} system tokens)`);

return result;
};

// Enhanced sorting with age considerations
const sortTokens = (tokens, sortBy, ageFilter) => {
  let filteredTokens = [...tokens];
  
  // Apply age filter
  if (ageFilter !== 'all') {
    filteredTokens = filteredTokens.filter(token => {
      // This will be populated by price data in useEffect
      const ageData = token._enhancedData;
      if (!ageData) return true; // Keep tokens without age data
      
      switch (ageFilter) {
        case 'very_new': return ageData.ageInHours < 1;
        case 'new': return ageData.ageInHours < 24;
        case 'recent': return ageData.ageInDays && ageData.ageInDays <= 7;
        case 'week': return ageData.ageInDays && ageData.ageInDays <= 30;
        case 'established': return ageData.ageInDays && ageData.ageInDays > 30;
        default: return true;
      }
    });
  }
  
  // Sort tokens
  switch (sortBy) {
    case 'latest':
      return filteredTokens.sort((a, b) => {
        const timeA = new Date(a.summary.latestActivity || 0);
        const timeB = new Date(b.summary.latestActivity || 0);
        return timeB - timeA;
      });
    
    case 'newest_tokens':
      return filteredTokens.sort((a, b) => {
        const ageA = a._enhancedData?.ageInHours || Infinity;
        const ageB = b._enhancedData?.ageInHours || Infinity;
        return ageA - ageB; // Newest first (smaller age)
      });
      
    case 'oldest_tokens':
      return filteredTokens.sort((a, b) => {
        const ageA = a._enhancedData?.ageInHours || 0;
        const ageB = b._enhancedData?.ageInHours || 0;
        return ageB - ageA; // Oldest first (larger age)
      });
      
    case 'market_cap':
      return filteredTokens.sort((a, b) => {
        const mcA = a._enhancedData?.marketCap || 0;
        const mcB = b._enhancedData?.marketCap || 0;
        return mcB - mcA;
      });
    
    case 'profit':
      return filteredTokens.sort((a, b) => b.summary.netSOL - a.summary.netSOL);
    
    case 'loss':
      return filteredTokens.sort((a, b) => a.summary.netSOL - b.summary.netSOL);
    
    case 'volume':
      return filteredTokens.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));
    
    case 'activity':
      return filteredTokens.sort((a, b) => 
        (b.summary.totalBuys + b.summary.totalSells) - (a.summary.totalBuys + a.summary.totalSells)
      );
    
    default:
      return filteredTokens;
  }
};

useEffect(() => {
  setLoading(true);
  try {
    const aggregatedTokens = aggregateTokens(transactions, hours, groupId);
    
    // Calculate initial metrics
    const metrics = {
      total: aggregatedTokens.length,
      withAgeData: 0
    };
    
    setTokenMetrics(metrics);
    
    const sortedTokens = sortTokens(aggregatedTokens, sortBy, ageFilter);
    console.log('Aggregated and sorted tokens:', sortedTokens);
    setItems(sortedTokens);
    setError(null);
  } catch (e) {
    setError(e.message);
  } finally {
    setLoading(false);
  }
}, [transactions, hours, groupId, sortBy, ageFilter]);

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

// Reset filters
const resetFilters = () => {
  setAgeFilter('all');
  setSortBy('latest');
};

// Get filter summary text
const getFilterSummary = () => {
  const activeFilters = [];
  if (ageFilter !== 'all') activeFilters.push(`Age: ${ageFilter.replace('_', ' ')}`);
  return activeFilters.length > 0 ? `(${activeFilters.join(', ')})` : '';
};

return (
  <div className="bg-white rounded-lg shadow-sm border p-6">
    {/* Enhanced Header with Metrics */}
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center space-x-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        {tokenMetrics.total > 0 && (
          <div className="flex items-center space-x-2 text-xs">
            <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded">
              {tokenMetrics.total} tokens
            </span>
          </div>
        )}
      </div>

      {/* Control Panel */}
      <div className="flex items-center space-x-3">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`text-sm px-3 py-1 rounded transition-colors ${
            showFilters ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.207A1 1 0 013 6.5V4z" />
          </svg>
          Filters {getFilterSummary()}
        </button>
        
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

    {/* Enhanced Filter Panel */}
    {showFilters && (
      <div className="mb-4 p-4 bg-gray-50 rounded-lg border">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Sort By */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Sort By</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="latest">Latest Activity</option>
              <option value="newest_tokens">Newest Tokens</option>
              <option value="oldest_tokens">Oldest Tokens</option>
              <option value="market_cap">Market Cap</option>
              <option value="profit">Most Profitable</option>
              <option value="loss">Biggest Losses</option>
              <option value="volume">Highest Volume</option>
              <option value="activity">Most Active</option>
            </select>
          </div>

          {/* Age Filter */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Token Age</label>
            <select
              value={ageFilter}
              onChange={(e) => setAgeFilter(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="all">All Ages</option>
              <option value="very_new">Very New (&lt; 1h)</option>
              <option value="new">New (&lt; 24h)</option>
              <option value="recent">Recent (&lt; 1w)</option>
              <option value="week">This Month</option>
              <option value="established">Established (&gt; 1mo)</option>
            </select>
          </div>

          {/* Actions */}
          <div className="flex items-end">
            <button
              onClick={resetFilters}
              className="w-full text-sm bg-gray-200 text-gray-700 px-3 py-1 rounded hover:bg-gray-300 transition-colors"
            >
              Reset Filters
            </button>
          </div>
        </div>

        {/* Filter Results Summary */}
        {ageFilter !== 'all' && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>
                Showing {items.length} of {tokenMetrics.total} tokens
                {getFilterSummary()}
              </span>
              <div className="flex items-center space-x-2">
                {ageFilter !== 'all' && (
                  <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded">
                    Age: {ageFilter.replace('_', ' ')}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )}
    
    {loading ? (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
        <span className="text-gray-500">Loading enhanced token data...</span>
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
          {ageFilter !== 'all' 
            ? 'Try adjusting your filters or expanding the time period'
            : 'No token transactions detected for the selected timeframe and group'
          }
        </p>
        {ageFilter !== 'all' && (
          <button
            onClick={resetFilters}
            className="mt-3 text-sm text-blue-600 hover:text-blue-800 underline"
          >
            Reset all filters
          </button>
        )}
      </div>
    ) : (
      <div className="space-y-4">
        {/* Enhanced Results Header */}
        <div className="flex items-center justify-between text-sm text-gray-600 bg-gray-50 px-3 py-2 rounded">
          <div className="flex items-center space-x-4">
            <span>
              {items.length} token{items.length === 1 ? '' : 's'} found
            </span>
            {sortBy === 'newest_tokens' && (
              <span className="text-orange-600">
                🕐 Sorted by deployment age
              </span>
            )}
            {sortBy === 'market_cap' && (
              <span className="text-green-600">
                💰 Sorted by market cap
              </span>
            )}
          </div>
          
          <div className="flex items-center space-x-2 text-xs">
            {/* Removed risk indicators */}
          </div>
        </div>

        {/* Token Cards */}
        {items.map((token) => (
          <div key={token.mint}>
            <TokenCard token={token} onOpenChart={() => openGmgnChart(token.mint)} />
          </div>
        ))}

        {/* Load More / Pagination could be added here */}
        {items.length >= 50 && (
          <div className="text-center py-4">
            <div className="text-sm text-gray-500">
              Showing first 50 tokens. Use filters to narrow results.
            </div>
          </div>
        )}
      </div>
    )}
  </div>
);
}

export default TokenTracker;