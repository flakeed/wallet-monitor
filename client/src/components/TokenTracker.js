import React, { useEffect, useState } from 'react';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://127.0.0.1:5001/api';

function WalletPill({ wallet }) {
  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const pnlColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
  const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
  let action = null;
  if (wallet.txSells > 0) {
    action = netAmount > 0 ? 'Sell part' : 'Sell all';
  } else if (wallet.txBuys > 0) {
    action = 'New holder';
  }
  return (
    <div className="flex items-center justify-between border rounded-md px-3 py-2 bg-white">
      <div className="truncate max-w-xs">
        <div className="text-sm font-medium text-gray-900 truncate">{label}</div>
        <div className="text-xs text-gray-500">{wallet.txBuys} buys · {wallet.txSells} sells{action ? ` · ${action}` : ''}</div>
      </div>
      <div className="text-right ml-3">
        <div className={`text-sm font-semibold ${pnlColor}`}>{wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL</div>
        <div className="text-[10px] text-gray-400">spent {wallet.solSpent.toFixed(4)} · recv {wallet.solReceived.toFixed(4)}</div>
      </div>
    </div>
  );
}

function TokenCard({ token }) {
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';
  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">{token.symbol || 'Unknown'}</span>
            <span className="text-gray-600 truncate">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="text-xs text-gray-500">{token.mint}</div>
        </div>
        <div className="text-right">
          <div className={`text-base font-bold ${netColor}`}>{token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL</div>
          <div className="text-xs text-gray-500">{token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells</div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {token.wallets.map((w) => (
          <WalletPill key={w.address} wallet={w} />
        ))}
      </div>
    </div>
  );
}

export default function TokenTracker() {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState('24');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async (h = hours) => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/tokens/tracker?hours=${h}`);
      if (!res.ok) throw new Error('Failed to fetch token tracker');
      let data = await res.json();
      // Sort tokens by number of wallets desc, then by net SOL desc
      data = data
        .map(t => ({
          ...t,
          wallets: [...t.wallets].sort((a,b) => (b.pnlSol - a.pnlSol))
        }))
        .sort((a,b) => (b.summary.uniqueWallets - a.summary.uniqueWallets) || (b.summary.netSOL - a.summary.netSOL));
      setItems(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        <select
          value={hours}
          onChange={(e) => { setHours(e.target.value); load(e.target.value); }}
          className="text-sm border border-gray-300 rounded px-2 py-1"
        >
          <option value="1">Last 1 hour</option>
          <option value="6">Last 6 hours</option>
          <option value="24">Last 24 hours</option>
          <option value="168">Last 7 days</option>
        </select>
      </div>
      {loading ? (
        <div className="text-gray-500">Loading...</div>
      ) : error ? (
        <div className="text-red-600">{error}</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500">No data</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {items.map((t) => (
            <TokenCard key={t.mint} token={t} />
          ))}
        </div>
      )}
    </div>
  );
}


