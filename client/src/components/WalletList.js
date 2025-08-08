import React, { useState } from 'react';

function WalletList({ wallets, onRemoveWallet, onRemoveAllWallets, groups, onGroupChange }) {
  const [removingWallet, setRemovingWallet] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [movingWallet, setMovingWallet] = useState(null);
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('');

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
      await onRemoveWallet(address);
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
      const result = await onRemoveAllWallets();
      setSuccess(result?.message || 'All wallets removed successfully.');
    } catch (err) {
      console.error('Error removing all wallets:', err);
      setError(err?.message || 'Failed to remove all wallets.');
    } finally {
      setIsRemovingAll(false);
    }
  };

  const handleMoveToGroup = async (address, groupId) => {
    setMovingWallet(address);
    setError(null);
    try {
      await onGroupChange(address, groupId);
      setSuccess(`Wallet ${address.slice(0, 8)}... moved successfully`);
    } catch (error) {
      setError(error.message);
    } finally {
      setMovingWallet(null);
    }
  };

  const formatTime = (timeString) => {
    if (!timeString) return 'Never';
    const date = new Date(timeString);
    if (isNaN(date.getTime())) {
      console.error(`Invalid date format for lastTransactionAt: ${timeString}`);
      return 'Invalid Date';
    }
    return date.toLocaleString();
  };

  const formatNumber = (value, decimals = 2) => {
    const num = Number(value || 0);
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  // Filter wallets based on selected group
  const filteredWallets = selectedGroupFilter
    ? wallets.filter(wallet => wallet.group_id === selectedGroupFilter)
    : wallets;

  if (filteredWallets.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <h3 className="text-xl font-semibold text-gray-900 mb-4">Monitored Wallets</h3>
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-sm text-gray-500">Filter by Group:</span>
          <select
            value={selectedGroupFilter}
            onChange={(e) => setSelectedGroupFilter(e.target.value || '')}
            className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">All Groups</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.wallet_count})
              </option>
            ))}
          </select>
        </div>
        {error && (
          <div className="mb-4 p-2 bg-red-100 text-red-700 rounded">{error}</div>
        )}
        {success && (
          <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>
        )}
        <div className="text-center py-8">
          <div className="text-gray-400 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          </div>
          <p className="text-gray-500">No wallets being monitored{selectedGroupFilter ? ' in this group' : ''}</p>
          <p className="text-sm text-gray-400 mt-1">Add a wallet to start tracking</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">
          Monitored Wallets ({filteredWallets.length})
        </h3>
        <button
          onClick={handleRemoveAll}
          disabled={isRemovingAll}
          className="flex items-center text-sm text-red-600 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded transition-colors disabled:opacity-50"
          title="Remove all wallets from monitoring"
        >
          {isRemovingAll ? (
            <>
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-red-600 mr-1"></div>
              Removing...
            </>
          ) : (
            <>
              <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Clear All
            </>
          )}
        </button>
      </div>
      <div className="flex items-center space-x-2 mb-4">
        <span className="text-sm text-gray-500">Filter by Group:</span>
        <select
          value={selectedGroupFilter}
          onChange={(e) => setSelectedGroupFilter(e.target.value || '')}
          className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="">All Groups</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} ({group.wallet_count})
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div className="mb-4 p-2 bg-red-100 text-red-700 rounded">{error}</div>
      )}
      {success && (
        <div className="mb-4 p-2 bg-green-100 text-green-700 rounded">{success}</div>
      )}
      <div className="space-y-4">
        {filteredWallets.map((wallet) => (
          <div key={wallet.address} className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="mb-3">
                  {wallet.name ? (
                    <>
                      <h4 className="font-semibold text-gray-900 truncate">{wallet.name}</h4>
                      <div className="flex items-center space-x-2">
                        <p className="text-xs font-mono text-gray-500 truncate flex-1">
                          {wallet.address}
                        </p>
                        <button
                          onClick={() => copyToClipboard(wallet.address)}
                          className="text-gray-400 hover:text-gray-600 p-1"
                          title="Copy wallet address"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                        <a
                          href={`https://solscan.io/address/${wallet.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-700 p-1"
                          title="View on Solscan"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <h4 className="font-mono text-sm text-gray-900 truncate flex-1">
                        {wallet.address}
                      </h4>
                      <button
                        onClick={() => copyToClipboard(wallet.address)}
                        className="text-gray-400 hover:text-gray-600 p-1"
                        title="Copy wallet address"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <a
                        href={`https://solscan.io/address/${wallet.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:text-blue-700 p-1"
                        title="View on Solscan"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  )}
                </div>
                <div className="mb-3">
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-gray-500">Group:</span>
                    <select
                      value={wallet.group_id || ''}
                      onChange={(e) => handleMoveToGroup(wallet.address, e.target.value || null)}
                      disabled={movingWallet === wallet.address}
                      className="text-xs border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">No Group</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                    {movingWallet === wallet.address && (
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500"></div>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div className="bg-green-50 rounded p-2">
                    <div className="flex items-center space-x-1">
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <span className="text-green-700 font-medium">Buys</span>
                    </div>
                    <div className="mt-1">
                      <span className="font-semibold text-green-900">
                        {wallet.stats.totalBuyTransactions}
                      </span>
                      <span className="text-green-600 ml-1">txs</span>
                    </div>
                  </div>
                  <div className="bg-red-50 rounded p-2">
                    <div className="flex items-center space-x-1">
                      <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                      <span className="text-red-700 font-medium">Sells</span>
                    </div>
                    <div className="mt-1">
                      <span className="font-semibold text-red-900">
                        {wallet.stats.totalSellTransactions}
                      </span>
                      <span className="text-red-600 ml-1">txs</span>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div>
                    <span className="text-gray-500">SOL Spent:</span>
                    <div className="font-semibold text-red-600">
                      -{formatNumber(wallet.stats.totalSpentSOL, 6)}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-500">SOL Received:</span>
                    <div className="font-semibold text-green-600">
                      +{formatNumber(wallet.stats.totalReceivedSOL, 6)}
                    </div>
                  </div>
                </div>
                <div className="border-t pt-2 mt-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-gray-500">Net SOL:</span>
                      <div className={`font-semibold ${Number(wallet.stats.netSOL) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {Number(wallet.stats.netSOL) >= 0 ? '+' : ''}{formatNumber(wallet.stats.netSOL, 6)}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-3 pt-2 border-t">
                  <div className="text-xs">
                    <span className="text-gray-500">Last Activity:</span>
                    <span className="ml-1 text-gray-700">
                      {formatTime(wallet.stats.lastTransactionAt)}
                    </span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleRemove(wallet.address)}
                disabled={removingWallet === wallet.address || isRemovingAll}
                className="ml-2 p-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                title="Remove from monitoring"
              >
                {removingWallet === wallet.address ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-500"></div>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default WalletList;