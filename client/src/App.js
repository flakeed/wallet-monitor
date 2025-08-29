import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
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
  
  // State management
  const [walletCount, setWalletCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [newTokens, setNewTokens] = useState([]);
  const [monitoringStatus, setMonitoringStatus] = useState({ isMonitoring: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [timeframe, setTimeframe] = useState('24');
  const [transactionType, setTransactionType] = useState('all');
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupInfo, setSelectedGroupInfo] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connected'); // New state for WebSocket status

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
        localStorage.removeItem('sessionToken');
        localStorage.removeItem('user');
      }
    } catch (error) {
      console.error('Session check error:', error);
      localStorage.removeItem('sessionToken');
      localStorage.removeItem('user');
      setError('Authentication failed. Please try logging in again.');
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleLogin = (authData) => {
    setUser(authData.user);
    setIsAuthenticated(true);
    setLoading(true);
    ultraFastInit();
  };

  const handleLogout = () => {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('user');
    setUser(null);
    setIsAuthenticated(false);
    setShowAdminPanel(false);
    setConnectionStatus('disconnected');
  };

  const getAuthHeaders = () => {
    const sessionToken = localStorage.getItem('sessionToken');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    };
  };

  const fetchNewTokens = async () => {
    try {
      const response = await fetch(`${API_BASE}/tokens/new`, {
        headers: getAuthHeaders()
      });
      if (!response.ok) throw new Error('Failed to fetch new tokens');
      const { tokens } = await response.json();
      setNewTokens(tokens);
    } catch (error) {
      console.error('Error fetching new tokens:', error);
      setError('Failed to load new tokens. Retrying...');
    }
  };

  const ultraFastInit = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);
      setLoading(true);
      const headers = getAuthHeaders();
      
      const initUrl = `${API_BASE}/init?hours=${hours}${type !== 'all' ? `&type=${type}` : ''}${groupId ? `&groupId=${groupId}` : ''}`;
      const response = await fetch(initUrl, { headers });

      if (!response.ok) {
        throw new Error('Failed to initialize application data');
      }

      const { data } = await response.json();
      
      setTransactions(data.transactions);
      setMonitoringStatus(data.monitoring);
      setGroups(data.groups);
      setWalletCount(data.wallets.totalCount);
      
      await fetchNewTokens();
      
      if (groupId && data.wallets.selectedGroup) {
        setSelectedGroupInfo({
          groupId: data.wallets.selectedGroup.groupId,
          walletCount: data.wallets.selectedGroup.walletCount,
          groupName: data.groups.find(g => g.id === groupId)?.name || 'Unknown Group'
        });
      } else {
        setSelectedGroupInfo(null);
      }

    } catch (err) {
      setError(`Initialization failed: ${err.message}. Retrying...`);
      console.error('Error in ultra-fast init:', err);
    } finally {
      setLoading(false);
    }
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
      
      if (data.newCounts) {
        setWalletCount(data.newCounts.totalWallets);
        if (selectedGroup && data.newCounts.selectedGroup) {
          setSelectedGroupInfo({
            groupId: data.newCounts.selectedGroup.groupId,
            walletCount: data.newCounts.selectedGroup.walletCount,
            groupName: selectedGroupInfo?.groupName || 'Unknown Group'
          });
        } else if (!selectedGroup) {
          setSelectedGroupInfo(null);
        }
      } else {
        setWalletCount(0);
        if (selectedGroupInfo) {
          setSelectedGroupInfo({
            ...selectedGroupInfo,
            walletCount: 0
          });
        }
      }
      
      setRefreshKey((prev) => prev + 1);
      return data;
    } catch (err) {
      setError(`Failed to remove wallets: ${err.message}`);
      throw new Error(err.message);
    }
  };

  // SSE connection for real-time updates
  useEffect(() => {
    if (!isAuthenticated) return;

    const sessionToken = localStorage.getItem('sessionToken');
    if (!sessionToken) return;

    const sseUrl = new URL(`${API_BASE}/transactions/stream`);
    sseUrl.searchParams.append('token', sessionToken);
    if (selectedGroup) {
      sseUrl.searchParams.append('groupId', selectedGroup);
    }

    const eventSource = new EventSource(sseUrl.toString());
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    eventSource.onopen = () => {
      setError(null);
      setConnectionStatus('connected');
      reconnectAttempts = 0;
    };

    eventSource.onmessage = (event) => {
      try {
        const newTransaction = JSON.parse(event.data);

        const now = new Date();
        const txTime = new Date(newTransaction.timestamp);
        const hoursDiff = (now - txTime) / (1000 * 60 * 60);
        const matchesTimeframe = hoursDiff <= parseInt(timeframe);
        const matchesType = transactionType === 'all' || newTransaction.transactionType === transactionType;
        const matchesGroup = !selectedGroup || newTransaction.groupId === selectedGroup;

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
                name: newTransaction.walletName || null,
                group_id: newTransaction.groupId,
                group_name: newTransaction.groupName,
              },
              tokensBought: newTransaction.transactionType === 'buy' ? newTransaction.tokens : [],
              tokensSold: newTransaction.transactionType === 'sell' ? newTransaction.tokens : [],
              pnl: newTransaction.pnl
            };
            return [formattedTransaction, ...prev].slice(0, 400);
          });
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
        setError('Failed to process real-time updates');
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      setConnectionStatus('disconnected');
      
      if (eventSource.readyState === EventSource.CLOSED && reconnectAttempts < maxReconnectAttempts) {
        setError(`Real-time connection lost. Attempting to reconnect (${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
        reconnectAttempts++;
        setTimeout(() => {
          setRefreshKey(prev => prev + 1);
        }, 5000 * reconnectAttempts);
      } else if (reconnectAttempts >= maxReconnectAttempts) {
        setError('Real-time connection failed after multiple attempts. Please refresh the page.');
        eventSource.close();
      }
    };

    return () => {
      eventSource.close();
    };
  }, [timeframe, transactionType, selectedGroup, isAuthenticated, refreshKey]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchNewTokens();
    const interval = setInterval(fetchNewTokens, 60000);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const handleTimeframeChange = (newTimeframe) => {
    setTimeframe(newTimeframe);
    setLoading(true);
    ultraFastInit(newTimeframe, transactionType, selectedGroup);
  };

  const handleTransactionTypeChange = (newType) => {
    setTransactionType(newType);
    setLoading(true);
    ultraFastInit(timeframe, newType, selectedGroup);
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
      
      ultraFastInit(timeframe, transactionType, selectedGroupId);
    } catch (error) {
      console.error('Error switching group:', error);
      setError('Failed to switch group');
    }
  };

  const handleAddWalletsBulk = async (wallets, groupId, progressCallback) => {
    const startTime = Date.now();
    
    try {
      if (progressCallback) {
        progressCallback({
          current: 0,
          total: wallets.length,
          batch: 1,
          phase: 'validating'
        });
      }

      const ULTRA_CHUNK_SIZE = 1000;
      const chunks = [];
      for (let i = 0; i < wallets.length; i += ULTRA_CHUNK_SIZE) {
        chunks.push(wallets.slice(i, i + ULTRA_CHUNK_SIZE));
      }

      let totalResults = {
        total: wallets.length,
        successful: 0,
        failed: 0,
        errors: [],
        successfulWallets: []
      };

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        if (progressCallback) {
          progressCallback({
            current: i * ULTRA_CHUNK_SIZE,
            total: wallets.length,
            batch: i + 1,
            phase: 'uploading'
          });
        }

        try {
          const response = await fetch(`${API_BASE}/wallets/bulk-optimized`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              wallets: chunk,
              groupId,
              optimized: true
            })
          });

          if (!response.ok) {
            throw new Error(`Chunk ${i + 1} failed: HTTP ${response.status}`);
          }

          const result = await response.json();

          if (!result.success && !result.results) {
            throw new Error(result.error || 'Unknown server error');
          }

          totalResults.successful += result.results.successful || 0;
          totalResults.failed += result.results.failed || 0;

          if (result.results.errors) {
            totalResults.errors.push(...result.results.errors);
          }

          if (result.results.successfulWallets) {
            totalResults.successfulWallets.push(...result.results.successfulWallets);
          }

          if (result.results.newCounts && result.results.successful > 0) {
            setWalletCount(result.results.newCounts.totalWallets);
            
            if (selectedGroupInfo && (!groupId || groupId === selectedGroupInfo.groupId)) {
              const newGroupCount = result.results.newCounts.groupCounts?.find(gc => gc.groupId === selectedGroupInfo.groupId)?.count;
              if (newGroupCount !== undefined) {
                setSelectedGroupInfo(prev => prev ? {
                  ...prev,
                  walletCount: newGroupCount
                } : null);
              }
            }
          }

        } catch (chunkError) {
          console.error(`Chunk ${i + 1} failed:`, chunkError.message);
          
          totalResults.failed += chunk.length;
          totalResults.errors.push({
            address: `chunk_${i + 1}`,
            error: `Entire chunk failed: ${chunkError.message}`,
            walletCount: chunk.length
          });
        }

        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
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

      const duration = Date.now() - startTime;
      const walletsPerSecond = Math.round((totalResults.successful / duration) * 1000);
      const successRate = ((totalResults.successful / totalResults.total) * 100).toFixed(1);

      return {
        success: totalResults.successful > 0,
        message: `Import: ${totalResults.successful} successful, ${totalResults.failed} failed (${successRate}% success rate)`,
        results: totalResults
      };

    } catch (error) {
      console.error('Bulk import failed:', error);
      setError(`Bulk import failed: ${error.message}`);
      throw new Error(`Bulk import failed: ${error.message}`);
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
      setError(`Failed to create group: ${err.message}`);
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
      setError(`Failed to toggle monitoring: ${err.message}`);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      ultraFastInit();
    }
  }, [refreshKey, isAuthenticated]);

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <TelegramLogin onLogin={handleLogin} botUsername={TELEGRAM_BOT_USERNAME} />;
  }

  if (loading) {
    return (
      <div className="h-screen bg-gray-900 flex flex-col">
        <Header user={user} onLogout={handleLogout} onOpenAdmin={() => setShowAdminPanel(true)} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center space-x-3">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            <span className="text-white">Loading wallets...</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      <Header user={user} onLogout={handleLogout} onOpenAdmin={() => setShowAdminPanel(true)} />
      
      {error && <ErrorMessage error={error} />}
      
      {connectionStatus === 'disconnected' && (
        <div className="bg-red-900/20 border border-red-700 text-red-400 text-sm p-2 text-center">
          Real-time updates unavailable. Retrying connection...
        </div>
      )}
      
      <MonitoringStatus status={monitoringStatus} onToggle={toggleMonitoring} />
      
      <WalletManager 
        onAddWalletsBulk={handleAddWalletsBulk} 
        onCreateGroup={createGroup} 
        groups={groups} 
      />
      
      <div className="flex-1 overflow-hidden">
        <TokenTracker 
          groupId={selectedGroup} 
          transactions={transactions} 
          newTokens={newTokens}
          timeframe={timeframe}
          onTimeframeChange={handleTimeframeChange}
          groups={groups}
          selectedGroup={selectedGroup}
          onGroupChange={handleGroupChange}
          walletCount={walletCount}
          selectedGroupInfo={selectedGroupInfo}
        />
      </div>

      {showAdminPanel && user?.isAdmin && (
        <AdminPanel user={user} onClose={() => setShowAdminPanel(false)} />
      )}
    </div>
  );
}

export default App;