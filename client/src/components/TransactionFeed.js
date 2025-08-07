import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

function TransactionFeed({ transactions, timeframe, onTimeframeChange }) {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (timeString) => {
    if (!timeString) {
      console.warn('Transaction time is missing or null:', timeString);
      return 'Unknown time';
    }

    const date = new Date(timeString);
    if (isNaN(date.getTime())) {
      console.error(`Invalid date format for timeString: ${timeString}`);
      return 'Invalid date';
    }

    const diffInSeconds = Math.floor((currentTime - date) / 1000);
    if (diffInSeconds < 0) {
      console.warn(`Future transaction time detected: ${timeString}, diff: ${diffInSeconds}s`);
      return 'Just now';
    }

    const isShortTimeframe = parseInt(timeframe) < 24;

    if (isShortTimeframe) {
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } else {
      if (diffInSeconds < 60) {
        return `${diffInSeconds} second${diffInSeconds !== 1 ? 's' : ''} ago`;
      } else if (diffInSeconds < 3600) {
        const minutes = Math.floor(diffInSeconds / 60);
        const seconds = diffInSeconds % 60;
        return seconds === 0
          ? `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
          : `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''} ago`;
      } else if (diffInSeconds < 86400) {
        const hours = Math.floor(diffInSeconds / 3600);
        const minutes = Math.floor((diffInSeconds % 3600) / 60);
        return minutes === 0
          ? `${hours} hour${hours !== 1 ? 's' : ''} ago`
          : `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
      } else {
        return (
          date.toLocaleDateString() +
          ' ' +
          date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })
        );
      }
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const getTransactionTypeIcon = (type) => {
    if (type === 'buy') {
      return (
        <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </div>
      );
    } else if (type === 'sell') {
      return (
        <div className="w-6 h-6 bg-red-500 rounded-full flex items-center justify-center">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </div>
      );
    }
    return null;
  };

  const getTransactionLabel = (type) => {
    return type === 'buy' ? 'BUY' : 'SELL';
  };

  const getAmountDisplay = (tx) => {
    if (tx.transactionType === 'buy') {
      return {
        sol: `-${tx.solSpent} SOL`,
        color: 'text-red-600',
      };
    } else if (tx.transactionType === 'sell') {
      return {
        sol: `+${tx.solReceived} SOL`,
        color: 'text-green-600',
      };
    }
    return { sol: '0 SOL', color: 'text-gray-600' };
  };

  if (!transactions || transactions.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold text-gray-900">Recent Transactions</h3>
          <select
            value={timeframe}
            onChange={(e) => onTimeframeChange(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="1">Last 1 hour</option>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
          </select>
        </div>
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-gray-500 text-lg">No recent transactions</p>
          <p className="text-sm text-gray-400 mt-1">
            Start monitoring wallets to see their token operations here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-semibold text-gray-900">
          Recent Transactions ({transactions.length})
        </h3>
        <div className="flex items-center space-x-2">
          <span className="text-sm text-gray-500">Show:</span>
          <select
            value={timeframe}
            onChange={(e) => onTimeframeChange(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="1">Last 1 hour</option>
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
          </select>
        </div>
      </div>
      <div className="space-y-4 max-h-96 overflow-y-auto">
        {transactions.map((tx, index) => {
          const amountDisplay = getAmountDisplay(tx);

          return (
            <div
              key={tx.signature}
              className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-2">
                    {getTransactionTypeIcon(tx.transactionType)}
                    <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-sm font-bold">
                      {tx.wallet.name ? tx.wallet.name.charAt(0).toUpperCase() : tx.wallet.address.charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <p className="font-semibold text-gray-900">
                          {tx.wallet.name || `${tx.wallet.address.slice(0, 6)}...${tx.wallet.address.slice(-4)}`}
                        </p>
                        <span
                          className={`text-xs px-2 py-1 rounded-full font-medium ${tx.transactionType === 'buy' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                            }`}
                        >
                          {getTransactionLabel(tx.transactionType)}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">{formatTime(tx.time)}</p>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`font-bold ${amountDisplay.color}`}>{amountDisplay.sol}</p>
                </div>
              </div>
              <div className="mb-3">
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-500">TX:</span>
                  <span className="font-mono text-xs text-gray-700 truncate flex-1">{tx.signature}</span>
                  <button
                    onClick={() => copyToClipboard(tx.signature)}
                    className="text-gray-400 hover:text-gray-600 p-1"
                    title="Copy transaction signature"
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
                  <a
                    href={`https://solscan.io/tx/${tx.signature}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-700 p-1"
                    title="View on Solscan"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                      />
                    </svg>
                  </a>
                </div>
              </div>
              {tx.tokensBought && tx.tokensBought.length > 0 && (
                <div className="mb-3">
                  <div className="flex items-center space-x-2 mb-2">
                    <div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                      <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </div>
                    <span className="text-sm text-green-700 font-medium">
                      Tokens Purchased ({tx.tokensBought.length})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 ml-6">
                    {tx.tokensBought.map((token, i) => (
                      <TokenCard key={i} token={token} />
                    ))}
                  </div>
                </div>
              )}
              {tx.tokensSold && tx.tokensSold.length > 0 && (
                <div className="mb-3">
                  <div className="flex items-center space-x-2 mb-2">
                    <div className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center">
                      <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                      </svg>
                    </div>
                    <span className="text-sm text-red-700 font-medium">
                      Tokens Sold ({tx.tokensSold.length})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 ml-6">
                    {tx.tokensSold.map((token, i) => (
                      <TokenCard key={i} token={token} />
                    ))}
                  </div>
                </div>
              )}
              {(!tx.tokensBought || tx.tokensBought.length === 0) && (!tx.tokensSold || tx.tokensSold.length === 0) && (
                <div className="text-center py-2">
                  <span className="text-sm text-gray-500">No token operations detected</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TransactionFeed;