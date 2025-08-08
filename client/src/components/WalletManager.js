import React, { useState, useEffect } from 'react';
import './WalletManager.css'; // Assuming you have a CSS file for styling

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
        setMessage({ type: 'error', text: 'Failed to fetch groups: ' + error.message });
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
      setMessage({ type: 'success', text: `Switched to group: ${selectedGroupId ? groups.find(g => g.id === selectedGroupId)?.name || 'Unknown' : 'Default'}` });
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to switch group: ' + error.message });
    }
  };

  return (
    <div className="wallet-manager">
      <h2>Manage Wallets</h2>

      {/* Group Management */}
      <div className="group-management">
        <h3>Create Group</h3>
        <div className="group-form">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="Enter group name"
            maxLength={255}
          />
          <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
            Create Group
          </button>
        </div>
      </div>

      {/* Tabs for Single/Bulk Wallet Addition */}
      <div className="tabs">
        <button
          className={activeTab === 'single' ? 'active' : ''}
          onClick={() => setActiveTab('single')}
        >
          Add Single Wallet
        </button>
        <button
          className={activeTab === 'bulk' ? 'active' : ''}
          onClick={() => setActiveTab('bulk')}
        >
          Bulk Import
        </button>
      </div>

      {/* Group Selection for Monitoring */}
      <div className="group-selector">
        <label htmlFor="monitor-group">Monitor Group: </label>
        <select
          id="monitor-group"
          value={groupId}
          onChange={(e) => {
            const selectedGroupId = e.target.value;
            setGroupId(selectedGroupId);
            handleSwitchGroup(selectedGroupId);
          }}
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
        <form onSubmit={handleSubmit} className="wallet-form">
          <div className="form-group">
            <label htmlFor="address">Wallet Address</label>
            <input
              id="address"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              placeholder="Enter Solana wallet address"
              disabled={loading}
            />
          </div>
          <div className="form-group">
            <label htmlFor="name">Name (Optional)</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter wallet name"
              disabled={loading}
              maxLength={255}
            />
          </div>
          <div className="form-group">
            <label htmlFor="group">Group (Optional)</label>
            <select
              id="group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={loading}
            >
              <option value="">No Group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={loading || !address.trim()}>
            {loading ? 'Adding...' : 'Add Wallet'}
          </button>
          {message && (
            <div className={`message ${message.type}`}>
              {message.text}
            </div>
          )}
        </form>
      )}

      {/* Bulk Import Form */}
      {activeTab === 'bulk' && (
        <form onSubmit={handleBulkSubmit} className="bulk-form">
          <div className="form-group">
            <label htmlFor="bulk-text">Wallet Addresses</label>
            <textarea
              id="bulk-text"
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder="Enter one wallet per line or comma-separated (address,name)\n# Lines starting with # are ignored"
              rows={10}
              disabled={bulkLoading}
            />
          </div>
          <div className="form-group">
            <label htmlFor="bulk-group">Group (Optional)</label>
            <select
              id="bulk-group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={bulkLoading}
            >
              <option value="">No Group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={bulkLoading || !bulkText.trim()}>
            {bulkLoading ? 'Importing...' : 'Import Wallets'}
          </button>
          {bulkResults && (
            <div className={`bulk-results ${bulkResults.type}`}>
              <p>{bulkResults.message}</p>
              {bulkResults.details && (
                <div className="bulk-details">
                  <p>Total: {bulkResults.details.total}</p>
                  <p>Successful: {bulkResults.details.successful}</p>
                  <p>Failed: {bulkResults.details.failed}</p>
                  {bulkResults.details.errors.length > 0 && (
                    <ul>
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