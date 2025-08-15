// client/src/components/TokenCard.js
import React from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
  const netColor = token.summary.totalPnL > 0 ? 'text-green-700' : token.summary.totalPnL < 0 ? 'text-red-700' : 'text-gray-700';

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

  // Function to format percentage
  const formatPercentage = (current, cost) => {
    if (!cost || cost === 0) return '0.00%';
    const percentage = ((current - cost) / cost) * 100;
    return `${percentage >= 0 ? '+' : ''}${percentage.toFixed(2)}%`;
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2 mb-1">
            <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">
              {token.symbol || 'Unknown'}
            </span>
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
        
        {/* Enhanced stats section */}
        <div className="text-right">
          <div className={`text-base font-bold ${netColor} mb-1`}>
            Total PnL: {token.summary.totalPnL > 0 ? '+' : ''}{token.summary.totalPnL.toFixed(4)} SOL
          </div>
          
          {/* Price and percentage change */}
          {token.summary.currentPrice > 0 && (
            <div className="text-xs text-gray-600 mb-1">
              Price: ${token.summary.currentPrice.toFixed(6)}
            </div>
          )}
          
          {/* Holdings info */}
          <div className="text-xs text-gray-500 space-y-1">
            <div>
              Spent: {token.summary.totalSpentSOL.toFixed(4)} SOL
            </div>
            <div>
              Current Value: {token.summary.currentValue.toFixed(4)} SOL
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div className={`${token.summary.totalRealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                Realized: {token.summary.totalRealizedPnL >= 0 ? '+' : ''}{token.summary.totalRealizedPnL.toFixed(4)}
              </div>
              <div className={`${token.summary.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                Unrealized: {token.summary.totalUnrealizedPnL >= 0 ? '+' : ''}{token.summary.totalUnrealizedPnL.toFixed(4)}
              </div>
            </div>
          </div>
          
          <div className="text-xs text-gray-500 mt-1">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
          </div>
        </div>
      </div>

      {/* Holdings summary */}
      <div className="mb-3 p-2 bg-white rounded border">
        <div className="flex justify-between items-center text-xs">
          <span className="text-gray-600">Total Holdings:</span>
          <span className="font-semibold">
            {token.summary.totalTokensHeld.toLocaleString()} {token.symbol}
          </span>
        </div>
        {token.summary.currentPrice > 0 && token.summary.totalSpentSOL > 0 && (
          <div className="flex justify-between items-center text-xs mt-1">
            <span className="text-gray-600">Performance:</span>
            <span className={`font-semibold ${token.summary.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {formatPercentage(token.summary.currentValue, token.summary.totalSpentSOL)}
            </span>
          </div>
        )}
      </div>

      {/* Wallet breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        {token.wallets.map((w) => (
          <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex space-x-2">
        <button
          onClick={onOpenChart}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition text-sm"
        >
          Open Chart
        </button>
        <button
          onClick={openGmgnChartInNewWindow}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition text-sm"
        >
          Open in New Window
        </button>
      </div>
    </div>
  );
}

export default TokenCard;