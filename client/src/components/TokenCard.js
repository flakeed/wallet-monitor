import React from 'react';

function TokenCard({ token }) {
  if (!token) {
    return null;
  }

  const symbol = token.symbol || 'Unknown';
  const name = token.name || 'Unknown Token';
  const mint = token.mint || '';
  const decimals = token.decimals || 4;

  let amount = 0;
  if (token.amount !== null && token.amount !== undefined) {
    amount = typeof token.amount === 'number' ? token.amount : parseFloat(token.amount) || 0;
  }

  return (
    <div className="bg-gray-50 rounded-lg p-3">
      <div className="flex items-center space-x-3">


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