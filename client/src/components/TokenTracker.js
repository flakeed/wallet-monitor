import React, { useState } from 'react';

function WalletList({ wallets = [], onRemoveWallet, onRemoveAllWallets }) {
  const [removingWallet, setRemovingWallet] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [isListVisible, setIsListVisible] = useState(false);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const handleRemove = async (address) => {
    if (!window.confirm('Are you sure you want to remove this wallet from monitoring?')) {
      return;
    }

    setRemovingWallet(address);
    setError(null);
    setSuccess(null);
    try {
      await onRemoveWallet?.(address);
      setSuccess(`Wallet ${address.slice(0, 8)}... removed successfully`);
    } catch (error) {
      console.error('Error removing wallet:', error);
      setError(error.message);
    } finally {
      setRemovingWallet(null);
    }
  };

  const handleRemoveAll = async () => {
    if (isRemovingAll) return;

    if (!window.confirm('⚠️ Remove ALL wallets from monitoring? This cannot be undone.')) {
      return;
    }

    setIsRemovingAll(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await onRemoveAllWallets?.();
      setSuccess(result?.message || 'All wallets removed successfully.');
    } catch (err) {
      console.error('Error removing all wallets:', err);
      setError(err?.message || 'Failed to remove all wallets.');
    } finally {
      setIsRemovingAll(false);
    }
  };

  const toggleListVisibility = () => {
    setIsListVisible(!isListVisible);
  };

  return (
    <div className="flex-1 bg-white rounded-lg shadow-sm border">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-gray-50">
        <div className="flex items-center space-x-2">
          <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
          <h3 className="text-lg font-semibold text-gray-900">Monitored Wallets ({wallets.length})</h3>
        </div>
        <div className="flex items-center space-x-2">
          {wallets.length > 0 && (
            <button
              onClick={handleRemoveAll}
              disabled={isRemovingAll}
              className="text-red-600 hover:text-red-700 p-1.5 rounded disabled:opacity-50"
              title="Remove all wallets"
            >
              {isRemovingAll ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-red-600 border-t-transparent"></div>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={toggleListVisibility}
            className="text-gray-600 hover:text-gray-800 p-1.5 rounded"
            title={isListVisible ? 'Hide list' : 'Show list'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={!isListVisible ? 'M19 9l-7 7-7-7' : 'M5 15l7-7 7 7'}
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="p-4 bg-red-50 text-red-600 rounded-lg m-4 text-sm font-medium">{error}</div>
      )}
      {success && (
        <div className="p-4 bg-green-50 text-green-600 rounded-lg m-4 text-sm font-medium">{success}</div>
      )}

      {/* Wallet List */}
      {isListVisible && (
        <div className="p-4 max-h-[400px] overflow-y-auto">
          {wallets.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-center">
                <svg className="w-12 h-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <p className="text-gray-500 font-medium">No wallets monitored</p>
                <p className="text-gray-400 text-sm">Add wallets to start monitoring</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {wallets.map((wallet) => (
                <div
                  key={wallet.address}
                  className="border-2 border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-all hover:shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      {wallet.name ? (
                        <>
                          <p className="font-semibold text-gray-900 truncate">{wallet.name}</p>
                          <p className="text-sm font-mono text-gray-500 truncate mt-1">
                            {wallet.address.slice(0, 8)}...{wallet.address.slice(-4)}
                          </p>
                        </>
                      ) : (
                        <p className="font-mono text-sm text-gray-900 truncate">
                          {wallet.address.slice(0, 12)}...{wallet.address.slice(-6)}
                        </p>
                      )}
                      <div className="flex items-center space-x-2 mt-2">
                        <button
                          onClick={() => copyToClipboard(wallet.address)}
                          className="text-gray-400 hover:text-blue-600 p-1 rounded"
                          title="Copy address"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                            />
                          </svg>
                        </button>
                        <a
                          href={`https://solscan.io/address/${wallet.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-400 hover:text-purple-600 p-1 rounded"
                          title="View on Solscan"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <button
                      onClick={() => handleRemove(wallet.address)}
                      disabled={removingWallet === wallet.address || isRemovingAll}
                      className="ml-3 p-1.5 text-gray-400 hover:text-red-600 rounded disabled:opacity-50"
                      title="Remove"
                    >
                      {removingWallet === wallet.address ? (
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-red-500 border-t-transparent"></div>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default WalletList;