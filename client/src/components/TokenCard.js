import React from 'react';

function TokenCard({ token }) {
  if (!token) {
    return null;
  }

  const symbol = token.symbol || 'Unknown';
  const name = token.name || 'Unknown Token';
  const logoURI = token.logoURI || null;
  const mint = token.mint || '';
  const decimals = token.decimals || 4;

  let amount = 0;
  if (token.amount !== null && token.amount !== undefined) {
    amount = typeof token.amount === 'number' ? token.amount : parseFloat(token.amount) || 0;
  }

  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="flex items-center space-x-3">
        {logoURI ? (
          <img
            src={logoURI}
            alt={symbol}
            className="w-8 h-8 rounded-full"
            onError={(e) => {
              e.target.style.display = 'none';
              e.target.nextSibling.style.display = 'flex';
            }}
          />
        ) : null}
        <div
          className={`w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center text-xs font-bold text-gray-600 ${logoURI ? 'hidden' : 'flex'}`}
        >
          ?
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-gray-900">{symbol}</span>
            <span className="text-gray-400">•</span>
            <span className="text-gray-600 truncate">{name}</span>
          </div>
          <div className="text-sm text-gray-500">
            Amount: {amount.toLocaleString(undefined, { maximumFractionDigits: decimals })}
          </div>
          <div className="text-xs text-gray-400 font-mono truncate">
            {mint}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TokenCard;