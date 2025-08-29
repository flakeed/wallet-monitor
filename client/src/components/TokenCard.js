// client/src/components/EnhancedTokenCard.js - Обновленная карточка токена с OnChain данными

import React, { useState, useMemo } from 'react';
import { useEnhancedPrices, useTokenInfo, useTokenPools } from '../hooks/useEnhancedPrices';

function EnhancedTokenCard({ token, onOpenChart, showDetailedInfo = false }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showPoolInfo, setShowPoolInfo] = useState(false);
  
  const { solPrice, tokenPrice: priceData, loading: loadingPrice, metadata } = useEnhancedPrices(token.mint);
  const { tokenInfo, loading: loadingInfo } = useTokenInfo(showDetailedInfo ? token.mint : null);
  const { pools, summary: poolSummary, loading: loadingPools } = useTokenPools(showPoolInfo ? token.mint : null);

  const WALLETS_DISPLAY_LIMIT = 3;

  // Enhanced PnL calculation с использованием точных OnChain данных
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
      // Enhanced данные
      priceSource: metadata?.token?.source || 'unknown',
      marketCap: tokenInfo?.marketCap || 0,
      liquidity: priceData?.liquidity || poolSummary?.totalLiquidity || 0
    };
  }, [priceData, solPrice, token.wallets, metadata, tokenInfo, poolSummary]);

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

  const formatCurrency = (num, currency = 'USD') => {
    if (num === null || num === undefined) return '$0';
    const formatted = formatNumber(num, 2);
    return currency === 'USD' ? `$${formatted}` : `${formatted} ${currency}`;
  };

  const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
    ? groupPnL.totalPnLSOL > 0
      ? 'text-green-400'
      : groupPnL.totalPnLSOL < 0
      ? 'text-red-400'
      : 'text-gray-400'
    : 'text-gray-400';

  // Определить цвет источника данных
  const getSourceColor = (source) => {
    switch (source) {
      case 'onchain':
      case 'onchain_pools':
        return 'text-green-500';
      case 'memory_cache':
      case 'redis_cache':
        return 'text-blue-500';
      case 'dexscreener':
      case 'jupiter':
        return 'text-yellow-500';
      default:
        return 'text-gray-500';
    }
  };

  const getSourceIcon = (source) => {
    switch (source) {
      case 'onchain':
      case 'onchain_pools':
        return '⛓️';
      case 'memory_cache':
      case 'redis_cache':
        return '💾';
      case 'dexscreener':
      case 'jupiter':
        return '🌐';
      default:
        return '❓';
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-700 hover:border-gray-600 transition-colors">
      {/* Header Row */}
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <div className="flex items-center space-x-3 min-w-0 flex-1">
          {/* Token info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center space-x-2">
              <span className="bg-blue-600 text-white text-xs font-bold px-2 py-0.5 rounded">
                {token.symbol || tokenInfo?.symbol || 'UNK'}
              </span>
              <span className="text-gray-300 text-sm truncate">
                {token.name || tokenInfo?.name || 'Unknown Token'}
              </span>
              
              {/* Enhanced: Источник данных */}
              {metadata?.token?.source && (
                <span 
                  className={`text-xs px-1 py-0.5 rounded ${getSourceColor(metadata.token.source)}`}
                  title={`Price source: ${metadata.token.source}`}
                >
                  {getSourceIcon(metadata.token.source)}
                </span>
              )}
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

          {/* Stats */}
          <div className="text-right">
            <div className={`text-sm font-bold ${netColor} flex items-center`}>
              {(loadingPrice || loadingInfo) && (
                <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
              )}
              {groupPnL && groupPnL.totalPnLSOL !== undefined
                ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                : '0 SOL'}
            </div>
            
            {/* Enhanced: Market Cap и Liquidity */}
            <div className="text-xs text-gray-500">
              {tokenInfo?.marketCap > 0 && (
                <span>MC: {formatCurrency(tokenInfo.marketCap)} • </span>
              )}
              {groupPnL?.liquidity > 0 && (
                <span>LIQ: {formatCurrency(groupPnL.liquidity)} • </span>
              )}
              <span>{token.summary.uniqueWallets}W · {token.summary.totalBuys}B · {token.summary.totalSells}S</span>
            </div>
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
          
          {/* Enhanced: Pool info button */}
          <button
            onClick={() => setShowPoolInfo(!showPoolInfo)}
            className="p-1 text-gray-500 hover:text-purple-400 transition-colors"
            title="Pool information"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z" />
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

      {/* Enhanced Pool Information */}
      {showPoolInfo && (
        <div className="p-3 bg-purple-900/20 border-b border-purple-800/30">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-purple-400 text-sm font-medium">Pool Information</h4>
            {loadingPools && (
              <div className="animate-spin rounded-full h-4 w-4 border border-purple-400 border-t-transparent"></div>
            )}
          </div>
          
          {poolSummary ? (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-gray-400">Total Pools</div>
                <div className="text-white font-medium">
                  {poolSummary.totalPools} ({poolSummary.activePools} active)
                </div>
              </div>
              <div>
                <div className="text-gray-400">Total Liquidity</div>
                <div className="text-white font-medium">
                  {formatCurrency(poolSummary.totalLiquidity)}
                </div>
              </div>
              <div>
                <div className="text-gray-400">DEXes</div>
                <div className="text-white font-medium">
                  {poolSummary.dexes.join(', ')}
                </div>
              </div>
              <div>
                <div className="text-gray-400">Best Pool</div>
                <div className="text-white font-medium text-xs">
                  {poolSummary.bestPool ? 
                    `${poolSummary.bestPool.dex} (${formatCurrency(poolSummary.bestPool.priceData?.liquidity || 0)})` : 
                    'N/A'
                  }
                </div>
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-sm">
              {loadingPools ? 'Loading pool information...' : 'No pool data available'}
            </div>
          )}
        </div>
      )}

      {/* Details (collapsible) */}
      {showDetails && (
        <div className="p-3 bg-gray-800/50">
          {/* Enhanced PnL breakdown */}
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
                <div className="text-gray-400 mb-1">Current Price</div>
                <div className="text-white font-medium">
                  {formatCurrency(groupPnL.currentPriceUSD)}
                  <span className={`ml-1 text-xs ${getSourceColor(groupPnL.priceSource)}`}>
                    {getSourceIcon(groupPnL.priceSource)}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Realized PnL</div>
                <div className={`font-medium ${groupPnL.realizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {groupPnL.realizedPnLSOL >= 0 ? '+' : ''}{groupPnL.realizedPnLSOL.toFixed(4)} SOL
                  <div className="text-xs text-gray-500">
                    {formatCurrency(groupPnL.realizedPnLUSD)}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-gray-400 mb-1">Unrealized PnL</div>
                <div className={`font-medium ${groupPnL.unrealizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {groupPnL.unrealizedPnLSOL >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSOL.toFixed(4)} SOL
                  <div className="text-xs text-gray-500">
                    {formatCurrency(groupPnL.unrealizedPnLUSD)}
                  </div>
                </div>
              </div>
              
              {/* Enhanced data row */}
              {(groupPnL.marketCap > 0 || groupPnL.liquidity > 0) && (
                <>
                  <div>
                    <div className="text-gray-400 mb-1">Market Cap</div>
                    <div className="text-white font-medium">
                      {groupPnL.marketCap > 0 ? formatCurrency(groupPnL.marketCap) : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-400 mb-1">Total Liquidity</div>
                    <div className="text-white font-medium">
                      {groupPnL.liquidity > 0 ? formatCurrency(groupPnL.liquidity) : 'N/A'}
                    </div>
                  </div>
                </>
              )}
              
              <div>
                <div className="text-gray-400 mb-1">Total Spent/Received</div>
                <div className="text-white font-medium">
                  {groupPnL.totalSpentSOL.toFixed(4)} / {groupPnL.totalReceivedSOL.toFixed(4)} SOL
                </div>
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

          {/* Enhanced: Token creation info */}
          {tokenInfo?.createdAt && (
            <div className="mt-3 pt-3 border-t border-gray-700">
              <div className="text-xs text-gray-500">
                Created: {new Date(tokenInfo.createdAt).toLocaleDateString()} • 
                Age: {Math.floor((Date.now() - new Date(tokenInfo.createdAt).getTime()) / (1000 * 60 * 60 * 24))} days
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex space-x-2 mt-3">
            <button
              onClick={onOpenChart}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded text-sm font-medium transition-colors"
              disabled={loadingPrice}
            >
              {loadingPrice ? 'Loading...' : 'Chart'}
            </button>
            <button
              onClick={openGmgnChart}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 rounded text-sm font-medium transition-colors"
            >
              GMGN
            </button>
            
            {/* Enhanced: Direct pool link */}
            {poolSummary?.bestPool && (
              <button
                onClick={() => {
                  const poolUrl = `https://dexscreener.com/solana/${poolSummary.bestPool.address}`;
                  window.open(poolUrl, '_blank');
                }}
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-2 rounded text-sm font-medium transition-colors"
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

export default EnhancedTokenCard;