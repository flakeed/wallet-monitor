import React, { useState } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
  const [showDetails, setShowDetails] = useState(false);
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';
  const realizedPnlColor = token.summary.realizedPNL > 0 ? 'text-green-700' : token.summary.realizedPNL < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedPnlColor = token.summary.unrealizedPNL > 0 ? 'text-green-600' : token.summary.unrealizedPNL < 0 ? 'text-red-600' : 'text-gray-600';
  const totalPnL = token.summary.realizedPNL + token.summary.unrealizedPNL;
  const totalPnLColor = totalPnL > 0 ? 'text-green-700' : totalPnL < 0 ? 'text-red-700' : 'text-gray-700';

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => console.log('Address copied to clipboard:', text))
      .catch((err) => console.error('Failed to copy address:', err));
  };

  const openDexScreener = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const dexUrl = `https://dexscreener.com/solana/${encodeURIComponent(token.mint)}`;
    window.open(dexUrl, '_blank');
  };

  const openGmgnChartInNewWindow = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  const openBirdeyeChart = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const birdeyeUrl = `https://birdeye.so/token/${encodeURIComponent(token.mint)}?chain=solana`;
    window.open(birdeyeUrl, '_blank');
  };

  // Calculate some additional metrics
  const avgPricePerWallet = token.summary.uniqueWallets > 0 ? (token.currentPrice || 0) : 0;
  const totalVolume = token.summary.totalSpentSOL + token.summary.totalReceivedSOL;

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center space-x-2 mb-1">
            <span className="text-lg font-bold px-3 py-1 rounded-full bg-blue-100 text-blue-800">
              {token.symbol || 'UNKNOWN'}
            </span>
            <span className="text-gray-600 truncate text-sm">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="text-xs text-gray-500 font-mono truncate">{token.mint}</div>
            <button
              onClick={() => copyToClipboard(token.mint)}
              className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
              title="Copy mint address"
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
          <div className="text-xs text-gray-500 mt-1">
            Current Price: {(token.currentPrice || 0).toFixed(8)} SOL
          </div>
        </div>
        <div className="text-right">
          <div className={`text-xl font-bold ${totalPnLColor} mb-1`}>
            Total: {totalPnL > 0 ? '+' : ''}{totalPnL.toFixed(4)} SOL
          </div>
          <div className="space-y-1">
            <div className={`text-sm ${realizedPnlColor}`}>
              Realized: {token.summary.realizedPNL > 0 ? '+' : ''}{token.summary.realizedPNL.toFixed(4)} SOL
            </div>
            <div className={`text-sm ${unrealizedPnlColor}`}>
              Unrealized: {token.summary.unrealizedPNL > 0 ? '+' : ''}{token.summary.unrealizedPNL.toFixed(4)} SOL
            </div>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {token.summary.uniqueWallets} wallets · Vol: {totalVolume.toFixed(2)} SOL
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4 py-3 px-2 bg-gray-50 rounded-lg mb-3">
        <div className="text-center">
          <div className="text-lg font-semibold text-green-600">{token.summary.totalBuys}</div>
          <div className="text-xs text-gray-500">Buys</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-red-600">{token.summary.totalSells}</div>
          <div className="text-xs text-gray-500">Sells</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold text-blue-600">{token.summary.currentBalance.toFixed(0)}</div>
          <div className="text-xs text-gray-500">Balance</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-semibold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(3)}
          </div>
          <div className="text-xs text-gray-500">Net SOL</div>
        </div>
      </div>

      {/* Wallets Section */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-700">Wallets</h4>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
          >
            {showDetails ? 'Hide Details' : 'Show Details'}
          </button>
        </div>
        
        <div className="grid grid-cols-1 gap-2">
          {token.wallets.slice(0, showDetails ? token.wallets.length : 3).map((wallet) => (
            <WalletPill 
              key={wallet.address} 
              wallet={wallet} 
              tokenMint={token.mint}
              tokenPrice={token.currentPrice}
              tokenSymbol={token.symbol}
            />
          ))}
          
          {!showDetails && token.wallets.length > 3 && (
            <div className="text-center py-2">
              <button
                onClick={() => setShowDetails(true)}
                className="text-sm text-blue-500 hover:text-blue-700 transition-colors"
              >
                + {token.wallets.length - 3} more wallets
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={openGmgnChartInNewWindow}
          className="bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          📊 GMGN Chart
        </button>
        <button
          onClick={openDexScreener}
          className="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
        >
          📈 DexScreener
        </button>
      </div>
      
      {/* Additional chart options */}
      <div className="mt-2">
        <button
          onClick={openBirdeyeChart}
          className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
        >
          🐦 Birdeye Chart
        </button>
      </div>
    </div>
  );
}

export default TokenCard;