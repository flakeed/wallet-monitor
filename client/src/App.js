import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import TransactionFeed from './components/TransactionFeed';
import WalletList from './components/WalletList';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';

const API_BASE = 'http://localhost:5001/api';

function App() {
  const [wallets, setWallets] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monitoringStatus, setMonitoringStatus] = useState({ isMonitoring: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [timeframe, setTimeframe] = useState('24');
  const [transactionType, setTransactionType] = useState('all'); 
console.log('transactions',transactions)

  const fetchData = async (hours = timeframe, type = transactionType) => {
    try {
      setError(null);

      const transactionsUrl = `${API_BASE}/transactions?hours=${hours}&limit=50${type !== 'all' ? `&type=${type}` : ''}`;

      const [walletsRes, transactionsRes, statusRes] = await Promise.all([
        fetch(`${API_BASE}/wallets`),
        fetch(transactionsUrl),
        fetch(`${API_BASE}/monitoring/status`)
      ]);

      if (!walletsRes.ok || !transactionsRes.ok || !statusRes.ok) {
        throw new Error('Failed to fetch data');
      }

      const [walletsData, transactionsData, statusData] = await Promise.all([
        walletsRes.json(),
        transactionsRes.json(),
        statusRes.json()
      ]);

      setWallets(walletsData);
      setTransactions(transactionsData);
      setMonitoringStatus(statusData);
    } catch (err) {
      setError(err.message);
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTimeframeChange = (newTimeframe) => {
    setTimeframe(newTimeframe);
    setLoading(true);
    fetchData(newTimeframe, transactionType);
  };

  const handleTransactionTypeChange = (newType) => {
    setTransactionType(newType);
    setLoading(true);
    fetchData(timeframe, newType);
  };

  const addWallet = async (address, name) => {
    try {
      const response = await fetch(`${API_BASE}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), name: name.trim() || null })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add wallet');
      }

      setRefreshKey(prev => prev + 1);
      return { success: true, message: data.message };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const removeWallet = async (address) => {
    try {
      const response = await fetch(`${API_BASE}/wallets/${address}`, {
        method: 'DELETE'
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove wallet');
      }

      setRefreshKey(prev => prev + 1);
      return { success: true, message: data.message };
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const toggleMonitoring = async (action) => {
    try {
      const response = await fetch(`${API_BASE}/monitoring/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to toggle monitoring');
      }

      setRefreshKey(prev => prev + 1);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchData();
  }, [refreshKey]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchData();
    }, 30000);

    return () => clearInterval(interval);
  }, [timeframe, transactionType]);

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

        <MonitoringStatus
          status={monitoringStatus}
          onToggle={toggleMonitoring}
        />

        <WalletManager onAddWallet={addWallet} />

        {/* Фильтры транзакций */}
        <div className="bg-white rounded-lg shadow-sm border p-4 mb-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Transaction Filters</h3>
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
                  <option value="168">Last 7 days</option>
                </select>
              </div>
            </div>
          </div>

          {/* Статистика по типам транзакций */}
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="bg-blue-50 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-blue-700">Total Transactions</span>
                <span className="font-semibold text-blue-900">
                  {transactions.length}
                </span>
              </div>
            </div>
            
            <div className="bg-green-50 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-green-700">Buy Transactions</span>
                <span className="font-semibold text-green-900">
                  {transactions.filter(tx => tx.transactionType === 'buy').length}
                </span>
              </div>
            </div>
            
            <div className="bg-red-50 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-red-700">Sell Transactions</span>
                <span className="font-semibold text-red-900">
                  {transactions.filter(tx => tx.transactionType === 'sell').length}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <WalletList
              wallets={wallets}
              onRemoveWallet={removeWallet}
            />
          </div>

          <div className="lg:col-span-2">
            <TransactionFeed
              transactions={transactions}
              timeframe={timeframe}
              transactionType={transactionType}
              onTimeframeChange={handleTimeframeChange}
              onTransactionTypeChange={handleTransactionTypeChange}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;