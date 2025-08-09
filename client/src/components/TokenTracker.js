import React, { useState, useEffect } from 'react';

function TokenTracker({ groupId }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState('24');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async (h = hours, gId = groupId) => {
    try {
      setLoading(true);
      const url = `${process.env.REACT_APP_API_BASE}/tokens/tracker?hours=${h}${gId ? `&groupId=${gId}` : ''}`;
      const trackerRes = await fetch(url);
      if (!trackerRes.ok) throw new Error('Failed to fetch data');
      const trackerData = await trackerRes.json();
      setItems(trackerData);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [groupId, hours]);

  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.location.href = gmgnUrl;
  };

  return (
    <div className="flex-1 bg-white rounded-lg shadow-sm border">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b bg-gray-50">
        <div className="flex items-center space-x-2">
          <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          <h3 className="text-lg font-semibold text-gray-900">Token Tracker</h3>
        </div>
        <select
          value={hours}
          onChange={(e) => { setHours(e.target.value); load(e.target.value, groupId); }}
          className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="1">Last 1 hour</option>
          <option value="6">Last 6 hours</option>
          <option value="24">Last 24 hours</option>
        </select>
      </div>

      {/* Content */}
      <div className="p-4 h-full overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="flex items-center space-x-2 text-gray-500">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-blue-500"></div>
              <span>Loading token data...</span>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-center">
              <svg className="w-12 h-12 text-red-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} 
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-red-600 font-medium">Error loading data</p>
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <div className="text-center">
              <svg className="w-12 h-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} 
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2-2V7a2 2 0 012-2h2a2 2 0 002 2v2a2 2 0 002 2h2a2 2 0 012-2V7a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 00-2 2h-2a2 2 0 00-2 2v6a2 2 0 01-2 2H9z" />
              </svg>
              <p className="text-gray-500 font-medium">No token data available</p>
              <p className="text-gray-400 text-sm">No tokens found for selected group/timeframe</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {items.map((token) => (
              <TokenCard key={token.mint} token={token} onOpenChart={() => openGmgnChart(token.mint)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenCard({ token, onOpenChart }) {
  const netColor = token.summary.netSOL > 0 ? 'text-green-600' : token.summary.netSOL < 0 ? 'text-red-600' : 'text-gray-600';
  const netBgColor = token.summary.netSOL > 0 ? 'bg-green-50 border-green-200' : token.summary.netSOL < 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200';

  return (
    <div className={`border-2 rounded-lg p-4 transition-all hover:shadow-md ${netBgColor}`}>
      {/* Token Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-3 mb-2">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-blue-100 text-blue-800">
              {token.symbol || 'UNKNOWN'}
            </span>
            <span className="text-gray-700 font-medium truncate">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="text-xs text-gray-500 font-mono bg-gray-100 px-2 py-1 rounded">
            {token.mint}
          </div>
        </div>
        <div className="text-right ml-4">
          <div className={`text-xl font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          <div className="text-sm text-gray-600 space-x-2">
            <span>{token.summary.uniqueWallets} wallets</span>
            <span>•</span>
            <span className="text-green-600">{token.summary.totalBuys} buys</span>
            <span>•</span>
            <span className="text-red-600">{token.summary.totalSells} sells</span>
          </div>
        </div>
      </div>

      {/* Wallets Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
        {token.wallets.map((w) => (
          <WalletPill key={w.address} wallet={w} />
        ))}
      </div>

      {/* Action Button */}
      <button
        onClick={onOpenChart}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors duration-200 flex items-center justify-center space-x-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        <span>Open Chart</span>
      </button>
    </div>
  );
}

function WalletPill({ wallet }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const pnlColor = wallet.pnlSol > 0 ? 'text-green-600 bg-green-50 border-green-200' : 
                   wallet.pnlSol < 0 ? 'text-red-600 bg-red-50 border-red-200' : 
                   'text-gray-600 bg-gray-50 border-gray-200';

  return (
    <div className={`border rounded-lg p-3 ${pnlColor} transition-all hover:shadow-sm`}>
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-gray-900 truncate mb-1">{label}</div>
          <div className="text-xs text-gray-600">
            <span className="text-green-600">{wallet.txBuys} buys</span>
            <span className="mx-1">•</span>
            <span className="text-red-600">{wallet.txSells} sells</span>
          </div>
        </div>
        <div className="text-right ml-3">
          <div className={`text-sm font-bold ${wallet.pnlSol > 0 ? 'text-green-600' : wallet.pnlSol < 0 ? 'text-red-600' : 'text-gray-600'}`}>
            {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
          </div>
          <div className="text-xs text-gray-500">
            <div>Spent: {wallet.solSpent.toFixed(2)}</div>
            <div>Recv: {wallet.solReceived.toFixed(2)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TokenTracker;
