import React, { useState, useEffect } from 'react';

function WalletManager({ onAddWallet, onAddWalletsBulk, onSwitchGroup }) {
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('single');
  const [bulkText, setBulkText] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);

  // Fetch groups on component mount
  useEffect(() => {
    const fetchGroups = async () => {
      try {
        const response = await fetch(`${process.env.REACT_APP_API_BASE}/groups`);
        if (!response.ok) throw new Error('Failed to fetch groups');
        const data = await response.json();
        setGroups(data);
      } catch (error) {
        setMessage({ type: 'error', text: `Failed to fetch groups: ${error.message}` });
      }
    };
    fetchGroups();
  }, []);

  // Handle group creation
  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) {
      setMessage({ type: 'error', text: 'Group name is required' });
      return;
    }
    try {
      const response = await fetch(`${process.env.REACT_APP_API_BASE}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create group');
      }
      const { group } = await response.json();
      setGroups([...groups, group]);
      setNewGroupName('');
      setMessage({ type: 'success', text: 'Group created successfully' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  // Handle single wallet submission
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!address.trim()) {
      setMessage({ type: 'error', text: 'Wallet address is required' });
      return;
    }

    if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      setMessage({ type: 'error', text: 'Invalid Solana wallet address format' });
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const result = await onAddWallet(address, name || null, groupId || null);
      setMessage({ type: 'success', text: result.message });
      setAddress('');
      setName('');
      setGroupId('');
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  // Parse bulk input text
  const parseBulkInput = (text) => {
    const lines = text.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
    const wallets = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      const parts = trimmedLine.split(/[,\t]/).map(p => p.trim());
      const address = parts[0];
      const name = parts[1] || null;

      if (address && address.length === 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
        wallets.push({ address, name });
      }
    }

    return wallets;
  };

  // Handle bulk wallet submission
  const handleBulkSubmit = async (e) => {
    e.preventDefault();

    if (!bulkText.trim()) {
      setBulkResults({ type: 'error', message: 'Please enter wallet addresses' });
      return;
    }

    const wallets = parseBulkInput(bulkText);

    if (wallets.length === 0) {
      setBulkResults({ type: 'error', message: 'No valid wallet addresses found' });
      return;
    }

    if (wallets.length > 1000) {
      setBulkResults({ type: 'error', message: 'Maximum 1000 wallets allowed' });
      return;
    }

    setBulkLoading(true);
    setBulkResults(null);

    try {
      const result = await onAddWalletsBulk(wallets, groupId || null);
      setBulkResults({
        type: 'success',
        message: result.message,
        details: result.results,
      });
      setBulkText('');
      setGroupId('');
    } catch (error) {
      setBulkResults({ type: 'error', message: error.message });
    } finally {
      setBulkLoading(false);
    }
  };

  // Handle group selection for monitoring
  const handleSwitchGroup = async (selectedGroupId) => {
    try {
      await onSwitchGroup(selectedGroupId || null);
      setMessage({
        type: 'success',
        text: `Switched to group: ${selectedGroupId ? groups.find(g => g.id === selectedGroupId)?.name || 'Unknown' : 'Default'}`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: `Failed to switch group: ${error.message}` });
    }
  };

  return (
    <div className="max-w-xl mx-auto p-6 bg-gray-100 rounded-lg shadow-md">
      <h2 className="text-2xl font-bold text-gray-800 mb-4">Manage Wallets</h2>

      {/* Group Management */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-2">Create Group</h3>
        <div className="flex gap-4">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Enter group name"
            maxLength={255}
            className="flex-1 p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleCreateGroup}
            disabled={!newGroupName.trim()}
            className={`px-4 py-2 rounded-md text-white ${newGroupName.trim() ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}`}
          >
            Create Group
          </button>
        </div>
      </div>

      {/* Tabs for Single/Bulk Wallet Addition */}
      <div className="flex gap-2 mb-6">
        <button
          className={`flex-1 py-2 rounded-md ${activeTab === 'single' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          onClick={() => setActiveTab('single')}
        >
          Add Single Wallet
        </button>
        <button
          className={`flex-1 py-2 rounded-md ${activeTab === 'bulk' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          onClick={() => setActiveTab('bulk')}
        >
          Bulk Import
        </button>
      </div>

      {/* Group Selection for Monitoring */}
      <div className="flex items-center gap-4 mb-6">
        <label htmlFor="monitor-group" className="font-semibold text-gray-700">
          Monitor Group:
        </label>
        <select
          id="monitor-group"
          value={groupId}
          onChange={(e) => {
            const selectedGroupId = e.target.value;
            setGroupId(selectedGroupId);
            handleSwitchGroup(selectedGroupId);
          }}
          className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[150px]"
        >
          <option value="">Default (All Wallets)</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </div>

      {/* Single Wallet Form */}
      {activeTab === 'single' && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="address" className="font-semibold text-gray-700">
              Wallet Address
            </label>
            <input
              id="address"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              placeholder="Enter Solana wallet address"
              disabled={loading}
              className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="name" className="font-semibold text-gray-700">
              Name (Optional)
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter wallet name"
              disabled={loading}
              maxLength={255}
              className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="group" className="font-semibold text-gray-700">
              Group (Optional)
            </label>
            <select
              id="group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={loading}
              className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No Group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={loading || !address.trim()}
            className={`px-4 py-2 rounded-md text-white ${loading || !address.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {loading ? 'Adding...' : 'Add Wallet'}
          </button>
          {message && (
            <div
              className={`p-3 rounded-md ${message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
            >
              {message.text}
            </div>
          )}
        </form>
      )}

      {/* Bulk Import Form */}
      {activeTab === 'bulk' && (
        <form onSubmit={handleBulkSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="bulk-text" className="font-semibold text-gray-700">
              Wallet Addresses
            </label>
            <textarea
              id="bulk-text"
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder="Enter one wallet per line or comma-separated (address,name)\n# Lines starting with # are ignored"
              rows={6}
              disabled={bulkLoading}
              className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="bulk-group" className="font-semibold text-gray-700">
              Group (Optional)
            </label>
            <select
              id="bulk-group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={bulkLoading}
              className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No Group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={bulkLoading || !bulkText.trim()}
            className={`px-4 py-2 rounded-md text-white ${bulkLoading || !bulkText.trim() ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {bulkLoading ? 'Importing...' : 'Import Wallets'}
          </button>
          {bulkResults && (
            <div
              className={`p-3 rounded-md ${bulkResults.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
            >
              <p>{bulkResults.message}</p>
              {bulkResults.details && (
                <div className="mt-2">
                  <p>Total: {bulkResults.details.total}</p>
                  <p>Successful: {bulkResults.details.successful}</p>
                  <p>Failed: {bulkResults.details.failed}</p>
                  {bulkResults.details.errors.length > 0 && (
                    <ul className="list-disc ml-5 mt-2">
                      {bulkResults.details.errors.map((error, index) => (
                        <li key={index}>
                          {error.address}: {error.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </form>
      )}
    </div>
  );
}

export default WalletManager;