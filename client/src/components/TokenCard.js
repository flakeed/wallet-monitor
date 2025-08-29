// client/src/components/EnhancedTokenCard.js - TokenCard с поддержкой пулов

import React, { useState, useMemo } from 'react';
import { useEnhancedPrices, useRefreshTokenPrice, useBestTokenPrice } from '../hooks/useEnhancedPrices';
import PriceSourceIndicator, { PriceComparison } from './PriceSourceIndicator';

function EnhancedTokenCard({ token, onOpenChart }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showPriceComparison, setShowPriceComparison] = useState(false);
  
  const { solPrice, tokenPrice: priceData, loading: loadingPrice, sources } = useEnhancedPrices(token.mint);
  const { refreshPrice, loading: refreshing } = useRefreshTokenPrice();
  const { bestPrice, alternatives, loading: loadingBest } = useBestTokenPrice(showPriceComparison ? token.mint : null);

  const WALLETS_DISPLAY_LIMIT = 3;

  // Компактный расчет PnL с улучшениями
  const groupPnL = useMemo(() => {
    if (!priceData || !priceData.price || !solPrice) return null;

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
      const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
      const currentMarketValueSOL = (currentHoldings * priceData.price) / solPrice;
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
      currentPriceUSD: priceData.price,
      solPrice,
      soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
      holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0,
      priceSource: sources.token
    };
  }, [priceData, solPrice, token.wallets, sources.token]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const openGmgnChart = () => {
    if (!token.mint) return;
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  const handleRefreshPrice = async () => {
    try {
      await refreshPrice(token.mint);
    } catch (error) {
      console.error('Failed to refresh price:', error);
    }
  };

  const formatNumber = (num, decimals = 2) => {
    if (num === null || num === undefined) return '0';
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toFixed(decimals);
  };

  const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
    ? groupPnL.totalPnLSOL > 0
      ? 'text-green-400'
      : groupPnL.totalPnLSOL < 0
      ? 'text-red-400'
      : 'text-gray-400'
    : 'text-gray-400';

  // Определяем качество цены для цветовой индикации
  const getPriceQuality = (source) => {
    switch (source) {
      case 'pools': return 'border-l-green-500';
      case 'hybrid': return 'border-l-purple-500';
      case 'dexscreener': return 'border-l-blue-500';
      case 'fallback': return 'border-l-yellow-500';
      default: return 'border-l-gray-500';
    }
  };

  return (
    <div className={`bg-gray-900 border border-gray-700 hover:border-gray-600 transition-colors border-l-4 ${getPriceQuality(sources.token)}`}>
      {/* Header Row */}
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <div className="flex items-center space-x-3 min-w-0 flex-1">
          {/* Token info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center space-x-2">
              <span className="bg-blue-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                {token.symbol || 'UNK'}
              </span>
              <span className="text-gray-300 text-sm truncate">
                {token.name || 'Unknown Token'}
              </span>
              {/* Price source indicator */}
              <PriceSourceIndicator 
                source={sources.token} 
                tokenMint={token.mint}
                showDetails={showDetails}
                className="ml-1"
              />
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
            </div>
          </div>

          {/* Stats and Price */}
          <div className="text-right">
            <div className="flex items-center space-x-2">
              <div className={`text-sm font-bold ${netColor} flex items-center`}>
                {loadingPrice && (
                  <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
                )}
                {groupPnL && groupPnL.totalPnLSOL !== undefined
                  ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                  : '0 SOL'}
              </div>
              
              {/* Refresh button */}
              <button
                onClick={handleRefreshPrice}
                disabled={refreshing}
                className="text-gray-500 hover:text-blue-400 transition-colors p-1 rounded"
                title="Refresh price"
              >
                {refreshing ? (
                  <div className="animate-spin rounded-full h-3 w-3 border border-blue-400 border-t-transparent"></div>
                ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                )}
              </button>
            </div>
            
            <div className="text-xs text-gray-500">
              {token.summary.uniqueWallets}W · {token.summary.totalBuys}B · {token.summary.totalSells}S
            </div>

            {/* Current price display */}
            {priceData && priceData.price > 0 && (
              <div className="text-xs text-blue-400 mt-1">
                ${priceData.price.toFixed(8)}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center space-x-1 ml-3">
          <button
            onClick={() => setShowPriceComparison(!showPriceComparison)}
            className="p-1 text-gray-500 hover:text-purple-400 transition-colors"
            title="Compare prices"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
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

      {/* Price Comparison Section */}
      {showPriceComparison && (
        <div className="border-b border-gray-800">
          <PriceComparison tokenMint={token.mint} />
        </div>
      )}

      {/* Details (collapsible) */}
      {showDetails && (
        <div className="p-3 bg-gray-800/50">
          {/* Enhanced PnL breakdown */}
          {groupPnL && (
            <div className="space-y-3 mb-4">
              <div className="grid grid-cols-2 gap-4 text-xs">
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
                  <div className="text-gray-400 mb-1">Realized PnL</div>
                  <div className={`font-medium ${groupPnL.realizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {groupPnL.realizedPnLSOL >= 0 ? '+' : ''}{groupPnL.realizedPnLSOL.toFixed(4)} SOL
                    <div className="text-xs text-gray-500">
                      ${groupPnL.realizedPnLUSD.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Unrealized PnL</div>
                  <div className={`font-medium ${groupPnL.unrealizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {groupPnL.unrealizedPnLSOL >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSOL.toFixed(4)} SOL
                    <div className="text-xs text-gray-500">
                      ${groupPnL.unrealizedPnLUSD.toFixed(2)}
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Total Spent/Received</div>
                  <div className="text-white font-medium">
                    {groupPnL.totalSpentSOL.toFixed(4)} / {groupPnL.totalReceivedSOL.toFixed(4)} SOL
                  </div>
                </div>
              </div>

              {/* Price info section */}
              {priceData && priceData.price > 0 && (
                <div className="bg-gray-900/50 rounded p-2 text-xs">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-gray-400">Current Price Info</span>
                    <PriceSourceIndicator source={sources.token} showDetails={true} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-gray-400">Price USD:</span>
                      <span className="text-white ml-1">${priceData.price.toFixed(8)}</span>
                    </div>
                    {priceData.liquidity > 0 && (
                      <div>
                        <span className="text-gray-400">Liquidity:</span>
                        <span className="text-white ml-1">${formatNumber(priceData.liquidity)}</span>
                      </div>
                    )}
                    {priceData.volume24h > 0 && (
                      <div>
                        <span className="text-gray-400">24h Volume:</span>
                        <span className="text-white ml-1">${formatNumber(priceData.volume24h)}</span>
                      </div>
                    )}
                    {priceData.change24h !== undefined && (
                      <div>
                        <span className="text-gray-400">24h Change:</span>
                        <span className={`ml-1 ${priceData.change24h >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {priceData.change24h >= 0 ? '+' : ''}{priceData.change24h.toFixed(2)}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
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
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded text-sm font-medium transition-colors flex items-center justify-center"
              disabled={loadingPrice}
            >
              {loadingPrice ? (
                <>
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white mr-2"></div>
                  Loading...
                </>
              ) : (
                'Chart'
              )}
            </button>
            <button
              onClick={openGmgnChart}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded text-sm font-medium transition-colors"
            >
              GMGN
            </button>
            <button
              onClick={handleRefreshPrice}
              disabled={refreshing}
              className="px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white py-2 rounded text-sm font-medium transition-colors flex items-center"
              title="Force refresh price"
            >
              {refreshing ? (
                <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
              ) : (
                '🔄'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default EnhancedTokenCard;