import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/tokens/tracker?hours=${hours}${groupId ? `&groupId=${groupId}` : ''}`)
      .then((response) => response.json())
      .then((data) => {
        setItems(data);
        setError(null);
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [hours, groupId]);

  useEffect(() => {
    setHours(timeframe);
  }, [timeframe]);

  const openGmgnChart = (mintAddress) => {
    if (!mintAddress) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(mintAddress)}`;
    window.location.href = gmgnUrl;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        <select
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="text-sm border border-gray-300 rounded px-2 py-1"
        >
          <option value="1">Last 1 hour</option>
          <option value="6">Last 6 hours</option>
          <option value="24">Last 24 hours</option>
        </select>
      </div>
      {loading ? (
        <div className="text-gray-500">Loading...</div>
      ) : error ? (
        <div className="text-red-600">{error}</div>
      ) : items.length === 0 ? (
        <div className="text-gray-500">No token data for selected group/timeframe</div>
      ) : (
        <div>
          {items.map((token) => (
            <div key={token.mint} className="mb-4">
              <TokenCard token={token} onOpenChart={() => openGmgnChart(token.mint)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;