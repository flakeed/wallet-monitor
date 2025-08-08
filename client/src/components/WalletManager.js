import React, { useState } from 'react';

function WalletManager({ onAddWallet, onAddWalletsBulk, groups, onCreateGroup }) {
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#3B82F6');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('single');
  const [bulkText, setBulkText] = useState('');
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupMessage, setGroupMessage] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!address.trim()) {
      setMessage({ type: 'error', text: 'Wallet address is required' });
      return;
    }

    if (address.length !== 44) {
      setMessage({ type: 'error', text: 'Invalid Solana wallet address format' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const result = await onAddWallet(address, name, selectedGroup || null);
      if (result.success) {
        setMessage({ type: 'success', text: result.message });
        setAddress('');
        setName('');
        setSelectedGroup('');
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const parseBulkInput = (text) => {
    const lines = text.trim().split('\n').filter(line => line.trim());
    const wallets = [];

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.includes(',') || trimmedLine.includes('\t')) {
        const parts = trimmedLine.split(/[,\t]/).map(p => p.trim());
        const address = parts[0];
        const name = parts[1] || null;

        if (address && address.length === 44) {
          wallets.push({ address, name, groupId: bulkGroup || null });
        }
      } else {
        if (trimmedLine.length === 44) {
          wallets.push({ address: trimmedLine, name: null, groupId: bulkGroup || null });
        }
      }
    }

    return wallets;
  };

  const handleBulkSubmit = async (e) => {
    e.preventDefault();

    if (!bulkText.trim()) {
      setBulkResults({ type: 'error', message: 'Please enter wallet addresses' });
      return;
    }

    const wallets = parseBulkInput(bulkText);

    if (wallets.length === 0) {
      setBulkResults({
        type: 'error',
        message: 'No valid wallet addresses found. Make sure addresses are 44 characters long.'
      });
      return;
    }

    if (wallets.length > 1000) {
      setBulkResults({
        type: 'error',
        message: 'Maximum 1000 wallets allowed per bulk import. Please split your list.'
      });
      return;
    }

    setBulkLoading(true);
    setBulkResults(null);

    try {
      const result = await onAddWalletsBulk(wallets);

      setBulkResults({
        type: 'success',
        message: result.message,
        details: result.results
      });

      if (result.results.successful > 0) {
        setBulkText('');
        setBulkGroup('');
      }
    } catch (error) {
      setBulkResults({
        type: 'error',
        message: `Bulk import failed: ${error.message}`
      });
    } finally {
      setBulkLoading(false);
    }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();

    if (!newGroupName.trim()) {
      setGroupMessage({ type: 'error', text: 'Group name is required' });
      return;
    }

    setGroupLoading(true);
    setGroupMessage(null);

    try {
      const result = await onCreateGroup(newGroupName, newGroupDescription, newGroupColor);
      if (result.success) {
        setGroupMessage({ type: 'success', text: result.message });
        setNewGroupName('');
        setNewGroupDescription('');
        setNewGroupColor('#3B82F6');
        setShowCreateGroup(false);
      }
    } catch (error) {
      setGroupMessage({ type: 'error', text: error.message });
    } finally {
      setGroupLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">Add Wallets for Monitoring</h2>

      {/* Tabs */}
      <div className="flex space-x-1 mb-6 bg-gray-100 p-1 rounded-lg">
        <button
          onClick={() => setActiveTab('single')}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${activeTab === 'single'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
            }`}
        >
          Single Wallet
        </button>
        <button
          onClick={() => setActiveTab('bulk')}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${activeTab === 'bulk'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
            }`}
        >
          Bulk Import
        </button>
      </div>

      {/* Single Wallet Tab */}
      {activeTab === 'single' && (
        <>
          {message && (
            <div className={`mb-4 p-3 rounded-lg ${message.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
              }`}>
              {message.text}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Wallet Address *
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value.trim())}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="Enter Solana wallet address (44 characters)"
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Name (Optional)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="Give this wallet a name..."
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Group
              </label>
              <div className="flex items-center space-x-2">
                <select
                  value={selectedGroup}
                  onChange={(e) => setSelectedGroup(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  disabled={loading}
                >
                  <option value="">Select a group (optional)</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setShowCreateGroup(true)}
                  className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  New Group
                </button>
              </div>
            </div>

            {showCreateGroup && (
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Create New Group</h4>
                {groupMessage && (
                  <div className={`mb-3 p-2 rounded-lg ${groupMessage.type === 'success'
                      ? 'bg-green-50 border border-green-200 text-green-700'
                      : 'bg-red-50 border border-red-200 text-red-700'
                    }`}>
                    {groupMessage.text}
                  </div>
                )}
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Group Name *
                    </label>
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                      placeholder="Enter group name"
                      disabled={groupLoading}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description (Optional)
                    </label>
                    <input
                      type="text"
                      value={newGroupDescription}
                      onChange={(e) => setNewGroupDescription(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                      placeholder="Enter group description"
                      disabled={groupLoading}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Color
                    </label>
                    <input
                      type="color"
                      value={newGroupColor}
                      onChange={(e) => setNewGroupColor(e.target.value)}
                      className="w-12 h-8 border border-gray-300 rounded"
                      disabled={groupLoading}
                    />
                  </div>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={handleCreateGroup}
                      disabled={groupLoading || !newGroupName.trim()}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {groupLoading ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                          Creating...
                        </>
                      ) : (
                        'Create Group'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateGroup(false)}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !address.trim()}
              className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Adding Wallet...
                </>
              ) : (
                'Add Wallet'
              )}
            </button>
          </form>
        </>
      )}

      {/* Bulk Import Tab */}
      {activeTab === 'bulk' && (
        <>
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h4 className="text-sm font-medium text-blue-900 mb-2">Format Instructions:</h4>
            <div className="text-sm text-blue-800 space-y-1">
              <p>• One wallet address per line</p>
              <p>• Optional: Add name after comma or tab: <code className="bg-blue-100 px-1 rounded">address,name</code></p>
              <p>• Example:</p>
              <div className="mt-2 bg-blue-100 p-2 rounded font-mono text-xs">
                9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Wallet 1<br />
                53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC<br />
                Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y,Important Wallet
              </div>
            </div>
          </div>

          {bulkResults && (
            <div className={`mb-4 p-4 rounded-lg border ${bulkResults.type === 'success'
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
              }`}>
              <div className={`font-medium mb-2 ${bulkResults.type === 'success' ? 'text-green-900' : 'text-red-900'
                }`}>
                {bulkResults.message}
              </div>

              {bulkResults.details && (
                <div className="text-sm space-y-2">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center">
                      <div className="font-semibold text-gray-900">{bulkResults.details.total}</div>
                      <div className="text-gray-600">Total</div>
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-green-600">{bulkResults.details.successful}</div>
                      <div className="text-gray-600">Successful</div>
                    </div>
                    <div className="text-center">
                      <div className="font-semibold text-red-600">{bulkResults.details.failed}</div>
                      <div className="text-gray-600">Failed</div>
                    </div>
                  </div>

                  {bulkResults.details.errors.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-red-700 font-medium">
                        View Errors ({bulkResults.details.errors.length})
                      </summary>
                      <div className="mt-2 max-h-32 overflow-y-auto bg-red-100 p-2 rounded text-xs">
                        {bulkResults.details.errors.map((error, i) => (
                          <div key={i} className="text-red-800">
                            {error.address.slice(0, 8)}...{error.name ? ` (${error.name})` : ''}: {error.error}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleBulkSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Wallet Addresses *
              </label>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors font-mono text-sm"
                placeholder="Paste wallet addresses here, one per line..."
                rows={10}
                disabled={bulkLoading}
              />
              <div className="mt-2 text-sm text-gray-500">
                {bulkText.trim() && `${parseBulkInput(bulkText).length} valid wallets detected`}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Group
              </label>
              <div className="flex items-center space-x-2">
                <select
                  value={bulkGroup}
                  onChange={(e) => setBulkGroup(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                  disabled={bulkLoading}
                >
                  <option value="">Select a group (optional)</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setShowCreateGroup(true)}
                  className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  New Group
                </button>
              </div>
            </div>

            {showCreateGroup && (
              <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-medium text-gray-900 mb-2">Create New Group</h4>
                {groupMessage && (
                  <div className={`mb-3 p-2 rounded-lg ${groupMessage.type === 'success'
                      ? 'bg-green-50 border border-green-200 text-green-700'
                      : 'bg-red-50 border border-red-200 text-red-700'
                    }`}>
                    {groupMessage.text}
                  </div>
                )}
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Group Name *
                    </label>
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                      placeholder="Enter group name"
                      disabled={groupLoading}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description (Optional)
                    </label>
                    <input
                      type="text"
                      value={newGroupDescription}
                      onChange={(e) => setNewGroupDescription(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                      placeholder="Enter group description"
                      disabled={groupLoading}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Color
                    </label>
                    <input
                      type="color"
                      value={newGroupColor}
                      onChange={(e) => setNewGroupColor(e.target.value)}
                      className="w-12 h-8 border border-gray-300 rounded"
                      disabled={groupLoading}
                    />
                  </div>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={handleCreateGroup}
                      disabled={groupLoading || !newGroupName.trim()}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {groupLoading ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                          Creating...
                        </>
                      ) : (
                        'Create Group'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateGroup(false)}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={bulkLoading || !bulkText.trim()}
              className="w-full bg-purple-600 text-white py-3 px-4 rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
              {bulkLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Importing Wallets...
                </>
              ) : (
                `Import ${parseBulkInput(bulkText).length} Wallets`
              )}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

export default WalletManager;