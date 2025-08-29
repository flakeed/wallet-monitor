// client/src/App.js - Enhanced version with RPC token data integration

import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import WalletManager from './components/WalletManager';
import MonitoringStatus from './components/MonitoringStatus';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorMessage from './components/ErrorMessage';
import TokenTracker from './components/TokenTracker';
import TelegramLogin from './components/TelegramLogin';
import AdminPanel from './components/AdminPanel';
import NewTokensPanel from './components/NewTokensPanel';

const API_BASE = process.env.REACT_APP_API_BASE || 'https://158.220.125.26:5001/api';
const TELEGRAM_BOT_USERNAME = process.env.REACT_APP_TELEGRAM_BOT_USERNAME || 'test_walletpulse_bot';

function App() {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showNewTokens, setShowNewTokens] = useState(false);
  const [enhancedMode, setEnhancedMode] = useState(true); // Use enhanced RPC features
  
  // State management
  const [walletCount, setWalletCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [monitoringStatus, setMonitoringStatus] = useState({ isMonitoring: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [timeframe, setTimeframe] = useState('24');
  const [transactionType, setTransactionType] = useState('all');
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupInfo, setSelectedGroupInfo] = useState(null);
  
  // Enhanced features state
  const [solPrice, setSolPrice] = useState(150);
  const [serviceStats, setServiceStats] = useState(null);
  const [rpcConnected, setRpcConnected] = useState(false);

  // Check authentication on app load
  useEffect(() => {
    checkAuthentication();
  }, []);

  // Check RPC connectivity and get SOL price
  useEffect(() => {
    if (isAuthenticated && enhancedMode) {
      checkRpcConnectivity();
      fetchSolPrice();
      
      // Update SOL price every 30 seconds
      const interval = setInterval(fetchSolPrice, 30000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, enhancedMode]);

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
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const checkRpcConnectivity = async () => {
    try {
      const response = await fetch(`${API_BASE}/tokens/rpc-test`, {
        headers: getAuthHeaders()
      });
      
      if (response.ok) {
        const data = await response.json();
        setRpcConnected(data.data?.overallSuccess || false);
        console.log(`[${new Date().toISOString()}] 🔗 RPC connectivity:`, data.data?.overallSuccess ? 'Connected' : 'Issues detected');
      }
    } catch (error) {
      console.warn('RPC connectivity check failed:', error.message);
      setRpcConnected(false);
    }
  };

  const fetchSolPrice = async () => {
    try {
      const response = await fetch(`${API_BASE}/solana/price`, {
        headers: getAuthHeaders()
      });
      
      if (response.ok) {
        const data = await response.json();
        setSolPrice(data.price || 150);
      }
    } catch (error) {
      console.warn('Failed to fetch SOL price:', error.message);
    }
  };

  const fetchServiceStats = async () => {
    if (!user?.isAdmin) return;
    
    try {
      const response = await fetch(`${API_BASE}/tokens/service-stats`, {
        headers: getAuthHeaders()
      });
      
      if (response.ok) {
        const data = await response.json();
        setServiceStats(data.data);
      }
    } catch (error) {
      console.warn('Failed to fetch service stats:', error.message);
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
    setServiceStats(null);
  };

  // Helper function to get auth headers
  const getAuthHeaders = () => {
    const sessionToken = localStorage.getItem('sessionToken');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`
    };
  };

  // Ultra-fast initialization with enhanced features
  const ultraFastInit = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);
      const startTime = Date.now();

      const headers = getAuthHeaders();
      
      const initUrl = `${API_BASE}/init?hours=${hours}${type !== 'all' ? `&type=${type}` : ''}${groupId ? `&groupId=${groupId}` : ''}`;
      const response = await fetch(initUrl, { headers });

      if (!response.ok) {
        throw new Error('Failed to initialize application data');
      }

      const { data } = await response.json();
      
      // Set all data instantly
      setTransactions(data.transactions);
      setMonitoringStatus(data.monitoring);
      setGroups(data.groups);
      setWalletCount(data.wallets.totalCount);
      
      // Set selected group info
      if (groupId && data.wallets.selectedGroup) {
        setSelectedGroupInfo({
          groupId: data.wallets.selectedGroup.groupId,
          walletCount: data.wallets.selectedGroup.walletCount,
          groupName: data.groups.find(g => g.id === groupId)?.name || 'Unknown Group'
        });
      } else {
        setSelectedGroupInfo(null);
      }

      // If enhanced mode is enabled, fetch additional data
      if (enhancedMode) {
        fetchSolPrice();
        if (user?.isAdmin) {
          fetchServiceStats();
        }
      }

      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] ⚡ Enhanced initialization completed in ${duration}ms`);

    } catch (err) {
      setError(err.message);
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
      
      // Update counters from server response
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
      throw new Error(err.message);
    }
  };

  // Enhanced SSE connection with RPC integration
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

    eventSource.onopen = () => {
      setError(null);
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
            };
            return [formattedTransaction, ...prev].slice(0, 400);
          });
        }
      } catch (err) {
        console.error('Error parsing SSE message:', err);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      
      if (eventSource.readyState === EventSource.CLOSED) {
        setError('Real-time connection lost. Please refresh the page.');
      }
      
      eventSource.close();
      
      setTimeout(() => {
        setRefreshKey(prev => prev + 1);
      }, 5000);
    };

    return () => {
      eventSource.close();
    };
  }, [timeframe, transactionType, selectedGroup, isAuthenticated, refreshKey]);

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

      // Process chunks sequentially
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

          // Aggregate results
          totalResults.successful += result.results.successful || 0;
          totalResults.failed += result.results.failed || 0;

          if (result.results.errors) {
            totalResults.errors.push(...result.results.errors);
          }

          if (result.results.successfulWallets) {
            totalResults.successfulWallets.push(...result.results.successfulWallets);
          }

          // Update wallet count instantly from server response
          if (result.results.newCounts && result.results.successful > 0) {
            setWalletCount(result.results.newCounts.totalWallets);
            
            // Update group info
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

        // Short pause between chunks
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
      ultraFastInit();
    }
  }, [refreshKey, isAuthenticated]);

  // Toggle enhanced mode
  const toggleEnhancedMode = () => {
    setEnhancedMode(!enhancedMode);
    if (!enhancedMode) {
      checkRpcConnectivity();
      fetchSolPrice();
      if (user?.isAdmin) {
        fetchServiceStats();
      }
    }
  };

  // Show loading while checking authentication
  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  // Show login if not authenticated
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
            {enhancedMode && (
              <span className="text-green-400 text-sm">Enhanced Mode</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      {/* Header with Enhanced Mode Toggle */}
      <div className="bg-gray-900 border-b border-gray-700 px-4 py-2">
        <div className="flex items-center justify-between">
          <Header user={user} onLogout={handleLogout} onOpenAdmin={() => setShowAdminPanel(true)} />
          
          {/* Enhanced Mode Controls */}
          <div className="flex items-center space-x-4">
            {enhancedMode && (
              <>
                <div className="text-sm text-gray-400">
                  SOL: <span className="text-green-400 font-medium">${solPrice.toFixed(2)}</span>
                </div>
                <div className={`flex items-center space-x-1 text-xs ${rpcConnected ? 'text-green-400' : 'text-red-400'}`}>
                  <div className={`w-2 h-2 rounded-full ${rpcConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
                  <span>RPC {rpcConnected ? 'Connected' : 'Offline'}</span>
                </div>
              </>
            )}
            
            <button
              onClick={toggleEnhancedMode}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                enhancedMode 
                  ? 'bg-green-600 text-white hover:bg-green-700' 
                  : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
              }`}
            >
              {enhancedMode ? '🚀 Enhanced' : '⚡ Basic'}
            </button>
          </div>
        </div>
      </div>
      
      {/* Error */}
      {error && <ErrorMessage error={error} />}
      
      {/* Monitoring Status */}
      <MonitoringStatus status={monitoringStatus} onToggle={toggleMonitoring} />
      
      {/* New & Trending Tokens Panel */}
      {enhancedMode && (
        <NewTokensPanel 
          isExpanded={showNewTokens}
          onToggle={() => setShowNewTokens(!showNewTokens)}
        />
      )}
      
      {/* Wallet Manager (Collapsible) */}
      <WalletManager 
        onAddWalletsBulk={handleAddWalletsBulk} 
        onCreateGroup={createGroup} 
        groups={groups} 
      />
      
      {/* Token Tracker - Full height */}
      <div className="flex-1 overflow-hidden">
        <TokenTracker 
          groupId={selectedGroup} 
          transactions={transactions} 
          timeframe={timeframe}
          onTimeframeChange={handleTimeframeChange}
          groups={groups}
          selectedGroup={selectedGroup}
          onGroupChange={handleGroupChange}
          walletCount={walletCount}
          selectedGroupInfo={selectedGroupInfo}
          enhancedMode={enhancedMode}
          solPrice={solPrice}
        />
      </div>

      {/* Admin Panel Modal */}
      {showAdminPanel && user?.isAdmin && (
        <AdminPanel 
          user={user} 
          onClose={() => setShowAdminPanel(false)}
          serviceStats={serviceStats}
          rpcConnected={rpcConnected}
          enhancedMode={enhancedMode}
        />
      )}

      {/* Enhanced Mode Notification */}
      {enhancedMode && !rpcConnected && (
        <div className="fixed bottom-4 right-4 bg-yellow-900 border border-yellow-600 text-yellow-200 px-4 py-2 rounded-lg shadow-lg">
          <div className="flex items-center space-x-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 15.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-sm">RPC connection issues detected</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;