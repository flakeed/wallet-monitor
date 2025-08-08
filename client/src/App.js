import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import TransactionFeed from './components/TransactionFeed';
import WalletList from './components/WalletList';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';
import TokenTracker from './components/TokenTracker';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';

function App() {
  const [wallets, setWallets] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monitoringStatus, setMonitoringStatus] = useState({ isMonitoring: false });
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [newGroupName, setNewGroupName] = useState('');
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [timeframe, setTimeframe] = useState('24');
  const [transactionType, setTransactionType] = useState('all');
  const [view, setView] = useState('tokens');

  const fetchData = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);

      const groupQuery = groupId !== 'all' ? `&groupId=${groupId}` : '';
      const transactionsUrl = `${API_BASE}/transactions?hours=${hours}&limit=400${type !== 'all' ? `&type=${type}` : ''}${groupQuery}`;

      const [walletsRes, transactionsRes, statusRes, groupsRes] = await Promise.all([
        fetch(`${API_BASE}/wallets${groupQuery}`),
        fetch(transactionsUrl),
        fetch(`${API_BASE}/monitoring/status`),
        fetch(`${API_BASE}/groups`),
      ]);

      if (!walletsRes.ok || !transactionsRes.ok || !statusRes.ok || !groupsRes.ok) {
        throw new Error('Failed to fetch data');
      }

      const [walletsData, transactionsData, statusData, groupsData] = await Promise.all([
        walletsRes.json(),
        transactionsRes.json(),
        statusRes.json(),
        groupsRes.json(),
      ]);

      setWallets(walletsData);
      setTransactions(transactionsData);
      setMonitoringStatus(statusData);
      setGroups(groupsData);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  useEffect(() => {
    const sseUrl = `${API_BASE.replace(/\/api$/, '')}/api/transactions/stream${selectedGroup !== 'all' ? `?groupId=${selectedGroup}` : ''}`;
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      try {
        const newTransaction = JSON.parse(event.data);
        console.log('New transaction received via SSE:', newTransaction);

        const now = new Date();
        const txTime = new Date(newTransaction.timestamp);
        const hoursDiff = (now - txTime) / (1000 * 60 * 60);
        const matchesTimeframe = hoursDiff <= parseInt(timeframe);
        const matchesType = transactionType === 'all' || newTransaction.transactionType === transactionType;

        if (matchesTimeframe && matchesType) {
          setTransactions((prev) => {
            if (prev.some((tx) => tx.signature === newTransaction.signature)) {
              return prev;
            }
            const formattedTransaction = {
              signature: newTransaction.signature,
              time: newTransaction.timestamp,
              transactionType: newTransaction.transactionType,
              solSpent: newTransaction.transactionType === 'buy' ? newTransaction.solAmount.toFixed(6) : null,
              solReceived: newTransaction.transactionType === 'sell' ? newTransaction.solAmount.toFixed(6) : null,
              wallet: {
                address: newTransaction.walletAddress,
                name: wallets.find((w) => w.address === newTransaction.walletAddress)?.name || null,
              },
              tokensBought: newTransaction.transactionType === 'buy' ? newTransaction.tokens : [],
              tokensSold: newTransaction.transactionType === 'sell' ? newTransaction.tokens : [],
            };
            return [formattedTransaction, ...prev].slice(0, 400);
          });
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    eventSource.onerror = () => {
      console.error('SSE connection error');
      eventSource.close();
      setTimeout(() => {
        console.log('Attempting to reconnect to SSE...');
      }, 5000);
    };

    return () => {
      eventSource.close();
      console.log('SSE connection closed');
    };
  }, [timeframe, transactionType, selectedGroup, wallets]);

  const handleTimeframeChange = (newTimeframe) => {
    setTimeframe(newTimeframe);
    setLoading(true);
    fetchData(newTimeframe, transactionType, selectedGroup);
  };

  const handleTransactionTypeChange = (newType) => {
    setTransactionType(newType);
    setLoading(true);
    fetchData(timeframe, newType, selectedGroup);
  };

  const handleGroupChange = (groupId) => {
    setSelectedGroup(groupId);
    setLoading(true);
    fetchData(timeframe, transactionType, groupId);
  };

  const addWallet = async (address, name, groupIds = []) => {
    try {
      const response = await fetch(`${API_BASE}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), name: name.trim() || null, groupIds }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add wallet');
      }

      setRefreshKey((prev) => prev + 1);
      return { success: true, message: data.message };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const addWalletsBulk = async (wallets) => {
    try {
      const response = await fetch(`${API_BASE}/wallets/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallets }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to import wallets');
      }

      setRefreshKey((prev) => prev + 1);
      return { success: true, message: data.message, results: data.results };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const removeWallet = async (address) => {
    try {
      const response = await fetch(`${API_BASE}/wallets/${address}`, {
        method: 'DELETE',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove wallet');
      }

      setRefreshKey((prev) => prev + 1);
      return { success: true, message: data.message };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) {
      setError('Group name is required');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create group');
      }

      setNewGroupName('');
      setRefreshKey((prev) => prev + 1);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateWalletGroups = async (walletId, groupId, action) => {
    try {
      const url = `${API_BASE}/wallets/${walletId}/groups/${groupId}`;
      const method = action === 'add' ? 'POST' : 'DELETE';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `Failed to ${action} wallet to group`);
      }

      setRefreshKey((prev) => prev + 1);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleMonitoring = async (action, groupId = selectedGroup) => {
    try {
      const response = await fetch(`${API_BASE}/monitoring/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, groupId: groupId !== 'all' ? groupId : null }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to toggle monitoring');
      }

      setRefreshKey((prev) => prev + 1);
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-6xl mx-auto">
          <Header />
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <Header />
        {error && <ErrorMessage error={error} />}
        <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-900">Group Management</h2>
            <button
              onClick={() => setShowGroupModal(true)}
              className="bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Manage Groups
            </button>
          </div>
          <div className="flex space-x-4">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              placeholder="Enter new group name"
            />
            <button
              onClick={createGroup}
              disabled={!newGroupName.trim()}
              className="bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              Create Group
            </button>
          </div>
        </div>
        <MonitoringStatus status={monitoringStatus} onToggle={toggleMonitoring} />
        <WalletManager onAddWallet={addWallet} onAddWalletsBulk={addWalletsBulk} />
        <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center space-x-3">
              <button
                className={`text-sm px-3 py-1 rounded ${view === 'tokens' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                onClick={() => setView('tokens')}
              >
                Token Tracker
              </button>
              <button
                className={`text-sm px-3 py-1 rounded ${view === 'transactions' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                onClick={() => setView('transactions')}
              >
                Recent Transactions
              </button>
            </div>
            <div className="flex items-center space-x-4">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleGroupChange('all')}
                  className={`text-sm px-3 py-1 rounded ${selectedGroup === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                >
                  All Groups
                </button>
                {groups.map(group => (
                  <button
                    key={group.id}
                    onClick={() => handleGroupChange(group.id)}
                    className={`text-sm px-3 py-1 rounded ${selectedGroup === group.id ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                  >
                    {group.name}
                  </button>
                ))}
              </div>
              {view === 'transactions' && (
                <>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-500">Type:</span>
                    <select
                      value={transactionType}
                      onChange={(e) => handleTransactionTypeChange(e.target.value)}
                      className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="all">All Transactions</option>
                      <option value="buy">Buy Only</option>
                      <option value="sell">Sell Only</option>
                    </select>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-500">Period:</span>
                    <select
                      value={timeframe}
                      onChange={(e) => handleTimeframeChange(e.target.value)}
                      className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="1">Last 1 hour</option>
                      <option value="6">Last 6 hours</option>
                      <option value="24">Last 24 hours</option>
                      <option value="168">Last 7 days</option>
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>
          {view === 'transactions' && (
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="bg-blue-50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-blue-700">Total Transactions</span>
                  <span className="font-semibold text-blue-900">{transactions.length}</span>
                </div>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-green-700">Buy Transactions</span>
                  <span className="font-semibold text-green-900">{transactions.filter((tx) => tx.transactionType === 'buy').length}</span>
                </div>
              </div>
              <div className="bg-red-50 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-red-700">Sell Transactions</span>
                  <span className="font-semibold text-red-900">{transactions.filter((tx) => tx.transactionType === 'sell').length}</span>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <WalletList wallets={wallets} onRemoveWallet={removeWallet} onUpdateWalletGroups={updateWalletGroups} groups={groups} />
          </div>
          <div className="lg:col-span-2">
            {view === 'tokens' ? (
              <TokenTracker groupId={selectedGroup} />
            ) : (
              <TransactionFeed
                transactions={transactions}
                timeframe={timeframe}
                onTimeframeChange={handleTimeframeChange}
                transactionType={transactionType}
                onTransactionTypeChange={handleTransactionTypeChange}
              />
            )}
          </div>
        </div>
      </div>

      {/* Group Management Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Manage Groups</h2>
              <button
                onClick={() => setShowGroupModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <div className="space-y-4">
              {wallets.map(wallet => (
                <div key={wallet.id} className="border p-4 rounded-lg">
                  <div className="font-medium text-gray-900">{wallet.name || wallet.address.slice(0, 8) + '...'}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {groups.map(group => {
                      const isAssigned = wallet.groupIds?.includes(group.id);
                      return (
                        <button
                          key={group.id}
                          onClick={() => updateWalletGroups(wallet.id, group.id, isAssigned ? 'remove' : 'add')}
                          className={`text-sm px-3 py-1 rounded ${isAssigned ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'}`}
                        >
                          {group.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowGroupModal(false)}
                className="bg-gray-600 text-white py-2 px-4 rounded-lg hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;