// client/src/components/TokenCard.js - Enhanced with pool data and market cap

import React, { useState, useMemo } from 'react';
import { useEnhancedTokenData, useSolPrice } from '../hooks/usePrices';

function TokenCard({ token, onOpenChart }) {
  const [showDetails, setShowDetails] = useState(false);
  const { solPrice } = useSolPrice();
  const { tokenData: enhancedData, loading: loadingEnhanced } = useEnhancedTokenData(token.mint);

  const WALLETS_DISPLAY_LIMIT = 3;

  // Enhanced PnL calculation with accurate pricing
  const groupPnL = useMemo(() => {
    if (!enhancedData || !enhancedData.price || !solPrice) return null;

    let totalTokensBought = 0;
    let totalTokensSold = 0;
    let totalSpentSOL = 0;
    let totalReceivedSOL = 0;

    token.wallets.forEach(wallet => {
      totalTokensBought += wallet.tokensBought || 0;
      totalTokensSold += wallet.tokensSold || 0;
      totalSpentSOL += wallet.solSpent || 0;
      totalReceivedSOL += wallet.solReceived || 0;
    });

    if (totalTokensBought === 0) return null;

    const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
    const soldTokens = Math.min(totalTokensSold, totalTokensBought);
    const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
    
    let realizedPnLSOL = 0;
    let unrealizedPnLSOL = 0;

    if (soldTokens > 0) {
      const soldTokensCostBasisSOL = soldTokens * avgBuyPriceSOL;
      realizedPnLSOL = totalReceivedSOL - soldTokensCostBasisSOL;
    }

    if (currentHoldings > 0) {
      // Use enhanced price data for accurate current value
      const currentPriceSOL = enhancedData.priceInSol || (enhancedData.price / solPrice);
      const currentMarketValueSOL = currentHoldings * currentPriceSOL;
      const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
      unrealizedPnLSOL = currentMarketValueSOL - remainingCostBasisSOL;
    }

    const totalPnLSOL = realizedPnLSOL + unrealizedPnLSOL;
    
    return {
      totalTokensBought,
      totalTokensSold,
      currentHoldings,
      soldTokens,
      totalSpentSOL,
      totalReceivedSOL,
      realizedPnLSOL,
      unrealizedPnLSOL,
      totalPnLSOL,
      realizedPnLUSD: realizedPnLSOL * solPrice,
      unrealizedPnLUSD: unrealizedPnLSOL * solPrice,
      totalPnLUSD: totalPnLSOL * solPrice,
      currentPriceUSD: enhancedData.price,
      currentPriceSOL: enhancedData.priceInSol,
      marketCap: enhancedData.marketCap,
      soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
      holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0
    };
  }, [enhancedData, solPrice, token.wallets]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const openGmgnChart = () => {
    if (!token.mint) return;
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  const formatNumber = (num, decimals = 2) => {
    if (num === null || num === undefined) return '0';
    if (Math.abs(num) >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toFixed(decimals);
  };

  const formatAge = (ageInHours) => {
    if (!ageInHours) return 'Unknown';
    if (ageInHours < 1) return `${Math.floor(ageInHours * 60)}m`;
    if (ageInHours < 24) return `${Math.floor(ageInHours)}h`;
    const days = Math.floor(ageInHours / 24);
    return `${days}d`;
  };

  const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
    ? groupPnL.totalPnLSOL > 0
      ? 'text-green-400'
      : groupPnL.totalPnLSOL < 0
      ? 'text-red-400'
      : 'text-gray-400'
    : 'text-gray-400';

  const isNewToken = enhancedData?.age?.isNew;
  const ageInHours = enhancedData?.age?.ageInHours;

  return (
    <div className="bg-gray-900 border border-gray-700 hover:border-gray-600 transition-colors">
      {/* Header Row */}
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <div className="flex items-center space-x-3 min-w-0 flex-1">
          {/* Token info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center space-x-2">
              <span className="bg-blue-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                {token.symbol || 'UNK'}
              </span>
              {isNewToken && (
                <span className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded animate-pulse">
                  NEW
                </span>
              )}
              <span className="text-gray-300 text-sm truncate">
                {token.name || 'Unknown Token'}
              </span>
            </div>
            <div className="flex items-center space-x-2 mt-1">
              <div className="text-gray-500 text-xs font-mono truncate max-w-32">
                {token.mint}
              </div>
              <button
                onClick={() => copyToClipboard(token.mint)}
                className="text-gray-500 hover:text-blue-400 transition-colors"
                title="Copy address"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              {ageInHours && (
                <span className="text-xs text-gray-500">
                  {formatAge(ageInHours)}
                </span>
              )}
            </div>
          </div>

          {/* Enhanced Stats */}
          <div className="text-right">
            <div className={`text-sm font-bold ${netColor} flex items-center`}>
              {loadingEnhanced && (
                <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
              )}
              {groupPnL && groupPnL.totalPnLSOL !== undefined
                ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                : '0 SOL'}
            </div>
            <div className="text-xs text-gray-500">
              {token.summary.uniqueWallets}W · {token.summary.totalBuys}B · {token.summary.totalSells}S
            </div>
            {enhancedData && (
              <div className="text-xs text-blue-400">
                ${formatNumber(enhancedData.price, 8)} · MC: ${formatNumber(enhancedData.marketCap)}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center space-x-1 ml-3">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
            title={showDetails ? "Hide details" : "Show details"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d={!showDetails ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7"} />
            </svg>
          </button>
          <button
            onClick={openGmgnChart}
            className="p-1 text-gray-500 hover:text-blue-400 transition-colors"
            title="Open chart"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Enhanced Details */}
      {showDetails && (
        <div className="p-3 bg-gray-800/50">
          {/* Enhanced Token Info */}
          {enhancedData && (
            <div className="grid grid-cols-2 gap-4 mb-3 text-xs">
              <div>
                <div className="text-gray-400 mb-1">Price</div>
                <div className="text-white font-medium">
                  ${enhancedData.price?.toFixed(8) || 'N/A'}
                  <div className="text-gray-500 text-xs">
                    {enhancedData.priceInSol?.toFixed(8) || 'N/A'} SOL
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Market Cap</div>
                <div className="text-white font-medium">
                  ${formatNumber(enhancedData.marketCap)}
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Liquidity</div>
                <div className="text-white font-medium">
                  ${formatNumber(enhancedData.liquidity)}
                  <div className="text-gray-500 text-xs">
                    {enhancedData.pools || 0} pools
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Age</div>
                <div className="text-white font-medium">
                  {formatAge(ageInHours)}
                  {isNewToken && (
                    <span className="text-red-400 text-xs ml-1">NEW!</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* PnL breakdown */}
          {groupPnL && (
            <div className="grid grid-cols-2 gap-4 mb-3 text-xs">
              <div>
                <div className="text-gray-400 mb-1">Holdings</div>
                <div className="text-white font-medium">
                  {formatNumber(groupPnL.currentHoldings, 0)} tokens
                  <span className="text-gray-500 ml-1">
                    ({groupPnL.holdingPercentage.toFixed(1)}%)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Current Value</div>
                <div className="text-white font-medium">
                  {groupPnL.currentHoldings > 0 && enhancedData ? 
                    `${formatNumber(groupPnL.currentHoldings * enhancedData.price)}` : 
                    '$0'
                  }
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Realized PnL</div>
                <div className={`font-medium ${groupPnL.realizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {groupPnL.realizedPnLSOL >= 0 ? '+' : ''}{groupPnL.realizedPnLSOL.toFixed(4)} SOL
                  <div className="text-xs text-gray-500">
                    ${formatNumber(groupPnL.realizedPnLUSD)}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Unrealized PnL</div>
                <div className={`font-medium ${groupPnL.unrealizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {groupPnL.unrealizedPnLSOL >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSOL.toFixed(4)} SOL
                  <div className="text-xs text-gray-500">
                    ${formatNumber(groupPnL.unrealizedPnLUSD)}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Total Spent/Received</div>
                <div className="text-white font-medium">
                  {groupPnL.totalSpentSOL.toFixed(4)} / {groupPnL.totalReceivedSOL.toFixed(4)} SOL
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Average Buy Price</div>
                <div className="text-white font-medium">
                  {groupPnL.totalTokensBought > 0 ? 
                    `${(groupPnL.totalSpentSOL / groupPnL.totalTokensBought).toFixed(8)} SOL` : 
                    'N/A'
                  }
                </div>
              </div>
            </div>
          )}

          {/* Best Pool Info */}
          {enhancedData?.bestPool && (
            <div className="mb-3 p-2 bg-gray-900/50 rounded text-xs">
              <div className="text-gray-400 mb-1">Best Pool ({enhancedData.bestPool.type})</div>
              <div className="flex justify-between text-white">
                <span>Liquidity: ${formatNumber(enhancedData.bestPool.liquidity)}</span>
                <span>Price: ${enhancedData.bestPool.priceInUsd?.toFixed(8) || 'N/A'}</span>
              </div>
            </div>
          )}

          {/* Top wallets */}
          <div className="space-y-1">
            <div className="text-gray-400 text-xs mb-2">Top Wallets</div>
            {token.wallets.slice(0, WALLETS_DISPLAY_LIMIT).map((wallet) => (
              <div key={wallet.address} className="flex items-center justify-between bg-gray-900/50 p-2 rounded text-xs">
                <div className="flex items-center space-x-2">
                  <span className="text-gray-300 font-medium">
                    {wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`}
                  </span>
                  <span className="text-gray-500">
                    {wallet.txBuys}B · {wallet.txSells}S
                  </span>
                </div>
                <div className={`font-medium ${wallet.pnlSol > 0 ? 'text-green-400' : wallet.pnlSol < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                  {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
                </div>
              </div>
            ))}
            
            {token.wallets.length > WALLETS_DISPLAY_LIMIT && (
              <div className="text-center">
                <span className="text-gray-500 text-xs">
                  +{token.wallets.length - WALLETS_DISPLAY_LIMIT} more wallets
                </span>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex space-x-2 mt-3">
            <button
              onClick={onOpenChart}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded text-sm font-medium transition-colors"
              disabled={loadingEnhanced}
            >
              {loadingEnhanced ? 'Loading...' : 'Chart'}
            </button>
            <button
              onClick={openGmgnChart}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded text-sm font-medium transition-colors"
            >
              GMGN
            </button>
            {enhancedData?.bestPool && (
              <button
                onClick={() => copyToClipboard(enhancedData.bestPool.address)}
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-2 rounded text-sm font-medium transition-colors"
                title="Copy pool address"
              >
                Pool
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TokenCard;