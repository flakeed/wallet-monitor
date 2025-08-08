import React, { useState, useEffect } from 'react';

function TokenTracker() {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState('24');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedToken, setSelectedToken] = useState(null);
  const [isChartOpen, setIsChartOpen] = useState(false);

  const load = async (h = hours) => {
    try {
      setLoading(true);
      const trackerRes = await fetch(`${process.env.REACT_APP_API_BASE}/tokens/tracker?hours=${h}`);
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
  }, []);

  // Открытие модального окна с графиком
  const openChart = (mintAddress) => {
    setSelectedToken(mintAddress);
    setIsChartOpen(true);
  };

  // Закрытие модального окна
  const closeChart = () => {
    setIsChartOpen(false);
    setSelectedToken(null);
  };

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
        <div>
          {items.map((token) => (
            <div key={token.mint} className="mb-4">
              <TokenCard token={token} onOpenChart={() => openChart(token.mint)} />
            </div>
          ))}
        </div>
      )}

      {/* Модальное окно с графиком */}
      {isChartOpen && selectedToken && (
  <div
    className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    onClick={closeChart}
  >
    <div
      className="bg-white p-4 rounded-lg w-full max-w-4xl max-h-[90vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-4">
        <h4 className="text-lg font-medium">
          Chart for {items.find(t => t.mint === selectedToken)?.symbol || selectedToken}
        </h4>
        <button
          onClick={closeChart}
          className="text-red-600 hover:text-red-800 font-bold text-xl"
        >
          &times;
        </button>
      </div>

      {/* Попытка встраивания графика */}
      <iframe
        src={`https://gmgn.ai/sol/token/${encodeURIComponent(selectedToken)}`}
        title="Token Chart"
        width="100%"
        height="600"
        frameBorder="0"
        style={{ border: '1px solid #ddd' }}
        onError={(e) => {
          e.target.style.display = 'none';
          document.getElementById('chart-fallback').style.display = 'block';
        }}
      />

      {/* Фолбэк, если iframe не загрузился */}
      <div
        id="chart-fallback"
        style={{ display: 'none' }}
        className="text-center p-6 text-gray-600"
      >
        <p>Не удалось загрузить график внутри приложения.</p>
        <a
          href={`https://gmgn.ai/sol/token/${encodeURIComponent(selectedToken)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-block bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Открыть график в новой вкладке
        </a>
      </div>
    </div>
  </div>
)}
    </div>
  );
}

// Обновленный TokenCard с кнопкой для открытия графика
function TokenCard({ token, onOpenChart }) {
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
      <button
        onClick={onOpenChart}
        className="mt-2 w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
      >
        Open Chart
      </button>
    </div>
  );
}

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

export default TokenTracker;