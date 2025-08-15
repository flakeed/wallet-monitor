import React, { useState, useEffect } from 'react';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';

function PortfolioDashboard({ groupId, timeframe }) {
  const [portfolioStats, setPortfolioStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchPortfolioStats = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const url = `${API_BASE}/portfolio/stats?hours=${timeframe}${groupId ? `&groupId=${groupId}` : ''}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error('Failed to fetch portfolio stats');
      }
      
      const data = await response.json();
      setPortfolioStats(data.portfolio);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Error fetching portfolio stats:', error);
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolioStats();
    
    // Обновляем статистику каждые 2 минуты
    const interval = setInterval(fetchPortfolioStats, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [groupId, timeframe]);

  const formatSOL = (amount) => {
    if (amount === null || amount === undefined) return '0.0000';
    return amount.toFixed(4);
  };

  const formatUSD = (amount) => {
    if (amount === null || amount === undefined) return '$0.00';
    return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  const formatPercent = (value) => {
    if (value === null || value === undefined || !isFinite(value)) return '0.00%';
    return `${value.toFixed(2)}%`;
  };

  const getColorClass = (value) => {
    if (value > 0) return 'text-green-600';
    if (value < 0) return 'text-red-600';
    return 'text-gray-600';
  };

  if (loading && !portfolioStats) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <span className="text-gray-500">Loading portfolio data...</span>
        </div>
      </div>
    );
  }

  if (error && !portfolioStats) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="text-center py-8">
          <div className="text-red-600 mb-2">Error: {error}</div>
          <button
            onClick={fetchPortfolioStats}
            className="text-blue-600 hover:text-blue-700 text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!portfolioStats) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="text-center py-8">
          <p className="text-gray-500">No portfolio data available</p>
        </div>
      </div>
    );
  }

  const roi = portfolioStats.totalSolSpent > 0 ? 
    (portfolioStats.totalPnL / portfolioStats.totalSolSpent) * 100 : 0;

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-semibold text-gray-900">Portfolio Overview</h3>
        <div className="flex items-center space-x-2">
          {loading && (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
          )}
          <button
            onClick={fetchPortfolioStats}
            disabled={loading}
            className="text-blue-600 hover:text-blue-700 text-sm disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Main PnL Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-4">
          <div className="text-center">
            <div className="text-sm text-blue-700 font-medium mb-1">Total Invested</div>
            <div className="text-2xl font-bold text-blue-900">
              {formatSOL(portfolioStats.totalSolSpent)} SOL
            </div>
            <div className="text-sm text-blue-600">
              {formatUSD(portfolioStats.totalSolSpentUSD)}
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg p-4">
          <div className="text-center">
            <div className="text-sm text-purple-700 font-medium mb-1">Current Value</div>
            <div className="text-2xl font-bold text-purple-900">
              {formatSOL(portfolioStats.totalCurrentValue)} SOL
            </div>
            <div className="text-sm text-purple-600">
              {formatUSD(portfolioStats.totalCurrentValueUSD)}
            </div>
          </div>
        </div>

        <div className={`bg-gradient-to-r rounded-lg p-4 ${
          portfolioStats.totalPnL >= 0 
            ? 'from-green-50 to-green-100' 
            : 'from-red-50 to-red-100'
        }`}>
          <div className="text-center">
            <div className={`text-sm font-medium mb-1 ${
              portfolioStats.totalPnL >= 0 ? 'text-green-700' : 'text-red-700'
            }`}>
              Total PnL
            </div>
            <div className={`text-2xl font-bold ${
              portfolioStats.totalPnL >= 0 ? 'text-green-900' : 'text-red-900'
            }`}>
              {portfolioStats.totalPnL >= 0 ? '+' : ''}{formatSOL(portfolioStats.totalPnL)} SOL
            </div>
            <div className={`text-sm ${
              portfolioStats.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {formatUSD(portfolioStats.totalPnLUSD)}
            </div>
          </div>
        </div>
      </div>

      {/* Detailed Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="text-center p-3 bg-gray-50 rounded">
          <div className={`text-lg font-semibold ${getColorClass(portfolioStats.totalRealizedPnL)}`}>
            {portfolioStats.totalRealizedPnL >= 0 ? '+' : ''}{formatSOL(portfolioStats.totalRealizedPnL)} SOL
          </div>
          <div className="text-sm text-gray-600">Realized PnL</div>
          <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalRealizedPnLUSD)}</div>
        </div>

        <div className="text-center p-3 bg-gray-50 rounded">
          <div className={`text-lg font-semibold ${getColorClass(portfolioStats.totalUnrealizedPnL)}`}>
            {portfolioStats.totalUnrealizedPnL >= 0 ? '+' : ''}{formatSOL(portfolioStats.totalUnrealizedPnL)} SOL
          </div>
          <div className="text-sm text-gray-600">Unrealized PnL</div>
          <div className="text-xs text-gray-500">{formatUSD(portfolioStats.totalUnrealizedPnLUSD)}</div>
        </div>

        <div className="text-center p-3 bg-gray-50 rounded">
          <div className={`text-lg font-semibold ${getColorClass(roi)}`}>
            {formatPercent(roi)}
          </div>
          <div className="text-sm text-gray-600">ROI</div>
          <div className="text-xs text-gray-500">Return on Investment</div>
        </div>

        <div className="text-center p-3 bg-gray-50 rounded">
          <div className="text-lg font-semibold text-gray-900">
            {portfolioStats.totalTokensWithPrice}/{portfolioStats.totalTokens}
          </div>
          <div className="text-sm text-gray-600">Price Coverage</div>
          <div className="text-xs text-gray-500">
            {formatPercent(portfolioStats.priceDataCoverage * 100)}
          </div>
        </div>
      </div>

      {/* Performance Indicators */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-lg font-medium text-gray-900">Performance Indicators</h4>
        </div>
        
        <div className="space-y-3">
          {/* ROI Progress Bar */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600">Return on Investment</span>
              <span className={getColorClass(roi)}>{formatPercent(roi)}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  roi >= 0 ? 'bg-green-500' : 'bg-red-500'
                }`}
                style={{
                  width: `${Math.min(Math.abs(roi), 100)}%`
                }}
              ></div>
            </div>
          </div>

          {/* Price Data Coverage */}
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600">Price Data Coverage</span>
              <span className="text-gray-900">{formatPercent(portfolioStats.priceDataCoverage * 100)}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${portfolioStats.priceDataCoverage * 100}%`
                }}
              ></div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center space-x-4">
            <span>SOL Price: {formatUSD(portfolioStats.solPriceUSD).replace('$', '')} USD</span>
            <span>Timeframe: {timeframe}h</span>
            {groupId && <span>Group: {groupId}</span>}
          </div>
          
          <div>
            {lastUpdated && (
              <span>Last updated: {lastUpdated.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PortfolioDashboard;