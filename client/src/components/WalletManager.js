import React, { useState, useEffect } from 'react';

function GroupManager({
  groups,
  activeGroup,
  onCreateGroup,
  onSwitchGroup,
  onDeleteGroup,
  onGetGroupStats,
  onGetWalletsInGroup,
  onAddWalletToGroup,
  onAddWalletsBulkToGroup,
  onRemoveWalletFromGroup,
  onRefreshSubscriptions
}) {
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [selectedGroupWallets, setSelectedGroupWallets] = useState([]);
  const [selectedGroupStats, setSelectedGroupStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [createGroupName, setCreateGroupName] = useState('');
  const [createGroupDescription, setCreateGroupDescription] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [message, setMessage] = useState(null);
  const [bulkText, setBulkText] = useState('');
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [singleWalletAddress, setSingleWalletAddress] = useState('');
  const [singleWalletName, setSingleWalletName] = useState('');

  const loadGroupData = async (groupId) => {
    if (!groupId) return;
    
    setLoading(true);
    try {
      const [wallets, stats] = await Promise.all([
        onGetWalletsInGroup(groupId),
        onGetGroupStats(groupId)
      ]);
      setSelectedGroupWallets(wallets);
      setSelectedGroupStats(stats);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSelectGroup = (groupId) => {
    setSelectedGroupId(groupId);
    if (groupId) {
      loadGroupData(groupId);
    } else {
      setSelectedGroupWallets([]);
      setSelectedGroupStats(null);
    }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!createGroupName.trim()) return;

    try {
      const result = await onCreateGroup(createGroupName, createGroupDescription);
      setMessage({ type: 'success', text: result.message });
      setCreateGroupName('');
      setCreateGroupDescription('');
      setShowCreateForm(false);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const handleSwitchGroup = async (groupId) => {
    try {
      setLoading(true);
      const result = await onSwitchGroup(groupId);
      setMessage({ type: 'success', text: result.message });
      
      // Refresh subscriptions after switching
      await onRefreshSubscriptions();
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (!confirm('Are you sure you want to delete this group? All wallets will be removed from the group.')) {
      return;
    }

    try {
      const result = await onDeleteGroup(groupId);
      setMessage({ type: 'success', text: result.message });
      
      if (selectedGroupId === groupId) {
        setSelectedGroupId(null);
        setSelectedGroupWallets([]);
        setSelectedGroupStats(null);
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const handleAddSingleWallet = async (e) => {
    e.preventDefault();
    if (!selectedGroupId || !singleWalletAddress.trim()) return;

    try {
      const result = await onAddWalletToGroup(selectedGroupId, singleWalletAddress, singleWalletName);
      setMessage({ type: 'success', text: result.message });
      setSingleWalletAddress('');
      setSingleWalletName('');
      
      // Reload group data
      await loadGroupData(selectedGroupId);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const parseBulkInput = (text) => {
    const lines = text.trim().split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
    const wallets = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.includes(',')) {
        const [address, name] = trimmedLine.split(',').map(p => p.trim());
        if (address && address.length === 44) {
          wallets.push({ address, name: name || null });
        }
      } else {
        if (trimmedLine.length === 44) {
          wallets.push({ address: trimmedLine, name: null });
        }
      }
    }
    return wallets;
  };

  const handleBulkImport = async (e) => {
    e.preventDefault();
    if (!selectedGroupId || !bulkText.trim()) return;

    const wallets = parseBulkInput(bulkText);
    if (wallets.length === 0) {
      setMessage({ type: 'error', text: 'No valid wallet addresses found' });
      return;
    }

    try {
      const result = await onAddWalletsBulkToGroup(selectedGroupId, wallets);
      setMessage({ type: 'success', text: result.message });
      setBulkText('');
      setShowBulkImport(false);
      
      // Reload group data
      await loadGroupData(selectedGroupId);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const handleRemoveWallet = async (address) => {
    if (!selectedGroupId) return;
    
    if (!confirm('Remove this wallet from the group?')) return;

    try {
      const result = await onRemoveWalletFromGroup(selectedGroupId, address);
      setMessage({ type: 'success', text: result.message });
      
      // Reload group data
      await loadGroupData(selectedGroupId);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  return (
    <div className="space-y-6">
      {message && (
        <div className={`p-4 rounded-lg border ${message.type === 'success'
            ? 'bg-green-50 border-green-200 text-green-700'
            : 'bg-red-50 border-red-200 text-red-700'
          }`}>
          {message.text}
        </div>
      )}

      {/* Groups Overview */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Wallet Groups</h2>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
          >
            Create New Group
          </button>
        </div>

        {showCreateForm && (
          <form onSubmit={handleCreateGroup} className="mb-6 p-4 bg-gray-50 rounded-lg">
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Group Name *
                </label>
                <input
                  type="text"
                  value={createGroupDescription}
                  onChange={(e) => setCreateGroupDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-green-500"
                  placeholder="Enter group description..."
                />
              </div>
              <div className="flex space-x-2">
                <button
                  type="submit"
                  className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
                >
                  Create Group
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="bg-gray-300 text-gray-700 px-4 py-2 rounded hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="grid gap-4">
          {groups.map((group) => (
            <div
              key={group.id}
              className={`border rounded-lg p-4 ${
                group.is_active 
                  ? 'border-blue-500 bg-blue-50' 
                  : selectedGroupId === group.id
                  ? 'border-purple-300 bg-purple-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-2">
                    <h3 className="font-semibold text-gray-900">{group.name}</h3>
                    {group.is_active && (
                      <span className="bg-blue-600 text-white text-xs px-2 py-1 rounded">
                        Active
                      </span>
                    )}
                    {selectedGroupId === group.id && (
                      <span className="bg-purple-600 text-white text-xs px-2 py-1 rounded">
                        Selected
                      </span>
                    )}
                  </div>
                  {group.description && (
                    <p className="text-sm text-gray-600 mt-1">{group.description}</p>
                  )}
                  <div className="flex items-center space-x-4 mt-2 text-sm text-gray-500">
                    <span>{group.wallet_count || 0} wallets</span>
                    <span>Created: {new Date(group.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => handleSelectGroup(selectedGroupId === group.id ? null : group.id)}
                    className={`px-3 py-1 rounded text-sm ${
                      selectedGroupId === group.id
                        ? 'bg-purple-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {selectedGroupId === group.id ? 'Deselect' : 'Select'}
                  </button>

                  {!group.is_active && (
                    <button
                      onClick={() => handleSwitchGroup(group.id)}
                      disabled={loading}
                      className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                    >
                      Activate
                    </button>
                  )}

                  <button
                    onClick={() => handleDeleteGroup(group.id)}
                    disabled={group.is_active}
                    className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={group.is_active ? "Cannot delete active group" : "Delete group"}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}

          {groups.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              No groups created yet. Create your first group to organize wallets.
            </div>
          )}
        </div>
      </div>

      {/* Selected Group Details */}
      {selectedGroupId && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Group: {groups.find(g => g.id === selectedGroupId)?.name}
            </h3>
            <div className="flex space-x-2">
              <button
                onClick={() => setShowBulkImport(!showBulkImport)}
                className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
              >
                Bulk Import
              </button>
            </div>
          </div>

          {/* Group Statistics */}
          {selectedGroupStats && (
            <div className="grid grid-cols-4 gap-4 mb-6">
              <div className="bg-blue-50 rounded-lg p-3">
                <div className="text-sm text-blue-700">Total Wallets</div>
                <div className="text-lg font-semibold text-blue-900">
                  {selectedGroupStats.totalWallets}
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="text-sm text-green-700">Buy Transactions</div>
                <div className="text-lg font-semibold text-green-900">
                  {selectedGroupStats.totalBuyTransactions}
                </div>
              </div>
              <div className="bg-red-50 rounded-lg p-3">
                <div className="text-sm text-red-700">Sell Transactions</div>
                <div className="text-lg font-semibold text-red-900">
                  {selectedGroupStats.totalSellTransactions}
                </div>
              </div>
              <div className="bg-yellow-50 rounded-lg p-3">
                <div className="text-sm text-yellow-700">Net SOL</div>
                <div className="text-lg font-semibold text-yellow-900">
                  {selectedGroupStats.netSOL}
                </div>
              </div>
            </div>
          )}

          {/* Add Single Wallet Form */}
          <form onSubmit={handleAddSingleWallet} className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h4 className="font-medium text-gray-900 mb-3">Add Single Wallet</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <input
                  type="text"
                  value={singleWalletAddress}
                  onChange={(e) => setSingleWalletAddress(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500"
                  placeholder="Wallet address (44 characters)"
                  required
                />
              </div>
              <div>
                <input
                  type="text"
                  value={singleWalletName}
                  onChange={(e) => setSingleWalletName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500"
                  placeholder="Name (optional)"
                />
              </div>
              <div>
                <button
                  type="submit"
                  className="w-full bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
                >
                  Add Wallet
                </button>
              </div>
            </div>
          </form>

          {/* Bulk Import Form */}
          {showBulkImport && (
            <form onSubmit={handleBulkImport} className="mb-6 p-4 bg-gray-50 rounded-lg">
              <h4 className="font-medium text-gray-900 mb-3">Bulk Import Wallets</h4>
              <div className="space-y-3">
                <div className="text-sm text-gray-600">
                  Format: One wallet per line, optionally with name: <code>address,name</code>
                </div>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                  placeholder="Paste wallet addresses here..."
                  rows={8}
                />
                <div className="text-sm text-gray-500">
                  {bulkText.trim() && `${parseBulkInput(bulkText).length} valid wallets detected`}
                </div>
                <div className="flex space-x-2">
                  <button
                    type="submit"
                    className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700"
                  >
                    Import Wallets
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBulkImport(false)}
                    className="bg-gray-300 text-gray-700 px-4 py-2 rounded hover:bg-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Wallets List */}
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
              <div className="mt-2 text-gray-500">Loading wallets...</div>
            </div>
          ) : (
            <div className="space-y-2">
              <h4 className="font-medium text-gray-900 mb-3">
                Wallets in Group ({selectedGroupWallets.length})
              </h4>
              
              {selectedGroupWallets.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No wallets in this group yet. Add some wallets to get started.
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  {selectedGroupWallets.map((wallet) => (
                    <div key={wallet.address} className="flex items-center justify-between p-3 bg-white border rounded">
                      <div className="flex-1">
                        <div className="flex items-center space-x-2">
                          <span className="font-mono text-sm text-gray-600">
                            {wallet.address.slice(0, 8)}...{wallet.address.slice(-8)}
                          </span>
                          {wallet.name && (
                            <span className="text-sm font-medium text-gray-900">
                              {wallet.name}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Added: {new Date(wallet.added_to_group_at).toLocaleDateString()}
                          {wallet.stats && (
                            <span className="ml-4">
                              Transactions: {wallet.stats.totalBuyTransactions + wallet.stats.totalSellTransactions} | 
                              Net SOL: {wallet.stats.netSOL}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveWallet(wallet.address)}
                        className="text-red-600 hover:text-red-800 text-sm px-3 py-1 rounded hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default GroupManager;