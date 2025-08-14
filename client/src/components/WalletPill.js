import React from 'react';

function WalletPill({ wallet, tokenMint }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const realizedPnLColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedPnLColor = wallet.unrealizedPnL > 0 ? 'text-green-700' : wallet.unrealizedPnL < 0 ? 'text-red-700' : 'text-gray-700';
  const totalPnLColor = wallet.totalPnL > 0 ? 'text-green-700' : wallet.totalPnL < 0 ? 'text-red-700' : 'text-gray-700';

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

  return (
    <div className="border rounded-md px-3 py-2 bg-white">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center space-x-2 min-w-0">
          <div className="text-xs font-medium text-gray-900 truncate">{label}</div>
          <button
            onClick={copyToClipboard}
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
          <button
            onClick={openGmgnTokenWithMaker}
            className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
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
        <div className="text-right">
          <div className={`text-xs font-semibold ${totalPnLColor}`}>
            {wallet.totalPnL > 0 ? '+' : ''}{wallet.totalPnL.toFixed(4)} SOL
          </div>
        </div>
      </div>

      {/* Transaction and token info */}
      <div className="flex justify-between items-center text-[10px] text-gray-500 mb-1">
        <span>{wallet.txBuys} buys · {wallet.txSells} sells</span>
        <span>Balance: {wallet.currentTokenBalance.toFixed(2)}</span>
      </div>

      {/* PnL breakdown */}
      <div className="grid grid-cols-2 gap-1 text-[9px]">
        <div className="text-gray-400">
          <span>Realized: </span>
          <span className={realizedPnLColor}>
            {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)}
          </span>
        </div>
        <div className="text-gray-400">
          <span>Unrealized: </span>
          <span className={unrealizedPnLColor}>
            {wallet.unrealizedPnL > 0 ? '+' : ''}{wallet.unrealizedPnL.toFixed(4)}
          </span>
        </div>
      </div>

      {/* Investment details */}
      <div className="text-[9px] text-gray-400 mt-1">
        <div className="flex justify-between">
          <span>Spent: {wallet.solSpent.toFixed(4)}</span>
          <span>Received: {wallet.solReceived.toFixed(4)}</span>
        </div>
        {wallet.currentValue > 0 && (
          <div className="text-center mt-0.5">
            Current Value: {wallet.currentValue.toFixed(4)} SOL
          </div>
        )}
      </div>
    </div>
  );
}

export default WalletPill;