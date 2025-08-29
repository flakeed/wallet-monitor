import React, { useState } from 'react';
import { useTokenPools } from '../hooks/useEnhancedPrices';

const PriceSourceIndicator = ({ source, tokenMint, showDetails = false, className = "" }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const { pools, loading: poolsLoading } = useTokenPools(showDetails ? tokenMint : null);

  // Определяем цвет и иконку по источнику
  const getSourceInfo = (source) => {
    switch (source) {
      case 'pools':
        return {
          color: 'text-green-500',
          bgColor: 'bg-green-100',
          icon: '🏊',
          label: 'Pool',
          description: 'Price from Solana liquidity pools (Raydium, Orca)',
          reliability: 'High'
        };
      case 'dexscreener':
        return {
          color: 'text-blue-500',
          bgColor: 'bg-blue-100',
          icon: '📊',
          label: 'API',
          description: 'Price from DexScreener API',
          reliability: 'Medium'
        };
      case 'hybrid':
        return {
          color: 'text-purple-500',
          bgColor: 'bg-purple-100',
          icon: '⚡',
          label: 'Hybrid',
          description: 'Best price from multiple sources',
          reliability: 'High'
        };
      case 'fallback':
        return {
          color: 'text-yellow-500',
          bgColor: 'bg-yellow-100',
          icon: '⚠️',
          label: 'Fallback',
          description: 'Cached or estimated price',
          reliability: 'Low'
        };
      default:
        return {
          color: 'text-gray-500',
          bgColor: 'bg-gray-100',
          icon: '❓',
          label: 'Unknown',
          description: 'Unknown price source',
          reliability: 'Unknown'
        };
    }
  };

  const sourceInfo = getSourceInfo(source);

  if (!source) return null;

  return (
    <div 
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Основной индикатор */}
      <div className={`flex items-center space-x-1 px-2 py-1 rounded-md text-xs font-medium ${sourceInfo.color} ${sourceInfo.bgColor}`}>
        <span>{sourceInfo.icon}</span>
        <span>{sourceInfo.label}</span>
      </div>

      {/* Тултип */}
      {showTooltip && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-64 bg-gray-900 text-white text-xs rounded-lg p-3 shadow-lg z-50">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Price Source</span>
              <span className={`px-2 py-1 rounded text-xs ${
                sourceInfo.reliability === 'High' ? 'bg-green-600' :
                sourceInfo.reliability === 'Medium' ? 'bg-yellow-600' :
                'bg-red-600'
              }`}>
                {sourceInfo.reliability}
              </span>
            </div>
            
            <div className="text-gray-300">
              {sourceInfo.description}
            </div>

            {showDetails && pools && (
              <div className="border-t border-gray-700 pt-2 mt-2">
                <div className="font-semibold mb-1">Available Pools:</div>
                <div className="space-y-1">
                  {pools.sol.length > 0 && (
                    <div>
                      <span className="text-blue-400">SOL pairs:</span> {pools.sol.length}
                    </div>
                  )}
                  {pools.usdc.length > 0 && (
                    <div>
                      <span className="text-green-400">USDC pairs:</span> {pools.usdc.length}
                    </div>
                  )}
                  {pools.total === 0 && (
                    <div className="text-gray-500">No pools found</div>
                  )}
                </div>
              </div>
            )}

            {poolsLoading && showDetails && (
              <div className="border-t border-gray-700 pt-2 mt-2">
                <div className="animate-pulse text-gray-400">Loading pool info...</div>
              </div>
            )}
          </div>
          
          {/* Стрелка тултипа */}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-2 h-2 bg-gray-900 rotate-45"></div>
        </div>
      )}
    </div>
  );
};

// Компонент для сравнения цен из разных источников
export const PriceComparison = ({ tokenMint }) => {
  const [prices, setPrices] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchAllPrices = async () => {
    if (!tokenMint) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/tokens/price/${tokenMint}/best`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('sessionToken')}`
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      if (data.success) {
        setPrices(data.price);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    if (tokenMint) {
      fetchAllPrices();
    }
  }, [tokenMint]);

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-700 rounded w-3/4 mb-2"></div>
          <div className="h-4 bg-gray-700 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  if (error || !prices) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="text-red-400 text-sm">
          {error || 'No price data available'}
        </div>
      </div>
    );
  }

  const allPrices = [prices, ...(prices.alternatives || [])];

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-white font-medium">Price Comparison</h4>
        <button 
          onClick={fetchAllPrices}
          className="text-blue-400 hover:text-blue-300 text-sm"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-2">
        {allPrices.map((priceData, index) => (
          <div 
            key={index} 
            className={`flex items-center justify-between p-3 rounded-lg ${
              index === 0 ? 'bg-green-900/20 border border-green-700' : 'bg-gray-700'
            }`}
          >
            <div className="flex items-center space-x-3">
              <PriceSourceIndicator source={priceData.source} />
              {index === 0 && (
                <span className="text-green-400 text-xs font-medium">BEST</span>
              )}
            </div>
            
            <div className="text-right">
              <div className="text-white font-medium">
                ${priceData.price?.toFixed(8) || 'N/A'}
              </div>
              {priceData.liquidity > 0 && (
                <div className="text-gray-400 text-xs">
                  Liq: ${(priceData.liquidity).toLocaleString()}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {prices.alternatives && prices.alternatives.length > 0 && (
        <div className="text-gray-400 text-xs">
          Price spread: {((Math.max(...allPrices.map(p => p.price)) - Math.min(...allPrices.map(p => p.price))) / Math.min(...allPrices.map(p => p.price)) * 100).toFixed(2)}%
        </div>
      )}
    </div>
  );
};

export default PriceSourceIndicator;