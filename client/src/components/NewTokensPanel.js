import React, { useState, useEffect } from 'react';

function NewTokensPanel({ isExpanded, onToggle }) {
  const [activeTab, setActiveTab] = useState('new');
  const [newTokens, setNewTokens] = useState([]);
  const [trendingTokens, setTrendingTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  // Auto-refresh every 2 minutes
  useEffect(() => {
    if (isExpanded) {
      fetchTokens();
      const interval = setInterval(fetchTokens, 120000); // 2 minutes
      return () => clearInterval(interval);
    }
  }, [isExpanded, activeTab]);

  const fetchTokens = async () => {
    if (!isExpanded) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const sessionToken = localStorage.getItem('sessionToken');
      const headers = {
        'Authorization': `Bearer ${sessionToken}`
      };

      if (activeTab === 'new') {
        const response = await fetch('/api/tokens/new?hours=24&limit=50', { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setNewTokens(data.data || []);
      } else {
        const response = await fetch('/api/tokens/trending?hours=4&limit=30', { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setTrendingTokens(data.data || []);
      }
      
      setLastUpdate(new Date());
    } catch (err) {
      console.error('Error fetching tokens:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num) => {
    if (!num) return '0';
    if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toString();
  };

  const formatPrice = (price) => {
    if (!price) return '$0.00';
    if (price < 0.000001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(8)}`;
    return `$${price.toFixed(6)}`;
  };

  const getAgeColor = (ageHours) => {
    if (ageHours < 1) return 'text-red-400 bg-red-900/20';
    if (ageHours < 6) return 'text-orange-400 bg-orange-900/20';
    if (ageHours < 24) return 'text-yellow-400 bg-yellow-900/20';
    return 'text-green-400 bg-green-900/20';
  };

  const formatAge = (ageHours) => {
    if (ageHours < 1) return '<1h';
    if (ageHours < 24) return `${Math.floor(ageHours)}h`;
    if (ageHours < 168) return `${Math.floor(ageHours / 24)}d`;
    return `${Math.floor(ageHours / 168)}w`;
  };

  const openToken = (mint) => {
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const tokens = activeTab === 'new' ? newTokens : trendingTokens;

  return (
    <div className="bg-gray-800 border-b border-gray-700">
      {/* Header */}
      <div className="px-4 py-2">
        <button
          onClick={onToggle}
          className="flex items-center justify-between w-full text-left"
        >
          <div className="flex items-center space-x-2">
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            <span className="text-white font-medium">New & Trending Tokens</span>
            {tokens.length > 0 && (
              <span className="bg-blue-600 text-white text-xs px-2 py-1 rounded">
                {tokens.length}
              </span>
            )}
            {loading && (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
            )}
          </div>
          <svg 
            className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} 
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-gray-700">
          {/* Tabs */}
          <div className="flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab('new')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'new'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-700/50'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              🆕 New (24h)
            </button>
            <button
              onClick={() => setActiveTab('trending')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'trending'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-700/50'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              🔥 Trending (4h)
            </button>
          </div>

          {/* Content */}
          <div className="max-h-96 overflow-y-auto">
            {error && (
              <div className="p-4 bg-red-900/20 border-b border-red-700">
                <div className="text-red-400 text-sm">Error: {error}</div>
              </div>
            )}

            {loading && tokens.length === 0 && (
              <div className="p-4 text-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mx-auto mb-2"></div>
                <div className="text-gray-400 text-sm">Loading {activeTab} tokens...</div>
              </div>
            )}

            {!loading && tokens.length === 0 && !error && (
              <div className="p-4 text-center text-gray-500">
                No {activeTab} tokens found
              </div>
            )}

            {tokens.length > 0 && (
              <div className="divide-y divide-gray-700">
                {tokens.map((token, index) => (
                  <div 
                    key={token.mint} 
                    className="p-3 hover:bg-gray-700/30 transition-colors group"
                  >
                    <div className="flex items-center justify-between">
                      {/* Token Info */}
                      <div className="flex-1 min-w-0 mr-3">
                        <div className="flex items-center space-x-2 mb-1">
                          <span className="text-white font-medium text-sm">
                            {token.symbol || 'UNK'}
                          </span>
                          <span className="text-gray-400 text-xs truncate">
                            {token.name || 'Unknown Token'}
                          </span>
                          {token.ageHours !== undefined && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${getAgeColor(token.ageHours)}`}>
                              {formatAge(token.ageHours)}
                            </span>
                          )}
                        </div>
                        
                        <div className="flex items-center space-x-2 text-xs text-gray-500">
                          <span className="font-mono">
                            {token.mint.slice(0, 8)}...{token.mint.slice(-4)}
                          </span>
                          <button
                            onClick={() => copyToClipboard(token.mint)}
                            className="opacity-0 group-hover:opacity-100 hover:text-blue-400 transition-all"
                            title="Copy address"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        </div>

                        {/* Stats Row */}
                        <div className="flex items-center space-x-3 mt-1 text-xs">
                          <div className="text-gray-400">
                            <span className="text-blue-400">{token.transaction_count || 0}</span> txs
                          </div>
                          <div className="text-gray-400">
                            <span className="text-green-400">{token.unique_wallets || 0}</span> wallets
                          </div>
                          {token.totalVolume && (
                            <div className="text-gray-400">
                              <span className="text-yellow-400">{formatNumber(token.totalVolume)}</span> SOL vol
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Price & Market Data */}
                      <div className="text-right">
                        {token.currentPrice > 0 && (
                          <div className="text-white text-sm font-medium mb-1">
                            {formatPrice(token.currentPrice)}
                          </div>
                        )}
                        
                        {token.marketCap > 0 && (
                          <div className="text-gray-400 text-xs mb-1">
                            MC: ${formatNumber(token.marketCap)}
                          </div>
                        )}
                        
                        {token.liquidity > 0 && (
                          <div className="text-gray-500 text-xs mb-1">
                            Liq: ${formatNumber(token.liquidity)}
                          </div>
                        )}

                        {token.pools > 0 && (
                          <div className="text-blue-400 text-xs">
                            {token.pools} pool{token.pools > 1 ? 's' : ''}
                          </div>
                        )}
                      </div>

                      {/* Action Button */}
                      <div className="ml-2">
                        <button
                          onClick={() => openToken(token.mint)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-500 hover:text-blue-400 rounded transition-all"
                          title="Open in GMGN"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Activity Score for Trending */}
                    {activeTab === 'trending' && token.activityScore && (
                      <div className="mt-2 pt-2 border-t border-gray-700">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">Activity Score:</span>
                          <span className="text-orange-400 font-medium">
                            {formatNumber(token.activityScore)}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          {lastUpdate && (
            <div className="px-4 py-2 border-t border-gray-700 bg-gray-800/50">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>
                  Last updated: {lastUpdate.toLocaleTimeString()}
                </span>
                <div className="flex items-center space-x-2">
                  <span className="px-2 py-1 bg-green-900/30 text-green-400 rounded">
                    RPC Enhanced
                  </span>
                  <button
                    onClick={fetchTokens}
                    disabled={loading}
                    className="px-2 py-1 bg-blue-900/30 text-blue-400 rounded hover:bg-blue-900/50 transition-colors disabled:opacity-50"
                  >
                    {loading ? (
                      <div className="animate-spin rounded-full h-3 w-3 border border-blue-400 border-t-transparent"></div>
                    ) : (
                      'Refresh'
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NewTokensPanel;