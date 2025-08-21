import React, { useState, useEffect } from 'react';
import { FixedSizeList } from 'react-window';

function WalletList({ wallets = [], walletCount = 0, onRemoveWallet, onRemoveAllWallets, fetchWallets, selectedGroup }) {
  const [removingWallet, setRemovingWallet] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [isListVisible, setIsListVisible] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(wallets.hasMore || false);
  const [allWallets, setAllWallets] = useState(wallets.wallets || []);

  useEffect(() => {
    if (isListVisible && allWallets.length === 0) {
      fetchWallets();
    }
  }, [isListVisible, fetchWallets]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const handleRemove = async (address) => {
    // ... (unchanged)
  };

  const handleRemoveAll = async () => {
    // ... (unchanged)
  };

  const toggleListVisibility = () => {
    setIsListVisible(!isListVisible);
  };

  const loadMoreWallets = async () => {
    // ... (unchanged)
  };

  const Row = ({ index, style }) => {
    const wallet = allWallets[index];
    if (!wallet) return null;

    return (
      <div style={style} className="p-2">
        <div className="border border-gray-200 rounded p-2 hover:bg-gray-50">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              {wallet.name ? (
                <>
                  <p className="font-medium text-xs text-gray-900 truncate">{wallet.name}</p>
                  <p className="text-xs font-mono text-gray-500 truncate">
                    {wallet.address.slice(0, 8)}...{wallet.address.slice(-4)}
                  </p>
                </>
              ) : (
                <p className="font-mono text-xs text-gray-900">
                  {wallet.address.slice(0, 12)}...{wallet.address.slice(-6)}
                </p>
              )}
              
              <div className="flex items-center space-x-1 mt-1">
                <button
                  onClick={() => copyToClipboard(wallet.address)}
                  className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
                  title="Copy address"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <a
                  href={`https://solscan.io/address/${wallet.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-400 hover:text-purple-600 p-0.5 rounded"
                  title="View on Solscan"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
            </div>
            
            <button
              onClick={() => handleRemove(wallet.address)}
              disabled={removingWallet === wallet.address || isRemovingAll}
              className="ml-2 p-1 text-gray-400 hover:text-red-600 rounded disabled:opacity-50"
              title="Remove"
            >
              {removingWallet === wallet.address ? (
                <div className="animate-spin rounded-full h-3 w-3 border border-red-500 border-t-transparent"></div>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="w-80 bg-white rounded-lg shadow-sm border">
      <div className="flex items-center justify-between p-3 border-b bg-gray-50">
        <div className="flex items-center space-x-2">
          <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          <h3 className="font-medium text-gray-900 text-sm">
            Monitored Wallets ({walletCount})
          </h3>
        </div>
        
        <div className="flex items-center space-x-1">
          {walletCount > 0 && (
            <button
              onClick={handleRemoveAll}
              disabled={isRemovingAll}
              className="text-red-600 hover:text-red-700 p-1 rounded text-xs disabled:opacity-50"
              title="Remove all wallets"
            >
              {isRemovingAll ? (
                <div className="animate-spin rounded-full h-3 w-3 border border-red-600 border-t-transparent"></div>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={toggleListVisibility}
            className="text-gray-600 hover:text-gray-800 p-1 rounded"
            title={isListVisible ? "Hide list" : "Show list"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                d={!isListVisible ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7"} />
            </svg>
          </button>
        </div>
      </div>

      {error && (
        <div className="p-2 m-2 bg-red-100 text-red-700 rounded text-xs">{error}</div>
      )}
      {success && (
        <div className="p-2 m-2 bg-green-100 text-green-700 rounded text-xs">{success}</div>
      )}

      {isListVisible && (
        <div className="max-h-96 overflow-y-auto">
          {allWallets.length === 0 ? (
            <div className="text-center py-6 px-3">
              <svg className="w-8 h-8 mx-auto text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} 
                  d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
              <p className="text-gray-500 text-xs">No wallets monitored</p>
            </div>
          ) : (
            <FixedSizeList
              height={384} // max-h-96 in pixels (96 * 4)
              itemCount={allWallets.length}
              itemSize={60} // Approximate height of each wallet item
              width="100%"
            >
              {Row}
            </FixedSizeList>
          )}
          {hasMore && (
            <div className="p-2">
              <button
                onClick={loadMoreWallets}
                className="w-full bg-blue-600 text-white text-xs py-2 rounded hover:bg-blue-700"
              >
                Load More
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default WalletList;