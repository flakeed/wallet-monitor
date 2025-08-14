// client/src/components/TokenCard.js
import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
  const [priceData, setPriceData] = useState(null);
  const [loading, setLoading] = useState(false);
  
  // Define colors for metrics
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';
  const totalPnLColor = (token.summary.totalPnL || token.summary.netSOL || 0) > 0 ? 'text-green-700' : 'text-red-700';
  const unrealizedColor = (token.summary.totalUnrealizedPnL || 0) > 0 ? 'text-green-600' : (token.summary.totalUnrealizedPnL || 0) < 0 ? 'text-red-600' : 'text-gray-600';

  // Copy to clipboard function
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => console.log('Address copied:', text))
      .catch((err) => console.error('Failed to copy:', err));
  };

  // Open chart in new window
  const openGmgnChartInNewWindow = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  // Format numbers
  const formatNumber = (num) => {
    if (num == null) return '0';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
  };

  return (
    <div className="border rounded-lg p-4 bg-gradient-to-br from-gray-50 to-white shadow-sm hover:shadow-md transition-shadow">
      {/* Header Section */}
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2 mb-1">
            <span className="text-sm px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-semibold">
              {token.symbol || 'Unknown'}
            </span>
            <span className="text-gray-600 truncate text-sm">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="text-xs text-gray-500 font-mono truncate">{token.mint}</div>
            <button
              onClick={() => copyToClipboard(token.mint)}
              className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
              title="Copy address"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
        
        {/* Price and Stats */}
        <div className="text-right">
          {token.currentPrice && (
            <div className="text-xs text-gray-500 mb-1">
              ${formatNumber(token.currentPrice.priceInUSD)} 
              <span className="text-gray-400 ml-1">({formatNumber(token.currentPrice.priceInSOL)} SOL)</span>
            </div>
          )}
          <div className="text-xs text-gray-500">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
          </div>
        </div>
      </div>

      {/* PnL Summary Section */}
      <div className="bg-gray-50 rounded-lg p-3 mb-3">
        <div className="grid grid-cols-3 gap-3">
          {/* Realized PnL */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Realized P&L</div>
            <div className={`text-sm font-bold ${netColor}`}>
              {(token.summary.netSOL || 0) > 0 ? '+' : ''}{(token.summary.netSOL || 0).toFixed(4)} SOL
            </div>
          </div>
          
          {/* Unrealized PnL */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Unrealized P&L</div>
            <div className={`text-sm font-bold ${unrealizedColor}`}>
              {(token.summary.totalUnrealizedPnL || 0) > 0 ? '+' : ''}{(token.summary.totalUnrealizedPnL || 0).toFixed(4)} SOL
            </div>
          </div>
          
          {/* Total PnL */}
          <div>
            <div className="text-xs text-gray-500 mb-1">Total P&L</div>
            <div className={`text-sm font-bold ${totalPnLColor}`}>
              {(token.summary.totalPnL || token.summary.netSOL || 0) > 0 ? '+' : ''}{(token.summary.totalPnL || token.summary.netSOL || 0).toFixed(4)} SOL
            </div>
          </div>
        </div>
        
        {/* Additional Stats */}
        <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-gray-200">
          <div>
            <div className="text-xs text-gray-500">Total Spent</div>
            <div className="text-xs font-semibold text-gray-700">
              {(token.summary.totalSpentSOL || 0).toFixed(4)} SOL
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Current Value</div>
            <div className="text-xs font-semibold text-gray-700">
              {(token.summary.totalCurrentValueSOL || 0).toFixed(4)} SOL
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Remaining</div>
            <div className="text-xs font-semibold text-gray-700">
              {formatNumber(token.summary.totalRemainingTokens || 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Wallets Section */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {token.wallets.map((wallet) => (
          <WalletPillEnhanced key={wallet.address} wallet={wallet} tokenMint={token.mint} />
        ))}
      </div>

      {/* Action Buttons */}
      <div className="mt-3 flex space-x-2">
        <button
          onClick={onOpenChart}
          className="flex-1 bg-blue-600 text-white py-2 px-3 rounded-lg hover:bg-blue-700 transition text-sm font-medium"
        >
          Open Chart
        </button>
        <button
          onClick={openGmgnChartInNewWindow}
          className="flex-1 bg-gray-600 text-white py-2 px-3 rounded-lg hover:bg-gray-700 transition text-sm font-medium"
        >
          GMGN ↗
        </button>
      </div>
    </div>
  );
}

// Enhanced Wallet Pill Component
function WalletPillEnhanced({ wallet, tokenMint }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const realizedColor = (wallet.realizedPnL || 0) > 0 ? 'text-green-700' : (wallet.realizedPnL || 0) < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedColor = (wallet.unrealizedPnL || 0) > 0 ? 'text-green-600' : (wallet.unrealizedPnL || 0) < 0 ? 'text-red-600' : 'text-gray-600';
  const totalPnLColor = (wallet.totalPnL || 0) > 0 ? 'text-green-700' : (wallet.totalPnL || 0) < 0 ? 'text-red-700' : 'text-gray-700';
  
  const openGmgnTokenWithMaker = () => {
    if (!tokenMint || !wallet.address) return;
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
    window.open(gmgnUrl, '_blank');
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(wallet.address);
  };

  const formatNumber = (num) => {
    if (num == null) return '0';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
  };

  return (
    <div className="border rounded-lg px-3 py-2 bg-white hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        {/* Wallet Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2">
            <div className="text-xs font-medium text-gray-900 truncate">{label}</div>
            <button
              onClick={copyToClipboard}
              className="text-gray-400 hover:text-blue-600 p-0.5"
              title="Copy address"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              onClick={openGmgnTokenWithMaker}
              className="text-gray-400 hover:text-blue-600 p-0.5"
              title="Open in GMGN"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            {wallet.txBuys || 0} buys · {wallet.txSells || 0} sells · {formatNumber(wallet.remainingTokens || 0)} tokens left
          </div>
        </div>

        {/* PnL Display */}
        <div className="text-right ml-3">
          <div className="space-y-1">
            <div className="flex items-center justify-end space-x-3 text-[10px]">
              <div>
                <span className="text-gray-500">Real:</span>
                <span className={`ml-1 font-semibold ${realizedColor}`}>
                  {(wallet.realizedPnL || 0) > 0 ? '+' : ''}{(wallet.realizedPnL || 0).toFixed(3)}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Unreal:</span>
                <span className={`ml-1 font-semibold ${unrealizedColor}`}>
                  {(wallet.unrealizedPnL || 0) > 0 ? '+' : ''}{(wallet.unrealizedPnL || 0).toFixed(3)}
                </span>
              </div>
            </div>
            <div className={`text-xs font-bold ${totalPnLColor}`}>
              Total: {(wallet.totalPnL || 0) > 0 ? '+' : ''}{(wallet.totalPnL || wallet.realizedPnL || 0).toFixed(4)} SOL
            </div>
            {wallet.percentChange != null && (
              <div className={`text-[9px] ${wallet.percentChange > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {wallet.percentChange > 0 ? '↑' : '↓'} {Math.abs(wallet.percentChange).toFixed(1)}%
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TokenCard;