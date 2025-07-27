import React from 'react';
import TokenCard from './TokenCard';

function PurchaseCard({ tx, index }) {
  console.log('PurchaseCard tx:', tx);
  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex justify-between items-start mb-3">
        <div>
          <span className="text-sm text-gray-500">Transaction #{index + 1}</span>
          <p className="text-sm text-gray-600">{tx.time || 'N/A'}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-gray-900">
            -{(typeof tx.spentSOL === 'number' ? tx.spentSOL : 0).toFixed(6)} SOL
          </p>
          {tx.spentUSD && (
            <p className="text-sm text-gray-600">
              ${Number(tx.spentUSD).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
            </p>
          )}
        </div>
      </div>

      <div className="mb-3">
        <span className="text-xs text-gray-500">Signature</span>
        <p className="font-mono text-xs text-gray-700 break-all bg-gray-50 p-2 rounded mt-1">
          {tx.signature}
        </p>
      </div>

      {tx.tokensBought && tx.tokensBought.length > 0 && (
        <div>
          <span className="text-sm text-gray-500 mb-2 block">Token Purchases</span>
          <div className="space-y-2">
            {tx.tokensBought.map((token, i) => (
              <TokenCard key={i} token={token} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default PurchaseCard;