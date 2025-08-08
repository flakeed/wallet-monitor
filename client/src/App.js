import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import TransactionFeed from './components/TransactionFeed';
import WalletList from './components/WalletList';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';
import TokenTracker from './components/TokenTracker';

// Fallback API base for local dev if env not provided
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

    const fetchData = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
        try {
            setLoading(true);
            setError(null);

            // Fetch groups
            const groupsResponse = await fetch(`${API_BASE}/groups`);
            if (!groupsResponse.ok) throw new Error('Failed to fetch groups');
            const groupsData = await groupsResponse.json();
            setGroups(groupsData);

            // Fetch wallets for the selected group or all wallets if no group is selected
            const walletUrl = groupId ? `${API_BASE}/wallets?groupId=${groupId}` : `${API_BASE}/wallets`;
            const walletsResponse = await fetch(walletUrl);
            if (!walletsResponse.ok) throw new Error('Failed to fetch wallets');
            const walletsData = await walletsResponse.json();
            setWallets(walletsData);

            // Fetch transactions for the selected group or all transactions
            const transactionsUrl = `${API_BASE}/transactions?hours=${hours}&type=${type}${groupId ? `&groupId=${groupId}` : ''}`;
            const transactionsResponse = await fetch(transactionsUrl);
            if (!transactionsResponse.ok) throw new Error('Failed to fetch transactions');
            const transactionsData = await transactionsResponse.json();
            setTransactions(transactionsData);

            // Fetch monitoring status
            const statusResponse = await fetch(`${API_BASE}/monitoring/status`);
            if (!statusResponse.ok) throw new Error('Failed to fetch monitoring status');
            const statusData = await statusResponse.json();
            setMonitoringStatus(statusData);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching data:`, err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();

        // Set up SSE for real-time transaction updates
        const groupIdQuery = selectedGroup ? `?groupId=${selectedGroup}` : '';
        const eventSource = new EventSource(`${API_BASE}/transactions/stream${groupIdQuery}`);
        eventSource.onmessage = (event) => {
            try {
                const transaction = JSON.parse(event.data);
                setTransactions((prev) => [transaction, ...prev.slice(0, 99)]);
            } catch (err) {
                console.error(`[${new Date().toISOString()}] ❌ Error parsing SSE transaction:`, err);
            }
        };
        eventSource.onerror = () => {
            console.error(`[${new Date().toISOString()}] ❌ SSE connection error`);
            eventSource.close();
        };

        return () => eventSource.close();
    }, [refreshKey, selectedGroup]);

    const addWallet = async (address, name, groupId) => {
        try {
            setLoading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/wallets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, name, groupId: groupId || null }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to add wallet');
            console.log(`[${new Date().toISOString()}] ✅ Wallet added: ${address}${groupId ? ` to group ${groupId}` : ''}`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const addWalletsBulk = async (wallets, groupId) => {
        try {
            setLoading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/wallets/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallets, groupId: groupId || null }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to import wallets');
            console.log(`[${new Date().toISOString()}] ✅ Bulk import completed: ${data.results.successful} successful, ${data.results.failed} failed`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error in bulk import:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const removeWallet = async (address) => {
        try {
            setLoading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/wallets/${address}`, {
                method: 'DELETE',
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to remove wallet');
            console.log(`[${new Date().toISOString()}] 🗑️ Wallet removed: ${address}`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const removeAllWallets = async () => {
        try {
            setLoading(true);
            setError(null);
            const url = selectedGroup ? `${API_BASE}/wallets?groupId=${selectedGroup}` : `${API_BASE}/wallets`;
            const response = await fetch(url, {
                method: 'DELETE',
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to remove all wallets');
            console.log(`[${new Date().toISOString()}] 🗑️ All wallets removed${selectedGroup ? ` for group ${selectedGroup}` : ''}`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const toggleMonitoring = async () => {
        try {
            setLoading(true);
            setError(null);
            const action = monitoringStatus.isMonitoring ? 'stop' : 'start';
            const response = await fetch(`${API_BASE}/monitoring/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, groupId: selectedGroup || null }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to toggle monitoring');
            console.log(`[${new Date().toISOString()}] ${action === 'start' ? '🚀 Monitoring started' : '⏹️ Monitoring stopped'}${selectedGroup ? ` for group ${selectedGroup}` : ''}`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error toggling monitoring:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const createGroup = async (name) => {
        try {
            setLoading(true);
            setError(null);
            const response = await fetch(`${API_BASE}/groups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to create group');
            console.log(`[${new Date().toISOString()}] ✅ Group created: ${name}`);
            setRefreshKey((prev) => prev + 1);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] ❌ Error creating group:`, err);
            setError(err.message);
            setLoading(false);
        }
    };

    const handleGroupChange = (groupId) => {
        setSelectedGroup(groupId || null);
        setRefreshKey((prev) => prev + 1);
    };

    return (
        <div className="container">
            <Header />
            {loading && <LoadingSpinner />}
            {error && <ErrorMessage message={error} />}
            <div className="controls">
                <select
                    value={selectedGroup || ''}
                    onChange={(e) => handleGroupChange(e.target.value)}
                >
                    <option value="">All Groups</option>
                    {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                            {group.name} ({group.walletCount})
                        </option>
                    ))}
                </select>
                <button onClick={toggleMonitoring}>
                    {monitoringStatus.isMonitoring ? 'Stop Monitoring' : 'Start Monitoring'}
                </button>
                <select
                    value={timeframe}
                    onChange={(e) => {
                        setTimeframe(e.target.value);
                        setRefreshKey((prev) => prev + 1);
                    }}
                >
                    <option value="1">1 Hour</option>
                    <option value="24">24 Hours</option>
                    <option value="168">7 Days</option>
                </select>
                <select
                    value={transactionType}
                    onChange={(e) => {
                        setTransactionType(e.target.value);
                        setRefreshKey((prev) => prev + 1);
                    }}
                >
                    <option value="all">All Transactions</option>
                    <option value="buy">Buy Only</option>
                    <option value="sell">Sell Only</option>
                </select>
                <button onClick={() => setView(view === 'tokens' ? 'wallets' : 'tokens')}>
                    {view === 'tokens' ? 'Show Wallets' : 'Show Token Tracker'}
                </button>
            </div>
            <WalletManager
                onAddWallet={addWallet}
                onAddWalletsBulk={addWalletsBulk}
                onCreateGroup={createGroup}
                groups={groups}
            />
            <MonitoringStatus status={monitoringStatus} />
            {view === 'tokens' ? (
                <TokenTracker timeframe={timeframe} groupId={selectedGroup} />
            ) : (
                <WalletList
                    wallets={wallets}
                    onRemoveWallet={removeWallet}
                    onRemoveAllWallets={removeAllWallets}
                />
            )}
            <TransactionFeed transactions={transactions} />
        </div>
    );
}

export default App;