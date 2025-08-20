import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import WalletList from './components/WalletList';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';
import TokenTracker from './components/TokenTracker';
import TelegramLogin from './components/TelegramLogin';
import AdminPanel from './components/AdminPanel';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';
const TELEGRAM_BOT_USERNAME = process.env.REACT_APP_TELEGRAM_BOT_USERNAME || 'test_walletpulse_bot';

function App() {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  
  // Existing state
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

  // Check authentication on app load
  useEffect(() => {
    checkAuthentication();
  }, []);

  const checkAuthentication = async () => {
    const sessionToken = localStorage.getItem('sessionToken');
    const savedUser = localStorage.getItem('user');

    if (!sessionToken || !savedUser) {
      setIsCheckingAuth(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/auth/validate`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });

      if (response.ok) {
        const userData = JSON.parse(savedUser);
        setUser(userData);
        setIsAuthenticated(true);
      } else {
        // Invalid session, clear local storage
        localStorage.removeItem('sessionToken');
        localStorage.removeItem('user');
      }
    } catch (error) {
      console.error('Auth check error:', error);
      localStorage.removeItem('sessionToken');
      localStorage.removeItem('user');
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleLogin = (authData) => {
    setUser(authData.user);
    setIsAuthenticated(true);
    setLoading(true);
    fetchData();
  };

  const handleLogout = () => {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('user');
    setUser(null);
    setIsAuthenticated(false);
    setShowAdminPanel(false);
  };

  // Helper function to get auth headers
  const getAuthHeaders = () => {
    const sessionToken = localStorage.getItem('sessionToken');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    };
  };

  const removeAllWallets = async () => {
    try {
      const url = selectedGroup ? `${API_BASE}/wallets?groupId=${selectedGroup}` : `${API_BASE}/wallets`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error('Failed to remove all wallets');
      }

      const data = await response.json();
      setRefreshKey((prev) => prev + 1);
      return data;
    } catch (err) {
      throw new Error(err.message);
    }
  };

  const fetchData = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);
      console.log(`🔍 Fetching data: hours=${hours}, type=${type}, groupId=${groupId}`);

      const headers = getAuthHeaders();
      const transactionsUrl = `${API_BASE}/transactions?hours=${hours}&limit=400${type !== 'all' ? `&type=${type}` : ''}${groupId ? `&groupId=${groupId}` : ''}`;
      const walletsUrl = groupId ? `${API_BASE}/wallets?groupId=${groupId}` : `${API_BASE}/wallets`;
      const groupsUrl = `${API_BASE}/groups`;

      const [walletsRes, transactionsRes, statusRes, groupsRes] = await Promise.all([
        fetch(walletsUrl, { headers }),
        fetch(transactionsUrl, { headers }),
        fetch(`${API_BASE}/monitoring/status${groupId ? `?groupId=${groupId}` : ''}`, { headers }),
        fetch(groupsUrl, { headers }),
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

  // FIXED: SSE connection with authentication
  useEffect(() => {
    if (!isAuthenticated) return;

    const sessionToken = localStorage.getItem('sessionToken');
    if (!sessionToken) return;

    // Create SSE URL with token as query parameter
    const sseUrl = new URL(`${API_BASE}/transactions/stream`);
    sseUrl.searchParams.append('token', sessionToken);
    if (selectedGroup) {
      sseUrl.searchParams.append('groupId', selectedGroup);
    }

    console.log('🔌 Connecting to SSE:', sseUrl.toString());

    const eventSource = new EventSource(sseUrl.toString());

    eventSource.onopen = () => {
      console.log('✅ SSE connection opened');
      setError(null); // Clear any previous SSE errors
    };

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

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      
      // Check if it's an authentication error
      if (eventSource.readyState === EventSource.CLOSED) {
        console.error('SSE connection was closed, possibly due to authentication failure');
        setError('Real-time connection lost. Please refresh the page.');
      }
      
      eventSource.close();
      
      // Attempt to reconnect after a delay
      setTimeout(() => {
        console.log('Attempting to reconnect to SSE...');
        // This will trigger a re-render and recreate the connection
        setRefreshKey(prev => prev + 1);
      }, 5000);
    };

    return () => {
      console.log('🔌 Closing SSE connection');
      eventSource.close();
    };
  }, [timeframe, transactionType, wallets, selectedGroup, isAuthenticated, refreshKey]);

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
        headers: getAuthHeaders(),
        body: JSON.stringify({ groupId: selectedGroupId }),
      });
      fetchData(timeframe, transactionType, selectedGroupId);
    } catch (error) {
      console.error('Error switching group:', error);
      setError('Failed to switch group');
    }
  };

  const handleAddWalletsBulk = async (wallets, groupId, progressCallback) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 1000; // Уменьшено с 2000ms
    const OPTIMIZED_CHUNK_SIZE = 1000; // Увеличено с 200-500 до 1000

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const sendChunkWithRetry = async (chunk, chunkIndex, totalChunks, attempt = 1) => {
      try {
        console.log(`🚀 Sending optimized chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} wallets, attempt ${attempt})`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 минут timeout

        if (progressCallback) {
          progressCallback({
            current: chunkIndex * OPTIMIZED_CHUNK_SIZE,
            total: wallets.length,
            batch: chunkIndex + 1,
            phase: 'uploading'
          });
        }

        const response = await fetch('/api/wallets/bulk-optimized', {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            wallets: chunk,
            groupId,
            optimized: true // Флаг для оптимизированной обработки
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        console.log(`📊 Response status: ${response.status}`);
        const contentType = response.headers.get('Content-Type');

        if (!response.ok) {
          let errorMessage = `HTTP ${response.status}`;

          try {
            if (contentType && contentType.includes('application/json')) {
              const errorData = await response.json();
              errorMessage = errorData.error || errorData.message || errorMessage;
            } else {
              const errorText = await response.text();
              console.error('Non-JSON error response:', errorText.substring(0, 500));
              errorMessage = errorText.includes('<!DOCTYPE') || errorText.includes('<html') 
                ? 'Server returned HTML error page instead of JSON. Check server logs.' 
                : errorText.substring(0, 200);
            }
          } catch (parseError) {
            console.error('Error parsing error response:', parseError);
            errorMessage = `HTTP ${response.status} - Could not parse error response`;
          }

          throw new Error(errorMessage);
        }

        if (!contentType || !contentType.includes('application/json')) {
          const responseText = await response.text();
          console.error('Unexpected response format:', responseText.substring(0, 200));
          throw new Error(`Expected JSON response but got: ${contentType}`);
        }

        const result = await response.json();

        if (!result.success && !result.results) {
          throw new Error(result.error || 'Unknown server error');
        }

        console.log(`✅ Chunk ${chunkIndex + 1} completed: +${result.results.successful} successful, +${result.results.failed} failed`);
        return result;

      } catch (error) {
        console.error(`❌ Chunk ${chunkIndex + 1} attempt ${attempt} failed:`, error.message);

        if (error.name === 'AbortError') {
          throw new Error('Request timeout - chunk took too long to process');
        }

        if (attempt < MAX_RETRIES && (
          error.message.includes('fetch') ||
          error.message.includes('network') ||
          error.message.includes('timeout') ||
          error.message.includes('TIMEOUT')
        )) {
          console.log(`⏳ Retrying chunk ${chunkIndex + 1} in ${RETRY_DELAY * attempt}ms...`);
          await sleep(RETRY_DELAY * attempt);
          return sendChunkWithRetry(chunk, chunkIndex, totalChunks, attempt + 1);
        }

        throw error;
      }
    };

    try {
      console.log(`🚀 Starting OPTIMIZED bulk import of ${wallets.length} wallets with ${OPTIMIZED_CHUNK_SIZE} wallets per chunk`);

      const chunks = [];
      for (let i = 0; i < wallets.length; i += OPTIMIZED_CHUNK_SIZE) {
        chunks.push(wallets.slice(i, i + OPTIMIZED_CHUNK_SIZE));
      }

      console.log(`📦 Created ${chunks.length} optimized chunks (${OPTIMIZED_CHUNK_SIZE} wallets per chunk)`);

      let totalResults = {
        total: wallets.length,
        successful: 0,
        failed: 0,
        errors: [],
        successfulWallets: []
      };

      // Параллельная обработка небольших батчей для ускорения
      const PARALLEL_BATCHES = Math.min(3, chunks.length); // Максимум 3 параллельных запроса
      
      for (let i = 0; i < chunks.length; i += PARALLEL_BATCHES) {
        const batchChunks = chunks.slice(i, Math.min(i + PARALLEL_BATCHES, chunks.length));
        
        if (progressCallback) {
          progressCallback({
            current: i * OPTIMIZED_CHUNK_SIZE,
            total: wallets.length,
            batch: i + 1,
            phase: 'processing'
          });
        }

        // Параллельная обработка батча
        const batchPromises = batchChunks.map((chunk, batchIndex) => 
          sendChunkWithRetry(chunk, i + batchIndex, chunks.length)
        );

        try {
          const batchResults = await Promise.all(batchPromises);
          
          batchResults.forEach(chunkResult => {
            totalResults.successful += chunkResult.results.successful || 0;
            totalResults.failed += chunkResult.results.failed || 0;

            if (chunkResult.results.errors) {
              totalResults.errors.push(...chunkResult.results.errors);
            }

            if (chunkResult.results.successfulWallets) {
              totalResults.successfulWallets.push(...chunkResult.results.successfulWallets);
            }
          });

          console.log(`🎯 Batch ${Math.floor(i / PARALLEL_BATCHES) + 1} completed: ${totalResults.successful} total successful`);

        } catch (batchError) {
          console.error(`❌ Batch ${Math.floor(i / PARALLEL_BATCHES) + 1} failed:`, batchError.message);
          
          // При ошибке батча помечаем все кошельки в нем как failed
          batchChunks.forEach(chunk => {
            totalResults.failed += chunk.length;
            totalResults.errors.push({
              address: `batch_${Math.floor(i / PARALLEL_BATCHES) + 1}`,
              error: `Entire batch failed: ${batchError.message}`,
              walletCount: chunk.length
            });
          });
        }

        // Короткая пауза между батчами для снижения нагрузки на сервер
        if (i + PARALLEL_BATCHES < chunks.length) {
          await sleep(100);
        }
      }

      if (progressCallback) {
        progressCallback({
          current: wallets.length,
          total: wallets.length,
          batch: chunks.length,
          phase: 'completed'
        });
      }

      const successRate = ((totalResults.successful / totalResults.total) * 100).toFixed(1);
      console.log(`🎉 OPTIMIZED bulk import completed: ${totalResults.successful}/${totalResults.total} successful (${successRate}%)`);

      return {
        success: totalResults.successful > 0,
        message: `Optimized bulk import completed: ${totalResults.successful} successful, ${totalResults.failed} failed (${successRate}% success rate)`,
        results: totalResults
      };

    } catch (error) {
      console.error('❌ Optimized bulk import failed:', error);
      throw new Error(`Optimized bulk import failed: ${error.message}`);
    }
  };

  const removeWallet = async (address) => {
    try {
      const response = await fetch(`${API_BASE}/wallets/${address}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
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
        headers: getAuthHeaders(),
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
        headers: getAuthHeaders(),
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
    if (isAuthenticated) {
      fetchData();
    }
  }, [refreshKey, isAuthenticated]);

  // Show loading while checking authentication
  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-6xl mx-auto">
          <Header />
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  // Show login if not authenticated
  if (!isAuthenticated) {
    return <TelegramLogin onLogin={handleLogin} botUsername={TELEGRAM_BOT_USERNAME} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-8 px-4">
        <div className="max-w-6xl mx-auto">
          <Header user={user} onLogout={handleLogout} onOpenAdmin={() => setShowAdminPanel(true)} />
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <Header user={user} onLogout={handleLogout} onOpenAdmin={() => setShowAdminPanel(true)} />
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
            </div>
          </div>
        </div>
        <WalletManager onAddWalletsBulk={handleAddWalletsBulk} onCreateGroup={createGroup} groups={groups} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <WalletList
              wallets={wallets}
              onRemoveWallet={removeWallet}
              onRemoveAllWallets={removeAllWallets}
            />
          </div>
          <div className="lg:col-span-2">
            {view === 'tokens' && (
              <TokenTracker groupId={selectedGroup} transactions={transactions} timeframe={timeframe} />
            )}
          </div>
        </div>
      </div>

      {showAdminPanel && user?.isAdmin && (
        <AdminPanel user={user} onClose={() => setShowAdminPanel(false)} />
      )}
    </div>
  );
}

export default App;