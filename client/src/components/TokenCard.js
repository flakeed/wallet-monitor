import React from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart, enhanced = false }) {
  // Use enhanced data if available, otherwise calculate locally
  const hasEnhancedData = enhanced && token.priceData && token.metrics;
  
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

  // Get metrics from enhanced data or calculate locally
  const getMetrics = () => {
    if (hasEnhancedData) {
      return {
        totalTokensHeld: token.summary.totalTokensHeld || 0,
        totalSpentSOL: token.summary.totalSpentSOL || 0,
        unrealizedPnlSOL: token.summary.unrealizedPnlSOL || 0,
        currentPrice: token.summary.currentPrice || 0,
        currentValueSOL: token.summary.currentValueSOL || 0,
        totalPnlSOL: token.summary.totalPnlSOL || 0
      };
    } else {
      // Fallback calculation for basic mode
      const totalTokensHeld = token.wallets.reduce((sum, wallet) => {
        return sum + (wallet.tokensBought - wallet.tokensSold);
      }, 0);

      const totalSpentSOL = token.wallets.reduce((sum, wallet) => {
        return sum + wallet.solSpent;
      }, 0);

      return {
        totalTokensHeld,
        totalSpentSOL,
        unrealizedPnlSOL: 0, // Not available in basic mode
        currentPrice: 0,
        currentValueSOL: 0,
        totalPnlSOL: token.summary.netSOL || 0
      };
    }
  };

  const metrics = getMetrics();
  const unrealizedColor = metrics.unrealizedPnlSOL > 0 ? 'text-green-700' : 
                         metrics.unrealizedPnlSOL < 0 ? 'text-red-700' : 'text-gray-700';
  
  const totalPnlColor = metrics.totalPnlSOL > 0 ? 'text-green-700' : 
                       metrics.totalPnlSOL < 0 ? 'text-red-700' : 'text-gray-700';

  // Function to copy text to clipboard
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        console.log('Address copied to clipboard:', text);
      })
      .catch((err) => {
        console.error('Failed to copy address:', err);
      });
  };

  // Function to open chart in new window
  const openGmgnChartInNewWindow = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">{token.symbol || 'Unknown'}</span>
            <span className="text-gray-600 truncate">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="text-xs text-gray-500 font-mono truncate">{token.mint}</div>
            <button
              onClick={() => copyToClipboard(token.mint)}
              className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
              title="Copy address"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-base font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          <div className="text-xs text-gray-500">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
          </div>
        </div>
      </div>

      {/* Enhanced metrics section */}
      <div className="mb-3 p-2 bg-white rounded border">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-gray-500">Total Tokens:</span>
            <div className="font-semibold">{metrics.totalTokensHeld.toFixed(2)}</div>
          </div>
          <div>
            <span className="text-gray-500">Total Spent:</span>
            <div className="font-semibold">{metrics.totalSpentSOL.toFixed(4)} SOL</div>
          </div>
          <div>
            <span className="text-gray-500">Current Price:</span>
            <div className="font-semibold">
              {hasEnhancedData ? 
                metrics.currentPrice > 0 ? `${metrics.currentPrice.toFixed(8)} SOL` : 'N/A'
                : 'Basic Mode'
              }
            </div>
          </div>
          <div>
            <span className="text-gray-500">
              {hasEnhancedData ? 'Unrealized PnL:' : 'Realized PnL:'}
            </span>
            <div className={`font-semibold ${hasEnhancedData ? unrealizedColor : totalPnlColor}`}>
              {hasEnhancedData ? 
                metrics.currentPrice > 0 ? 
                  `${metrics.unrealizedPnlSOL > 0 ? '+' : ''}${metrics.unrealizedPnlSOL.toFixed(4)} SOL` : 
                  'N/A'
                : `${metrics.totalPnlSOL > 0 ? '+' : ''}${metrics.totalPnlSOL.toFixed(4)} SOL`
              }
            </div>
          </div>
          {hasEnhancedData && (
            <>
              <div>
                <span className="text-gray-500">Current Value:</span>
                <div className="font-semibold">
                  {metrics.currentValueSOL > 0 ? `${metrics.currentValueSOL.toFixed(4)} SOL` : 'N/A'}
                </div>
              </div>
              <div>
                <span className="text-gray-500">Total PnL:</span>
                <div className={`font-semibold ${totalPnlColor}`}>
                  {metrics.totalPnlSOL > 0 ? '+' : ''}{metrics.totalPnlSOL.toFixed(4)} SOL
                </div>
              </div>
            </>
          )}
        </div>
        {hasEnhancedData && token.priceData && (
          <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-gray-500">USD Price:</span>
              <div className="font-semibold">${token.priceData.priceUsd?.toFixed(6) || 'N/A'}</div>
            </div>
            <div>
              <span className="text-gray-500">24h Change:</span>
              <div className={`font-semibold ${
                (token.priceData.priceChange24h || 0) > 0 ? 'text-green-600' : 
                (token.priceData.priceChange24h || 0) < 0 ? 'text-red-600' : 'text-gray-600'
              }`}>
                {token.priceData.priceChange24h ? 
                  `${token.priceData.priceChange24h > 0 ? '+' : ''}${token.priceData.priceChange24h.toFixed(2)}%` : 
                  'N/A'
                }
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {token.wallets.map((w) => (
          <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
        ))}
      </div>
      <div className="mt-2 flex space-x-2">
        <button
          onClick={onOpenChart}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
        >
          Open Chart
        </button>
        <button
          onClick={openGmgnChartInNewWindow}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
        >
          Open in New Window
        </button>
      </div>
    </div>
  );
}

export default TokenCard;