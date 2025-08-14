import React from 'react';

function WalletPill({ wallet, tokenMint }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  
  // Calculate net token balance (remaining tokens)
  const netTokenBalance = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
  const hasRemainingTokens = netTokenBalance > 0;
  
  // Realized PnL (from completed sells)
  const realizedPnl = wallet.pnlSol || 0;
  
  // Unrealized PnL calculation
  // This would need current token price - for now showing as pending
  // In production, you'd fetch this from an API or pass it as a prop
  const unrealizedPnl = wallet.unrealizedPnl || 0; // This should be calculated based on current token price
  
  // Total PnL (realized + unrealized)
  const totalPnl = realizedPnl + unrealizedPnl;
  
  // Colors for different PnL types
  const realizedColor = realizedPnl > 0 ? 'text-green-700' : realizedPnl < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedColor = unrealizedPnl > 0 ? 'text-green-600' : unrealizedPnl < 0 ? 'text-red-600' : 'text-gray-600';
  const totalColor = totalPnl > 0 ? 'text-green-800' : totalPnl < 0 ? 'text-red-800' : 'text-gray-800';

  // Function to open token chart with wallet as maker in GMGN
  const openGmgnTokenWithMaker = () => {
    if (!tokenMint || !wallet.address) {
      console.warn('Missing token mint or wallet address');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
    window.open(gmgnUrl, '_blank');
  };

  // Function to copy wallet address to clipboard
  const copyToClipboard = () => {
    navigator.clipboard.writeText(wallet.address);
  };

  // Format large numbers
  const formatTokenAmount = (amount) => {
    if (amount >= 1000000) {
      return `${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
      return `${(amount / 1000).toFixed(2)}K`;
    }
    return amount.toFixed(2);
  };

  return (
    <div className="flex flex-col border rounded-md px-3 py-2 bg-white hover:shadow-md transition-shadow">
      {/* Header with wallet info and actions */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="text-xs font-medium text-gray-900 truncate">{label}</div>
          <button
            onClick={copyToClipboard}
            className="text-gray-400 hover:text-blue-600 p-0.5 rounded flex-shrink-0"
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
          <button
            onClick={openGmgnTokenWithMaker}
            className="text-gray-400 hover:text-blue-600 p-0.5 rounded flex-shrink-0"
            title="Open token chart with this wallet as maker"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </button>
        </div>
        {hasRemainingTokens && (
          <span className="text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-800 rounded-full">
            HOLDING
          </span>
        )}
      </div>

      {/* Trading Activity */}
      <div className="text-[10px] text-gray-500 mb-2">
        {wallet.txBuys} buys · {wallet.txSells} sells
      </div>

      {/* Token Balance Information */}
      <div className="grid grid-cols-2 gap-2 mb-2 text-[10px]">
        <div>
          <span className="text-gray-500">Bought:</span>
          <span className="ml-1 font-medium">{formatTokenAmount(wallet.tokensBought || 0)}</span>
        </div>
        <div>
          <span className="text-gray-500">Sold:</span>
          <span className="ml-1 font-medium">{formatTokenAmount(wallet.tokensSold || 0)}</span>
        </div>
        <div className="col-span-2">
          <span className="text-gray-500">Remaining:</span>
          <span className={`ml-1 font-medium ${hasRemainingTokens ? 'text-blue-600' : 'text-gray-600'}`}>
            {formatTokenAmount(netTokenBalance)}
          </span>
          {hasRemainingTokens && (
            <span className="ml-1 text-gray-400">
              ({((netTokenBalance / (wallet.tokensBought || 1)) * 100).toFixed(1)}% of bought)
            </span>
          )}
        </div>
      </div>

      {/* SOL Flow Information */}
      <div className="border-t pt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div>
          <span className="text-gray-500">Spent:</span>
          <span className="ml-1 font-medium text-red-600">-{wallet.solSpent.toFixed(4)} SOL</span>
        </div>
        <div>
          <span className="text-gray-500">Received:</span>
          <span className="ml-1 font-medium text-green-600">+{wallet.solReceived.toFixed(4)} SOL</span>
        </div>
      </div>

      {/* PnL Information */}
      <div className="border-t mt-2 pt-2 space-y-1">
        <div className="flex justify-between items-center text-[10px]">
          <span className="text-gray-500">Realized PnL:</span>
          <span className={`font-semibold ${realizedColor}`}>
            {realizedPnl > 0 ? '+' : ''}{realizedPnl.toFixed(4)} SOL
          </span>
        </div>
        
        {hasRemainingTokens && (
          <>
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-gray-500">Unrealized PnL:</span>
              <span className={`font-medium ${unrealizedColor}`}>
                {unrealizedPnl !== 0 ? (
                  <>
                    {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(4)} SOL
                  </>
                ) : (
                  <span className="text-gray-400 italic">Pending</span>
                )}
              </span>
            </div>
            
            <div className="flex justify-between items-center text-xs border-t pt-1">
              <span className="text-gray-600 font-medium">Total PnL:</span>
              <span className={`font-bold ${totalColor}`}>
                {totalPnl > 0 ? '+' : ''}{totalPnl.toFixed(4)} SOL
              </span>
            </div>
          </>
        )}
      </div>

      {/* Average Buy/Sell Prices (if applicable) */}
      {(wallet.avgBuyPrice || wallet.avgSellPrice) && (
        <div className="border-t mt-2 pt-2 grid grid-cols-2 gap-2 text-[10px]">
          {wallet.avgBuyPrice && (
            <div>
              <span className="text-gray-500">Avg Buy:</span>
              <span className="ml-1 font-medium">${wallet.avgBuyPrice.toFixed(6)}</span>
            </div>
          )}
          {wallet.avgSellPrice && (
            <div>
              <span className="text-gray-500">Avg Sell:</span>
              <span className="ml-1 font-medium">${wallet.avgSellPrice.toFixed(6)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default WalletPill;