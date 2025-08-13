import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import TransactionFeed from './components/TransactionFeed';
import WalletList from './components/WalletList';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';
import TokenTracker from './components/TokenTracker';
import './index.css';
const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';

function App() {
  const [wallets, setWallets] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monitoringStatus, setMonitoringStatus] = useState({ isMonitoring: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [timeframe, setTimeframe] = useState('24');
  const [transactionType, setTransactionType] = useState('all');
  const [view, setView] = useState('tokens');
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);

  const removeAllWallets = async () => {
    try {
      const url = selectedGroup ? `${API_BASE}/wallets?groupId=${selectedGroup}` : `${API_BASE}/wallets`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });
  
      if (!response.ok) {
        throw new Error('Failed to remove all wallets');
      }
  
      const data = await response.json();
      setRefreshKey((prev) => prev + 1); // Обновляем состояние для повторной загрузки данных
      return data;
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const fetchData = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);
      const transactionsUrl = `${API_BASE}/transactions?hours=${hours}&limit=400${type !== 'all' ? `&type=${type}` : ''}${groupId ? `&groupId=${groupId}` : ''}`;
      const walletsUrl = groupId ? `${API_BASE}/wallets?groupId=${groupId}` : `${API_BASE}/wallets`;
      const groupsUrl = `${API_BASE}/groups`;

      const [walletsRes, transactionsRes, statusRes, groupsRes] = await Promise.all([
        fetch(walletsUrl),
        fetch(transactionsUrl),
        fetch(`${API_BASE}/monitoring/status${groupId ? `?groupId=${groupId}` : ''}`),
        fetch(groupsUrl),
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
    const sseUrl = `${API_BASE}/transactions/stream${selectedGroup ? `?groupId=${selectedGroup}` : ''}`;
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
        const matchesGroup = !selectedGroup || newTransaction.groupId === selectedGroup;

        console.log('Filter check:', { matchesTimeframe, matchesType, matchesGroup });

        if (matchesTimeframe && matchesType && matchesGroup) {
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
                name: newTransaction.walletName || wallets.find((w) => w.address === newTransaction.walletAddress)?.name || null,
                group_id: newTransaction.groupId,
                group_name: newTransaction.groupName,
              },
              tokensBought: newTransaction.transactionType === 'buy' ? newTransaction.tokens : [],
              tokensSold: newTransaction.transactionType === 'sell' ? newTransaction.tokens : [],
            };
            return [formattedTransaction, ...prev].slice(0, 400);
          });
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
        console.error('Event data:', event.data);
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
  }, [timeframe, transactionType, wallets, selectedGroup]);

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

  const handleGroupChange = async (groupId) => {
    const selectedGroupId = groupId || null;
    setSelectedGroup(selectedGroupId);
    setLoading(true);

    try {
      await fetch(`${API_BASE}/groups/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: selectedGroupId }),
      });
      fetchData(timeframe, transactionType, selectedGroupId);
    } catch (error) {
      console.error('Error switching group:', error);
      setError('Failed to switch group');
    }
  };

  const addWallet = async (address, name, groupId) => {
    try {
      const response = await fetch(`${API_BASE}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          address: address.trim(), 
          name: name.trim() || null, 
          groupId
        }),
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

  const addWalletsBulk = async (wallets, groupId) => {
    try {
      const response = await fetch(`${API_BASE}/wallets/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          wallets, 
          groupId
        }),
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

  const createGroup = async (name) => {
    try {
      const response = await fetch(`${API_BASE}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create group');
      }

      setRefreshKey((prev) => prev + 1);
      return { success: true, message: data.message, group: data.group };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const toggleMonitoring = async (action) => {
    try {
      const response = await fetch(`${API_BASE}/monitoring/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, groupId: selectedGroup }),
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

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

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
        <MonitoringStatus status={monitoringStatus} onToggle={toggleMonitoring} />
        <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <select
                value={selectedGroup || ''}
                onChange={(e) => handleGroupChange(e.target.value)}
                className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">All Groups</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.wallet_count})
                  </option>
                ))}
              </select>
              {selectedGroup && (
                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                  Group: {groups.find(g => g.id === selectedGroup)?.name || 'Unknown'}
                </span>
              )}
            </div>
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
            {view === 'transactions' && (
              <div className="flex items-center space-x-4">
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
                  </select>
                </div>
              </div>
            )}
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
        <WalletManager onAddWallet={addWallet} onAddWalletsBulk={addWalletsBulk} onCreateGroup={createGroup} groups={groups} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
          <WalletList
  wallets={wallets}
  onRemoveWallet={removeWallet}
  onRemoveAllWallets={removeAllWallets}
/>
          </div>
          <div className="lg:col-span-2">
            {view === 'tokens' ? (
              <TokenTracker groupId={selectedGroup} transactions={transactions} timeframe={timeframe} />
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
    </div>
  );
}

export default App;