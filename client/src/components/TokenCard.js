import React, { useState } from 'react';
import PropTypes from 'prop-types';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart, currentPrice }) {
  // Validate token prop
  if (!token || !token.wallets || !token.summary || !token.mint) {
    console.error('Invalid token prop:', token);
    return <div className="text-red-600 p-4">Invalid token data</div>;
  }

  const [showAllWallets, setShowAllWallets] = useState(false);

  // Calculate aggregate statistics
  const totalTokensBought = Array.isArray(token.wallets)
    ? token.wallets.reduce((sum, w) => sum + (w.tokensBought || 0), 0)
    : 0;
  const totalTokensSold = Array.isArray(token.wallets)
    ? token.wallets.reduce((sum, w) => sum + (w.tokensSold || 0), 0)
    : 0;
  const totalTokensRemaining = totalTokensBought - totalTokensSold;

  // Calculate unrealized PnL
  const unrealizedPnl = currentPrice && totalTokensRemaining > 0
    ? (currentPrice * totalTokensRemaining) - (token.summary.totalSpentSOL - token.summary.totalReceivedSOL)
    : 0;

  const totalPnl = token.summary.netSOL + unrealizedPnl;

  // Determine colors
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedColor = unrealizedPnl > 0 ? 'text-green-600' : unrealizedPnl < 0 ? 'text-red-600' : 'text-gray-600';
  const totalColor = totalPnl > 0 ? 'text-green-800' : totalPnl < 0 ? 'text-red-800' : 'text-gray-800';

  // Calculate wallet statistics
  const walletsHolding = Array.isArray(token.wallets)
    ? token.wallets.filter(w => (w.tokensBought - w.tokensSold) > 0).length
    : 0;
  const walletsExited = Array.isArray(token.wallets)
    ? token.wallets.filter(w => w.tokensSold > 0 && (w.tokensBought - w.tokensSold) <= 0).length
    : 0;

  // Sort wallets by PnL
  const sortedWallets = Array.isArray(token.wallets)
    ? [...token.wallets].sort((a, b) => (b.totalPnl || 0) - (a.totalPnl || 0))
    : [];
  const walletsToShow = showAllWallets ? sortedWallets : sortedWallets.slice(0, 4);

  // Function to copy text to clipboard
  const copyToClipboard = (text) => {
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => console.log('Address copied to clipboard:', text))
      .catch((err) => console.error('Failed to copy address:', err));
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

  // Format large numbers
  const formatTokenAmount = (amount) => {
    if (!Number.isFinite(amount)) return '0.00';
    if (amount >= 1000000000) {
      return `${(amount / 1000000000).toFixed(2)}B`;
    } else if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(2)}K`;
    }
    return amount.toFixed(2);
  };

  return (
    <div className="border rounded-lg p-4 bg-gradient-to-br from-gray-50 to-white shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2 mb-1">
            <span className="text-sm px-2 py-0.5 rounded-full bg-gradient-to-r from-blue-500 to-blue-600 text-white font-semibold">
              {token.symbol || 'Unknown'}
            </span>
            <span className="text-gray-700 truncate font-medium">{token.name || 'Unknown Token'}</span>
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
        
        {/* PnL Summary */}
        <div className="text-right ml-4">
          <div className={`text-lg font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          <div className="text-[10px] text-gray-500">Realized PnL</div>
        </div>
      </div>

      {/* Statistics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 p-3 bg-gray-50 rounded-lg">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Wallets</div>
          <div className="text-sm font-semibold text-gray-900">{token.summary.uniqueWallets || 0}</div>
          <div className="text-[10px] text-gray-500">
            {walletsHolding} holding · {walletsExited} exited
          </div>
        </div>
        
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Transactions</div>
          <div className="text-sm font-semibold text-gray-900">
            {(token.summary.totalBuys || 0) + (token.summary.totalSells || 0)}
          </div>
          <div className="text-[10px] text-gray-500">
            {token.summary.totalBuys || 0} buys · {token.summary.totalSells || 0} sells
          </div>
        </div>
        
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">SOL Volume</div>
          <div className="text-sm font-semibold text-gray-900">
            {((token.summary.totalSpentSOL || 0) + (token.summary.totalReceivedSOL || 0)).toFixed(4)}
          </div>
          <div className="text-[10px] text-gray-500">
            <span className="text-red-600">-{token.summary.totalSpentSOL?.toFixed(4) || '0.0000'}</span> · 
            <span className="text-green-600">+{token.summary.totalReceivedSOL?.toFixed(4) || '0.0000'}</span>
          </div>
        </div>
        
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Tokens</div>
          <div className="text-sm font-semibold text-gray-900">
            {formatTokenAmount(totalTokensRemaining)}
          </div>
          <div className="text-[10px] text-gray-500">
            remaining of {formatTokenAmount(totalTokensBought)}
          </div>
        </div>
      </div>

      {/* PnL Breakdown */}
      {totalTokensRemaining > 0 && (
        <div className="mb-4 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg">
          <div className="text-xs font-semibold text-gray-700 mb-2">PnL Breakdown</div>
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-600">Realized PnL:</span>
              <span className={`font-semibold ${netColor}`}>
                {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
              </span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-gray-600">Unrealized PnL:</span>
              {currentPrice ? (
                <span className={`font-semibold ${unrealizedColor}`}>
                  {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(4)} SOL
                </span>
              ) : (
                <span className="text-gray-400 italic">Price not available</span>
              )}
            </div>
            {currentPrice && (
              <div className="flex justify-between items-center text-sm border-t pt-1 mt-1">
                <span className="text-gray-700 font-semibold">Total PnL:</span>
                <span className={`font-bold ${totalColor}`}>
                  {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(4)} SOL
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Wallets List */}
      <div className="mb-3">
        <div className="flex justify-between items-center mb-2">
          <h4 className="text-xs font-semibold text-gray-700">
            Top Wallets {!showAllWallets && sortedWallets.length > 4 && `(${walletsToShow.length} of ${sortedWallets.length})`}
          </h4>
          {sortedWallets.length > 4 && (
            <button
              onClick={() => setShowAllWallets(!showAllWallets)}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {showAllWallets ? 'Show Less' : `Show All (${sortedWallets.length})`}
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
          {walletsToShow.map((w) => (
            <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
          ))}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex space-x-2">
        <button
          onClick={onOpenChart}
          className="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 text-white py-2 px-4 rounded-lg hover:from-blue-700 hover:to-blue-800 transition font-medium text-sm shadow-sm"
        >
          Open Chart
        </button>
        <button
          onClick={openGmgnChartInNewWindow}
          className="flex-1 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white py-2 px-4 rounded-lg hover:from-indigo-700 hover:to-indigo-800 transition font-medium text-sm shadow-sm"
        >
          New Window
        </button>
        {currentPrice && (
          <button
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition text-sm"
            title="Current token price"
          >
            ${currentPrice.toFixed(6)}
          </button>
        )}
      </div>
    </div>
  );
}

TokenCard.propTypes = {
  token: PropTypes.shape({
    mint: PropTypes.string.isRequired,
    symbol: PropTypes.string,
    name: PropTypes.string,
    wallets: PropTypes.arrayOf(
      PropTypes.shape({
        address: PropTypes.string.isRequired,
        tokensBought: PropTypes.number,
        tokensSold: PropTypes.number,
        totalPnl: PropTypes.number,
      })
    ).isRequired,
    summary: PropTypes.shape({
      netSOL: PropTypes.number.isRequired,
      totalSpentSOL: PropTypes.number.isRequired,
      totalReceivedSOL: PropTypes.number.isRequired,
      totalBuys: PropTypes.number,
      totalSells: PropTypes.number,
      uniqueWallets: PropTypes.number,
    }).isRequired,
  }).isRequired,
  onOpenChart: PropTypes.func.isRequired,
  currentPrice: PropTypes.number,
};

export default TokenCard;