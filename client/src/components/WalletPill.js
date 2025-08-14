import React from 'react';

function WalletPill({ wallet, tokenMint }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const totalPnLColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
  const realizedColor = wallet.realizedPnL > 0 ? 'text-green-700' : wallet.realizedPnL < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedColor = wallet.unrealizedPnL > 0 ? 'text-green-700' : wallet.unrealizedPnL < 0 ? 'text-red-700' : 'text-gray-700';

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
    navigator.clipboard.writeText(wallet.address)
      .then(() => console.log('Address copied to clipboard:', wallet.address))
      .catch((err) => console.error('Failed to copy address:', err));
  };

  return (
    <div className="flex items-center justify-between border rounded-md px-2 py-1 bg-white">
      <div className="truncate max-w-xs">
        <div className="flex items-center space-x-2">
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
        <div className="text-[10px] text-gray-500">
          {wallet.txBuys} buys · {wallet.txSells} sells · {wallet.held.toFixed(2)} held
        </div>
      </div>
      <div className="text-right ml-2 text-[10px]">
        <div className={`font-semibold ${totalPnLColor}`}>
          Total PnL: {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
        </div>
        <div className={`text-gray-500 ${realizedColor}`}>
          Realized: {wallet.realizedPnL > 0 ? '+' : ''}{wallet.realizedPnL.toFixed(4)} SOL
        </div>
        <div className={`text-gray-500 ${unrealizedColor}`}>
          Unrealized: {wallet.unrealizedPnL > 0 ? '+' : ''}{wallet.unrealizedPnL.toFixed(4)} SOL
        </div>
        <div className="text-gray-400">
          Spent: {wallet.solSpent.toFixed(4)} · Recv: {wallet.solReceived.toFixed(4)}
        </div>
        <div className="text-gray-400">
          Avg Cost: {wallet.avgCost.toFixed(6)} SOL · Current: {wallet.currentPrice.toFixed(6)} SOL
        </div>
      </div>
    </div>
  );
}

export default WalletPill;