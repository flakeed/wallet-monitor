import React, { useState, useEffect, useMemo } from 'react';

function EnhancedTokenCard({ token, onOpenChart }) {
  const [showDetails, setShowDetails] = useState(false);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const WALLETS_DISPLAY_LIMIT = 3;

  // Fetch detailed token info when card is expanded
  useEffect(() => {
    if (showDetails && !tokenInfo && !loading) {
      fetchTokenInfo();
    }
  }, [showDetails]);

  const fetchTokenInfo = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const sessionToken = localStorage.getItem('sessionToken');
      const response = await fetch(`/api/tokens/${token.mint}/info`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      setTokenInfo(data.data);
    } catch (err) {
      console.error('Error fetching token info:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Enhanced PnL calculation with RPC price data
  const groupPnL = useMemo(() => {
    if (!token.wallets || token.wallets.length === 0) return null;

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

    // Use enhanced price data if available
    const currentPrice = tokenInfo?.priceData?.price || 0;
    const solPrice = 150; // This should come from context/props
    
    if (currentHoldings > 0 && currentPrice > 0) {
      const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
      const currentMarketValueSOL = (currentHoldings * currentPrice) / solPrice;
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
      currentPrice,
      solPrice,
      soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
      holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0,
      profitMargin: totalSpentSOL > 0 ? ((totalPnLSOL / totalSpentSOL) * 100) : 0
    };
  }, [token.wallets, tokenInfo]);

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

  const formatTime = (timestamp) => {
    if (!timestamp) return 'Unknown';
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const getAgeColor = (ageHours) => {
    if (!ageHours) return 'text-gray-500';
    if (ageHours < 1) return 'text-red-400'; // Very new
    if (ageHours < 24) return 'text-orange-400'; // New
    if (ageHours < 168) return 'text-yellow-400'; // This week
    return 'text-green-400'; // Older
  };

  const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
    ? groupPnL.totalPnLSOL > 0
      ? 'text-green-400'
      : groupPnL.totalPnLSOL < 0
      ? 'text-red-400'
      : 'text-gray-400'
    : 'text-gray-400';

  return (
    <div className="bg-gray-900 border border-gray-700 hover:border-gray-600 transition-all duration-200 rounded-lg overflow-hidden">
      {/* Header Row */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <div className="flex items-center space-x-3 min-w-0 flex-1">
          {/* Token info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center space-x-2">
              <span className="bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded">
                {token.symbol || 'UNK'}
              </span>
              <span className="text-gray-300 text-sm truncate">
                {token.name || 'Unknown Token'}
              </span>
              {tokenInfo?.ageHours && (
                <span className={`text-xs px-1 py-0.5 rounded ${getAgeColor(tokenInfo.ageHours)}`}>
                  {tokenInfo.ageHours < 1 ? '<1h' :
                   tokenInfo.ageHours < 24 ? `${Math.floor(tokenInfo.ageHours)}h` :
                   tokenInfo.ageHours < 168 ? `${Math.floor(tokenInfo.ageHours / 24)}d` :
                   `${Math.floor(tokenInfo.ageHours / 168)}w`}
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
              {loading && (
                <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
              )}
              {groupPnL && groupPnL.totalPnLSOL !== undefined
                ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                : '0 SOL'}
            </div>
            <div className="text-xs text-gray-500">
              {token.summary?.uniqueWallets || 0}W · {token.summary?.totalBuys || 0}B · {token.summary?.totalSells || 0}S
            </div>
            {groupPnL?.profitMargin !== undefined && (
              <div className={`text-xs ${netColor}`}>
                {groupPnL.profitMargin >= 0 ? '+' : ''}{groupPnL.profitMargin.toFixed(1)}%
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center space-x-1 ml-3">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors rounded"
            title={showDetails ? "Hide details" : "Show details"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d={!showDetails ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7"} />
            </svg>
          </button>
          <button
            onClick={openGmgnChart}
            className="p-1.5 text-gray-500 hover:text-blue-400 transition-colors rounded"
            title="Open chart"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Details (collapsible) */}
      {showDetails && (
        <div className="p-4 bg-gray-800/50 space-y-4">
          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mr-3"></div>
              <span className="text-gray-400">Loading detailed info...</span>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="bg-red-900/20 border border-red-700 rounded p-3">
              <div className="text-red-400 text-sm">Failed to load token details: {error}</div>
            </div>
          )}

          {/* Enhanced token information */}
          {tokenInfo && (
            <>
              {/* Price and Market Data */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <div className="text-gray-400 mb-1">Current Price</div>
                  <div className="text-white font-medium">
                    ${tokenInfo.priceData?.price?.toFixed(8) || '0.00000000'}
                  </div>
                  <div className="text-gray-500 text-xs">
                    Source: {tokenInfo.priceData?.source || 'Unknown'}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Market Cap</div>
                  <div className="text-white font-medium">
                    ${formatNumber(tokenInfo.priceData?.marketCap || 0)}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Liquidity</div>
                  <div className="text-white font-medium">
                    ${formatNumber(tokenInfo.priceData?.liquidity || 0)}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Pools</div>
                  <div className="text-white font-medium">
                    {tokenInfo.priceData?.pools?.length || 0} found
                  </div>
                </div>
              </div>

              {/* Token Info */}
              {tokenInfo.deployedAt && (
                <div className="bg-gray-900/50 p-3 rounded">
                  <div className="text-gray-400 text-xs mb-2">Token Information</div>
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="text-gray-500">Deployed</div>
                      <div className="text-white">{formatTime(tokenInfo.deployedAt)}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Supply</div>
                      <div className="text-white">{formatNumber(tokenInfo.supply / Math.pow(10, tokenInfo.decimals))}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Decimals</div>
                      <div className="text-white">{tokenInfo.decimals}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Age</div>
                      <div className={`font-medium ${getAgeColor(tokenInfo.ageHours)}`}>
                        {tokenInfo.ageHours < 1 ? 'Less than 1 hour' :
                         tokenInfo.ageHours < 24 ? `${Math.floor(tokenInfo.ageHours)} hours` :
                         tokenInfo.ageHours < 168 ? `${Math.floor(tokenInfo.ageHours / 24)} days` :
                         `${Math.floor(tokenInfo.ageHours / 168)} weeks`}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* PnL breakdown */}
          {groupPnL && (
            <div className="bg-gray-900/50 p-3 rounded">
              <div className="text-gray-400 text-xs mb-2">Portfolio Analysis</div>
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
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Unrealized PnL</div>
                  <div className={`font-medium ${groupPnL.unrealizedPnLSOL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {groupPnL.unrealizedPnLSOL >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSOL.toFixed(4)} SOL
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Total Invested</div>
                  <div className="text-white font-medium">
                    {groupPnL.totalSpentSOL.toFixed(4)} SOL
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Avg Buy Price</div>
                  <div className="text-white font-medium">
                    ${(groupPnL.totalSpentSOL * groupPnL.solPrice / groupPnL.totalTokensBought).toFixed(8)}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400 mb-1">Profit Margin</div>
                  <div className={`font-medium ${netColor}`}>
                    {groupPnL.profitMargin >= 0 ? '+' : ''}{groupPnL.profitMargin.toFixed(2)}%
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Top wallets */}
          {token.wallets && token.wallets.length > 0 && (
            <div>
              <div className="text-gray-400 text-xs mb-2">Top Performing Wallets</div>
              <div className="space-y-2">
                {token.wallets.slice(0, WALLETS_DISPLAY_LIMIT).map((wallet) => (
                  <div key={wallet.address} className="flex items-center justify-between bg-gray-900/50 p-2 rounded text-xs">
                    <div className="flex items-center space-x-2">
                      <span className="text-gray-300 font-medium">
                        {wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`}
                      </span>
                      <span className="text-gray-500">
                        {wallet.txBuys}B · {wallet.txSells}S
                      </span>
                      {wallet.tokensBought > 0 && (
                        <span className="text-blue-400">
                          {formatNumber(wallet.currentHoldings || (wallet.tokensBought - wallet.tokensSold))} held
                        </span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2">
                      <div className={`font-medium ${wallet.pnlSol > 0 ? 'text-green-400' : wallet.pnlSol < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                        {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
                      </div>
                      <button
                        onClick={() => {
                          const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}?maker=${encodeURIComponent(wallet.address)}`;
                          window.open(gmgnUrl, '_blank');
                        }}
                        className="text-gray-500 hover:text-blue-400 transition-colors p-1 rounded"
                        title="View wallet's trades"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
                
                {token.wallets.length > WALLETS_DISPLAY_LIMIT && (
                  <div className="text-center py-2">
                    <span className="text-gray-500 text-xs">
                      +{token.wallets.length - WALLETS_DISPLAY_LIMIT} more wallets
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Enhanced action buttons */}
          <div className="flex space-x-2 pt-2 border-t border-gray-700">
            <button
              onClick={onOpenChart}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-3 rounded text-sm font-medium transition-colors flex items-center justify-center"
              disabled={loading}
            >
              {loading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></div>
              ) : (
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              )}
              Chart
            </button>
            
            <button
              onClick={openGmgnChart}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 px-3 rounded text-sm font-medium transition-colors flex items-center justify-center"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              GMGN
            </button>
            
            {tokenInfo && (
              <button
                onClick={() => {
                  const dexscreenerUrl = `https://dexscreener.com/solana/${token.mint}`;
                  window.open(dexscreenerUrl, '_blank');
                }}
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-2 px-3 rounded text-sm font-medium transition-colors flex items-center justify-center"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
                DEX
              </button>
            )}
          </div>

          {/* Data freshness indicator */}
          {tokenInfo && (
            <div className="text-center pt-2 border-t border-gray-700">
              <div className="text-gray-500 text-xs">
                Data updated: {formatTime(tokenInfo.lastUpdated)} 
                <span className="ml-2 px-2 py-1 bg-green-900/30 text-green-400 rounded">
                  RPC Enhanced
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default EnhancedTokenCard;