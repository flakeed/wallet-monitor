import React from 'react';

function WalletPill({ wallet, tokenMint, tokenPrice, tokenSymbol }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const realizedPnlColor = wallet.realizedPNL > 0 ? 'text-green-700' : wallet.realizedPNL < 0 ? 'text-red-700' : 'text-gray-700';
  const unrealizedPnlColor = wallet.unrealizedPNL > 0 ? 'text-green-600' : wallet.unrealizedPNL < 0 ? 'text-red-600' : 'text-gray-600';
  const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
  const totalPnL = (wallet.realizedPNL || 0) + (wallet.unrealizedPNL || 0);
  const totalPnLColor = totalPnL > 0 ? 'text-green-700' : totalPnL < 0 ? 'text-red-700' : 'text-gray-700';

  const openGmgnTokenWithMaker = () => {
    if (!tokenMint || !wallet.address) {
      console.warn('Missing token mint or wallet address');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
    window.open(gmgnUrl, '_blank');
  };

  const openDexScreener = () => {
    if (!tokenMint) {
      console.warn('Missing token mint');
      return;
    }
    const dexUrl = `https://dexscreener.com/solana/${encodeURIComponent(tokenMint)}`;
    window.open(dexUrl, '_blank');
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(wallet.address);
  };

  return (
    <div className="flex items-center justify-between border rounded-md px-3 py-2 bg-white hover:bg-gray-50 transition-colors">
      <div className="truncate max-w-xs">
        <div className="flex items-center space-x-2">
          <div className="text-sm font-medium text-gray-900 truncate">{label}</div>
          <button
            onClick={copyToClipboard}
            className="text-gray-400 hover:text-blue-600 p-1 rounded"
            title="Copy wallet address"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </button>
        </div>
        <div className="flex items-center space-x-1">
          <div className="text-xs text-gray-500">{wallet.txBuys} buys · {wallet.txSells} sells</div>
          <button
            onClick={openGmgnTokenWithMaker}
            className="text-xs text-blue-500 hover:text-blue-700 underline"
            title="View this wallet's trades for this token"
          >
            GMGN
          </button>
          <span className="text-gray-300">·</span>
          <button
            onClick={openDexScreener}
            className="text-xs text-blue-500 hover:text-blue-700 underline"
            title="View token chart on DexScreener"
          >
            DEX
          </button>
        </div>
      </div>
      <div className="text-right ml-2 min-w-0">
        <div className={`text-sm font-bold ${totalPnLColor} truncate`}>
          Total: {totalPnL > 0 ? '+' : ''}{totalPnL.toFixed(4)} SOL
        </div>
        <div className="flex justify-between text-xs space-x-2">
          <span className={realizedPnlColor}>
            R: {wallet.realizedPNL > 0 ? '+' : ''}{wallet.realizedPNL.toFixed(4)}
          </span>
          <span className={unrealizedPnlColor}>
            U: {wallet.unrealizedPNL > 0 ? '+' : ''}{wallet.unrealizedPNL.toFixed(4)}
          </span>
        </div>
        <div className="text-xs text-gray-500 space-y-0.5">
          <div>Balance: {wallet.currentBalance.toFixed(2)} {tokenSymbol || 'tokens'}</div>
          <div className="flex justify-between">
            <span>Avg: {(wallet.avgBuyPrice || 0).toFixed(8)}</span>
            <span>Now: {(wallet.currentPrice || 0).toFixed(8)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WalletPill;