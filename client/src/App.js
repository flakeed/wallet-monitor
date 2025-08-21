// client/src/App.js - УЛЬТРА-БЫСТРАЯ версия

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
  
  // Ultra-optimized state management
  const [walletCount, setWalletCount] = useState(0);
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
  const [selectedGroupInfo, setSelectedGroupInfo] = useState(null);
  const [initializationTime, setInitializationTime] = useState(null);

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
    ultraFastInit();
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

  // НОВАЯ УЛЬТРА-БЫСТРАЯ ИНИЦИАЛИЗАЦИЯ
  const ultraFastInit = async (hours = timeframe, type = transactionType, groupId = selectedGroup) => {
    try {
      setError(null);
      // console.log(`🚀 ULTRA-FAST initialization: hours=${hours}, type=${type}, groupId=${groupId}`);
      const startTime = Date.now();

      const headers = getAuthHeaders();
      
      // ОДИН ЗАПРОС для получения всех данных
      const initUrl = `${API_BASE}/init?hours=${hours}${type !== 'all' ? `&type=${type}` : ''}${groupId ? `&groupId=${groupId}` : ''}`;
      const response = await fetch(initUrl, { headers });

      if (!response.ok) {
        throw new Error('Failed to initialize application data');
      }

      const { data, duration } = await response.json();
      
      // Мгновенно устанавливаем все данные
      setTransactions(data.transactions);
      setMonitoringStatus(data.monitoring);
      setGroups(data.groups);
      setWalletCount(data.wallets.totalCount);
      
      // Устанавливаем информацию о выбранной группе
      if (groupId && data.wallets.selectedGroup) {
        setSelectedGroupInfo({
          groupId: data.wallets.selectedGroup.groupId,
          walletCount: data.wallets.selectedGroup.walletCount,
          groupName: data.groups.find(g => g.id === groupId)?.name || 'Unknown Group'
        });
      } else {
        setSelectedGroupInfo(null);
      }

      const clientTime = Date.now() - startTime;
      setInitializationTime(duration);
      
      // console.log(`✅ ULTRA-FAST init completed: ${duration}ms server + ${clientTime}ms client = ${duration + clientTime}ms total`);
      // console.log(`📊 Loaded: ${data.wallets.totalCount} wallets, ${data.transactions.length} transactions`);

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
      
      // Быстро обновляем счетчики из ответа сервера
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
        // Fallback - устанавливаем в 0
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

  // SSE connection остается прежним
  useEffect(() => {
    if (!isAuthenticated) return;

    const sessionToken = localStorage.getItem('sessionToken');
    if (!sessionToken) return;

    const sseUrl = new URL(`${API_BASE}/transactions/stream`);
    sseUrl.searchParams.append('token', sessionToken);
    if (selectedGroup) {
      sseUrl.searchParams.append('groupId', selectedGroup);
    }

    console.log('🔌 Connecting to SSE:', sseUrl.toString());

    const eventSource = new EventSource(sseUrl.toString());

    eventSource.onopen = () => {
      console.log('✅ SSE connection opened');
      setError(null);
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
        console.log('Attempting to reconnect to SSE...');
        setRefreshKey(prev => prev + 1);
      }, 5000);
    };

    return () => {
      console.log('🔌 Closing SSE connection');
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
      // console.log(`🚀 Starting ULTRA-OPTIMIZED bulk import of ${wallets.length} wallets`);

      if (progressCallback) {
        progressCallback({
          current: 0,
          total: wallets.length,
          batch: 1,
          phase: 'validating'
        });
      }

      // Разбиваем на chunks по 1000 кошельков для ультра-оптимизированного эндпоинта
      const ULTRA_CHUNK_SIZE = 1000;
      const chunks = [];
      for (let i = 0; i < wallets.length; i += ULTRA_CHUNK_SIZE) {
        chunks.push(wallets.slice(i, i + ULTRA_CHUNK_SIZE));
      }

      // console.log(`📦 Created ${chunks.length} ultra-optimized chunks`);

      let totalResults = {
        total: wallets.length,
        successful: 0,
        failed: 0,
        errors: [],
        successfulWallets: []
      };

      // Последовательная обработка chunks для стабильности
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
          // console.log(`🚀 Processing ultra-optimized chunk ${i + 1}/${chunks.length} (${chunk.length} wallets)`);

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

          // Агрегируем результаты
          totalResults.successful += result.results.successful || 0;
          totalResults.failed += result.results.failed || 0;

          if (result.results.errors) {
            totalResults.errors.push(...result.results.errors);
          }

          if (result.results.successfulWallets) {
            totalResults.successfulWallets.push(...result.results.successfulWallets);
          }

          // МГНОВЕННО обновляем счетчик кошельков из ответа сервера
          if (result.results.newCounts && result.results.successful > 0) {
            setWalletCount(result.results.newCounts.totalWallets);
            
            // Обновляем информацию о группе
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

          // console.log(`✅ Ultra-optimized chunk ${i + 1} completed: ${result.results.successful} successful`);

        } catch (chunkError) {
          console.error(`❌ Ultra-optimized chunk ${i + 1} failed:`, chunkError.message);
          
          // Помечаем весь chunk как failed
          totalResults.failed += chunk.length;
          totalResults.errors.push({
            address: `chunk_${i + 1}`,
            error: `Entire chunk failed: ${chunkError.message}`,
            walletCount: chunk.length
          });
        }

        // Короткая пауза между chunks
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

      // console.log(`🎉 ULTRA-OPTIMIZED bulk import completed in ${duration}ms: ${totalResults.successful}/${totalResults.total} successful (${successRate}%, ${walletsPerSecond} wallets/sec)`);

      return {
        success: totalResults.successful > 0,
        message: `Ultra-optimized import: ${totalResults.successful} successful, ${totalResults.failed} failed (${successRate}% success rate, ${walletsPerSecond} wallets/sec)`,
        results: totalResults
      };

    } catch (error) {
      console.error('❌ Ultra-optimized bulk import failed:', error);
      throw new Error(`Ultra-optimized bulk import failed: ${error.message}`);
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
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-3"></div>
              <span className="text-blue-700">⚡ Ultra-fast loading optimized for 10,000+ wallets...</span>
            </div>
          </div>
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
                <option value="">All Groups ({walletCount.toLocaleString()} wallets)</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.wallet_count.toLocaleString()} wallets)
                  </option>
                ))}
              </select>
              {selectedGroupInfo && (
                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                  {selectedGroupInfo.groupName}: {selectedGroupInfo.walletCount.toLocaleString()} wallets
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
              walletCount={selectedGroupInfo ? selectedGroupInfo.walletCount : walletCount}
              groupName={selectedGroupInfo ? selectedGroupInfo.groupName : null}
              onRemoveAllWallets={removeAllWallets}
            />
          </div>
          <div className="lg:col-span-2">
            {view === 'tokens' && (
              <TokenTracker 
                groupId={selectedGroup} 
                transactions={transactions} 
                timeframe={timeframe} 
              />
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