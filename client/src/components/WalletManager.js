import React, { useState, useCallback, useEffect } from 'react';

function WalletManager({ onAddWallet, onAddWalletsBulk, onCreateGroup, groups }) {
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [activeTab, setActiveTab] = useState('single');
  const [bulkText, setBulkText] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkValidation, setBulkValidation] = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, batch: 0 });

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    try {
      setLoading(true);
      await onCreateGroup(newGroupName.trim());
      setNewGroupName('');
      setMessage({ type: 'success', text: 'Group created successfully' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('Checking server health before bulk import...');
    const serverHealth = await checkServerHealth();
    
    if (!serverHealth) {
      setBulkResults({
        type: 'error',
        message: 'Server health check failed. Please try again later.'
      });
      return;
    }
  
    setBulkLoading(true);
    setShowProgress(true);
    setBulkResults(null);
    setImportProgress({ current: 0, total: wallets.length, batch: 0 });
      
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
      const result = await onAddWallet(address, name, groupId || null);
      if (result.success) {
        setMessage({ type: 'success', text: result.message });
        setImportProgress(progress);
        setAddress('');
        setName('');
        setGroupId('');
      }
    } catch (error) {
      console.error('Bulk import failed:', error);
      
      // Более детальное сообщение об ошибке
      let errorMessage = error.message;
      if (error.message.includes('HTML') || error.message.includes('DOCTYPE')) {
        errorMessage = 'Server returned an error page. This usually means the request was too large or took too long. Try importing fewer wallets at once.';
      } else if (error.message.includes('timeout')) {
        errorMessage = 'Request timed out. Try importing fewer wallets at once.';
      } else if (error.message.includes('JSON')) {
        errorMessage = 'Server response format error. Check server logs and try again.';
      }
      
      setBulkResults({
        type: 'error',
        message: `Bulk import failed: ${errorMessage}`
      });
    } finally {
      setLoading(false);
      setBulkLoading(false);
    setShowProgress(false);
    setImportProgress({ current: 0, total: 0, batch: 0 });
    }
  };

  const parseBulkInput = useCallback((text) => {
    const lines = text.trim().split('\n');
    const wallets = [];
    const errors = [];
    const seenAddresses = new Set();

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const trimmedLine = lines[i].trim();
      
      // Пропускаем комментарии и пустые строки
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      let address, name;
      
      // Парсим строку: адрес,имя или адрес\tимя или просто адрес
      if (trimmedLine.includes(',') || trimmedLine.includes('\t')) {
        const parts = trimmedLine.split(/[,\t]/).map(p => p.trim());
        address = parts[0];
        name = parts[1] || null;
      } else {
        address = trimmedLine;
        name = null;
      }

      // Валидация адреса
      if (!address) {
        errors.push(`Line ${lineNum}: Empty address`);
        continue;
      }

      if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
        errors.push(`Line ${lineNum}: Invalid address format - ${address.substring(0, 20)}...`);
        continue;
      }

      // Проверка дубликатов в пределах импорта
      if (seenAddresses.has(address)) {
        errors.push(`Line ${lineNum}: Duplicate address - ${address.substring(0, 20)}...`);
        continue;
      }

      seenAddresses.add(address);
      wallets.push({ address, name });
    }

    return { wallets, errors };
  }, []);

  const validateBulkText = useCallback(async (text) => {
    if (!text.trim()) {
      setBulkValidation(null);
      return;
    }

    const { wallets, errors } = parseBulkInput(text);
    
    setBulkValidation({
      totalLines: text.trim().split('\n').length,
      totalWallets: wallets.length,
      validWallets: wallets.length,
      errors: errors.length,
      canImport: wallets.length > 0 && wallets.length <= 10000,
      tooMany: wallets.length > 10000,
      errorMessages: errors.slice(0, 10) // Показываем только первые 10 ошибок
    });
  }, [parseBulkInput]);

  const handleBulkTextChange = (e) => {
    const newText = e.target.value;
    setBulkText(newText);
    
    // Debounce validation
    clearTimeout(window.bulkValidationTimeout);
    window.bulkValidationTimeout = setTimeout(() => {
      validateBulkText(newText);
    }, 300);
  };

  const handleBulkSubmit = async (e) => {
    e.preventDefault();
  
    if (!bulkText.trim()) {
      setBulkResults({ type: 'error', message: 'Please enter wallet addresses' });
      return;
    }
  
    const { wallets, errors: parseErrors } = parseBulkInput(bulkText);
  
    if (parseErrors.length > 0 && wallets.length === 0) {
      setBulkResults({
        type: 'error',
        message: `Found ${parseErrors.length} parsing errors and no valid wallets.`,
        details: {
          total: parseErrors.length,
          successful: 0,
          failed: parseErrors.length,
          errors: parseErrors.map(err => ({ address: 'parse_error', error: err }))
        }
      });
      return;
    }
  
    if (wallets.length === 0) {
      setBulkResults({
        type: 'error',
        message: 'No valid wallet addresses found.'
      });
      return;
    }
  
    if (wallets.length > 10000) {
      setBulkResults({
        type: 'error',
        message: 'Maximum 10,000 wallets allowed per bulk import.'
      });
      return;
    }
  
    setBulkLoading(true);
    setShowProgress(true);
    setBulkResults(null);
    setImportProgress({ current: 0, total: wallets.length, batch: 0 });
  
    try {
      console.log(`Starting bulk import of ${wallets.length} wallets...`);
      
      const result = await onAddWalletsBulk(wallets, groupId || null, (progress) => {
        setImportProgress(progress);
      });
  
      // Объединяем ошибки парсинга с ошибками импорта
      if (parseErrors.length > 0) {
        result.results.errors.unshift(...parseErrors.map(err => ({ address: 'parse_error', error: err })));
        result.results.failed += parseErrors.length;
      }
  
      setBulkResults({
        type: result.results.failed > 0 ? 'warning' : 'success',
        message: result.message,
        details: result.results
      });
  
      if (result.results.successful > 0) {
        setBulkText('');
        setGroupId('');
        setBulkValidation(null);
      }
  
    } catch (error) {
      console.error('Bulk import failed:', error);
      setBulkResults({
        type: 'error',
        message: `Bulk import failed: ${error.message}`
      });
    } finally {
      setBulkLoading(false);
      setShowProgress(false);
      setImportProgress({ current: 0, total: 0, batch: 0 });
    }
  };

  const clearBulkData = () => {
    setBulkText('');
    setBulkResults(null);
    setBulkValidation(null);
  };

  const downloadTemplate = () => {
    const template = `# Bulk Wallet Import Template (up to 10,000 wallets)
# Format: address,name (name is optional)
# One wallet per line
# Lines starting with # are ignored
# Maximum 10,000 wallets per import

# Example wallets (replace with real addresses):
9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Main Trading Wallet
53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC,Backup Wallet
Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y
7dHbWXmci3dT1DHaV2R7uHWdwKz7V8L2MvX9Gt8kVeHN,Test Environment

# Tips for large imports:
# - Remove duplicate addresses before importing
# - Use meaningful names for easier tracking
# - Consider grouping wallets by strategy or purpose
# - Monitor import progress in the UI`;

    const blob = new Blob([template], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bulk-wallet-import-template.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (window.bulkValidationTimeout) {
        clearTimeout(window.bulkValidationTimeout);
      }
    };
  }, []);

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">Add Wallets for Monitoring</h2>

      {/* Group Creation */}
      <div className="mb-6">
        <h3 className="text-lg font-medium text-gray-800 mb-2">Create New Group</h3>
        <form onSubmit={handleCreateGroup} className="flex space-x-2">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Enter new group name..."
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !newGroupName.trim()}
            className="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            Create Group
          </button>
        </form>
      </div>

      {/* Tabs */}
      <div className="flex space-x-1 mb-6 bg-gray-100 p-1 rounded-lg">
        <button
          onClick={() => setActiveTab('single')}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'single'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          Single Wallet
        </button>
        <button
          onClick={() => setActiveTab('bulk')}
          className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'bulk'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          Bulk Import (up to 10,000)
        </button>
      </div>

      {/* Single Wallet Tab */}
      {activeTab === 'single' && (
        <>
          {message && (
            <div className={`mb-4 p-3 rounded-lg ${
              message.type === 'success'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}>
              {message.text}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Wallet Address *
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value.trim())}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="Enter Solana wallet address (44 characters)"
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Name (Optional)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="Give this wallet a name..."
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Group (Optional)
              </label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                disabled={loading}
              >
                <option value="">Select a group (optional)</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.wallet_count} wallets)
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={loading || !address.trim()}
              className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Adding Wallet...
                </>
              ) : (
                'Add Wallet'
              )}
            </button>
          </form>
        </>
      )}

      {/* Bulk Import Tab */}
      {activeTab === 'bulk' && (
        <>
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex justify-between items-start mb-3">
              <h4 className="text-sm font-medium text-blue-900">Enhanced Bulk Import (up to 10,000 wallets):</h4>
              <button
                onClick={downloadTemplate}
                className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
              >
                Download Template
              </button>
            </div>
            <div className="text-sm text-blue-800 space-y-1">
              <p>• One wallet address per line</p>
              <p>• Optional: Add name after comma or tab: <code className="bg-blue-100 px-1 rounded">address,name</code></p>
              <p>• Lines starting with # are treated as comments and ignored</p>
              <p>• Duplicate addresses will be automatically detected and removed</p>
              <p>• Maximum 10,000 unique wallets per import</p>
              <p>• Large imports are processed in batches with progress tracking</p>
              <p className="font-medium">• Example:</p>
              <div className="mt-2 bg-blue-100 p-2 rounded font-mono text-xs">
                # Trading wallets for strategy A<br />
                9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Main Trading Wallet<br />
                53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC<br />
                Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y,Backup Wallet
              </div>
            </div>
          </div>

          {/* Validation Status */}
          {bulkValidation && (
            <div className={`mb-4 p-4 rounded-lg border ${
              bulkValidation.canImport 
                ? 'bg-green-50 border-green-200' 
                : bulkValidation.tooMany
                ? 'bg-red-50 border-red-200'
                : 'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-center justify-between mb-3">
                <h4 className={`text-sm font-medium ${
                  bulkValidation.canImport 
                    ? 'text-green-900' 
                    : bulkValidation.tooMany 
                    ? 'text-red-900'
                    : 'text-yellow-900'
                }`}>
                  Validation Results
                </h4>
                {bulkValidation.canImport && (
                  <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Ready to import</span>
                )}
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-3">
                <div className="text-center">
                  <div className="font-semibold text-lg text-gray-700">{bulkValidation.totalLines}</div>
                  <div className="text-gray-600">Total Lines</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold text-lg text-green-600">{bulkValidation.validWallets}</div>
                  <div className="text-gray-600">Valid Wallets</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold text-lg text-red-600">{bulkValidation.errors}</div>
                  <div className="text-gray-600">Errors</div>
                </div>
                <div className="text-center">
                  <div className="font-semibold text-lg text-blue-600">10,000</div>
                  <div className="text-gray-600">Max Allowed</div>
                </div>
              </div>

              {bulkValidation.tooMany && (
                <div className="text-red-700 font-medium">
                  ⚠️ Too many wallets! Found {bulkValidation.validWallets}, maximum 10,000 allowed. Please split your list.
                </div>
              )}

              {bulkValidation.errorMessages && bulkValidation.errorMessages.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-red-700 font-medium hover:text-red-800">
                    View Sample Errors ({bulkValidation.errors} total)
                  </summary>
                  <div className="mt-2 max-h-32 overflow-y-auto bg-red-100 p-2 rounded text-xs">
                    {bulkValidation.errorMessages.map((error, i) => (
                      <div key={i} className="text-red-800 py-1">
                        {error}
                      </div>
                    ))}
                    {bulkValidation.errors > 10 && (
                      <div className="text-red-600 text-center py-1 font-medium">
                        ... and {bulkValidation.errors - 10} more errors
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Progress Indicator */}
          {showProgress && bulkLoading && (
            <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center space-x-3 mb-3">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                <div>
                  <div className="font-medium text-blue-900">Processing bulk import...</div>
                  <div className="text-sm text-blue-700">
                    {importProgress.total > 0 ? (
                      `Processing batch ${importProgress.batch}, ${importProgress.current}/${importProgress.total} wallets`
                    ) : (
                      'Preparing import...'
                    )}
                  </div>
                </div>
              </div>
              
              {importProgress.total > 0 && (
                <div className="w-full bg-blue-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${Math.min((importProgress.current / importProgress.total) * 100, 100)}%` }}
                  ></div>
                </div>
              )}
            </div>
          )}

          {bulkResults && (
            <div className={`mb-4 p-4 rounded-lg border ${
              bulkResults.type === 'success'
                ? 'bg-green-50 border-green-200'
                : bulkResults.type === 'warning'
                ? 'bg-yellow-50 border-yellow-200'
                : 'bg-red-50 border-red-200'
            }`}>
              <div className={`font-medium mb-3 ${
                bulkResults.type === 'success' 
                  ? 'text-green-900' 
                  : bulkResults.type === 'warning'
                  ? 'text-yellow-900'
                  : 'text-red-900'
              }`}>
                {bulkResults.message}
              </div>

              {bulkResults.details && (
                <div className="text-sm space-y-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center p-3 bg-white rounded">
                      <div className="font-semibold text-xl text-gray-900">{bulkResults.details.total}</div>
                      <div className="text-gray-600">Total Processed</div>
                    </div>
                    <div className="text-center p-3 bg-white rounded">
                      <div className="font-semibold text-xl text-green-600">{bulkResults.details.successful}</div>
                      <div className="text-gray-600">Successful</div>
                    </div>
                    <div className="text-center p-3 bg-white rounded">
                      <div className="font-semibold text-xl text-red-600">{bulkResults.details.failed}</div>
                      <div className="text-gray-600">Failed</div>
                    </div>
                  </div>

                  {bulkResults.details.errors && bulkResults.details.errors.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-red-700 font-medium hover:text-red-800">
                        View Errors ({bulkResults.details.errors.length})
                      </summary>
                      <div className="mt-2 max-h-48 overflow-y-auto bg-red-100 p-3 rounded text-xs">
                        {bulkResults.details.errors.slice(0, 100).map((error, i) => (
                          <div key={i} className="text-red-800 py-1 border-b border-red-200 last:border-b-0">
                            <span className="font-mono">
                              {error.address && error.address !== 'parse_error' && error.address !== 'duplicate' 
                                ? `${error.address.slice(0, 12)}...` 
                                : 'Error'
                              }
                            </span>
                            {error.name && <span className="text-red-600"> ({error.name})</span>}
                            <span className="text-red-700 ml-2">{error.error}</span>
                          </div>
                        ))}
                        {bulkResults.details.errors.length > 100 && (
                          <div className="text-red-600 text-center py-2 font-medium">
                            ... and {bulkResults.details.errors.length - 100} more errors
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          <form onSubmit={handleBulkSubmit} className="space-y-4">
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Wallet Addresses * (up to 10,000)
                </label>
                <button
                  type="button"
                  onClick={clearBulkData}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Clear All
                </button>
              </div>
              <textarea
                value={bulkText}
                onChange={handleBulkTextChange}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors font-mono text-sm"
                placeholder="Paste wallet addresses here, one per line...

# You can add comments like this
9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Trading Wallet 1
53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC
Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y,Important Wallet
..."
                rows={14}
                disabled={bulkLoading}
              />
              <div className="mt-2 flex justify-between items-center text-sm">
                <div className="text-gray-500">
                  {bulkValidation ? (
                    <span className={bulkValidation.canImport ? 'text-green-600' : 'text-red-600'}>
                      {bulkValidation.validWallets} valid wallets detected
                      {bulkValidation.errors > 0 && `, ${bulkValidation.errors} errors`}
                    </span>
                  ) : bulkText.trim() ? (
                    <span className="text-blue-600">Validating...</span>
                  ) : (
                    'Enter wallet addresses to validate'
                  )}
                </div>
                <div className="text-xs text-gray-400">
                  Max: 10,000 wallets
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Group (Optional)
              </label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                disabled={bulkLoading}
              >
                <option value="">Select a group (optional)</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({group.wallet_count} wallets)
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              disabled={bulkLoading || !bulkText.trim() || (bulkValidation && !bulkValidation.canImport)}
              className="w-full bg-purple-600 text-white py-3 px-4 rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
            >
              {bulkLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Importing Wallets...
                </>
              ) : (
                bulkValidation && bulkValidation.validWallets > 0
                  ? `Import ${bulkValidation.validWallets.toLocaleString()} Wallets`
                  : 'Import Wallets'
              )}
            </button>

            {bulkValidation && bulkValidation.validWallets > 1000 && (
              <p className="text-xs text-gray-600 text-center">
                Large imports may take several minutes to complete. Please be patient.
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );
}

export default WalletManager