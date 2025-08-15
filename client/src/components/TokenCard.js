import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
  const [tokenPrice, setTokenPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [priceError, setPriceError] = useState(false);

  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

  // Вычисляем общую статистику
  const totalTokensHeld = token.wallets.reduce((sum, wallet) => {
    const netTokens = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
    return sum + Math.max(0, netTokens); // Только положительные балансы
  }, 0);

  const totalSolSpentOnTokens = token.wallets.reduce((sum, wallet) => sum + wallet.solSpent, 0);

  // Функция для получения цены токена через DexScreener
  const fetchTokenPrice = async () => {
    if (!token.mint || loading) return;
    
    setLoading(true);
    setPriceError(false);
    
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`);
      if (!response.ok) throw new Error('Failed to fetch price');
      
      const data = await response.json();
      
      // Ищем пару с SOL (самую ликвидную)
      const solPair = data.pairs?.find(pair => 
        pair.baseToken.address === token.mint && 
        (pair.quoteToken.symbol === 'SOL' || pair.quoteToken.symbol === 'WSOL')
      );
      
      if (solPair && solPair.priceUsd) {
        // Конвертируем USD цену в SOL цену
        const solPriceUsd = 100; // Приблизительная цена SOL, можно получать динамически
        const tokenPriceInSol = parseFloat(solPair.priceUsd) / solPriceUsd;
        setTokenPrice(tokenPriceInSol);
      } else {
        setPriceError(true);
      }
    } catch (error) {
      console.error('Error fetching token price:', error);
      setPriceError(true);
    } finally {
      setLoading(false);
    }
  };

  // Загружаем цену при монтировании компонента
  useEffect(() => {
    if (totalTokensHeld > 0) {
      fetchTokenPrice();
    }
  }, [token.mint, totalTokensHeld]);

  // Вычисляем общий нереализованный PnL
  const calculateTotalUnrealizedPnL = () => {
    if (!tokenPrice || totalTokensHeld <= 0) return 0;
    
    const currentValue = totalTokensHeld * tokenPrice;
    const totalUnrealizedPnL = currentValue - totalSolSpentOnTokens;
    return totalUnrealizedPnL;
  };

  const totalUnrealizedPnL = calculateTotalUnrealizedPnL();
  const unrealizedPnLColor = totalUnrealizedPnL > 0 ? 'text-green-600' : totalUnrealizedPnL < 0 ? 'text-red-600' : 'text-gray-600';

  // Function to copy text to clipboard
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => {
        console.log('Address copied to clipboard:', text);
      })
      .catch((err) => {
        console.error('Failed to copy address:', err);
      });
  };

  // Function to open chart in new window
  const openGmgnChartInNewWindow = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
    window.open(gmgnUrl, '_blank');
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">{token.symbol || 'Unknown'}</span>
            <span className="text-gray-600 truncate">{token.name || 'Unknown Token'}</span>
          </div>
          <div className="flex items-center space-x-1">
            <div className="text-xs text-gray-500 font-mono truncate">{token.mint}</div>
            <button
              onClick={() => copyToClipboard(token.mint)}
              className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
              title="Copy address"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          </div>
          
          {/* Дополнительная статистика */}
          <div className="mt-2 space-y-1">
            {totalTokensHeld > 0 && (
              <div className="text-xs text-gray-600">
                <span className="font-medium">Total Tokens Held:</span> {totalTokensHeld.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            )}
            
            <div className="text-xs text-gray-600">
              <span className="font-medium">Total SOL Spent:</span> {totalSolSpentOnTokens.toFixed(4)} SOL
            </div>
            
            {/* Цена токена */}
            {loading ? (
              <div className="text-xs text-gray-500">Loading price...</div>
            ) : priceError ? (
              <div className="text-xs text-gray-500">Price unavailable</div>
            ) : tokenPrice ? (
              <div className="text-xs text-gray-600">
                <span className="font-medium">Price:</span> {tokenPrice.toFixed(8)} SOL per token
              </div>
            ) : null}
          </div>
        </div>
        
        <div className="text-right">
          {/* Реализованный PnL */}
          <div className={`text-base font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          
          {/* Нереализованный PnL */}
          {totalTokensHeld > 0 && tokenPrice && !loading && !priceError && (
            <div className={`text-sm font-semibold ${unrealizedPnLColor}`}>
              Unrealized: {totalUnrealizedPnL > 0 ? '+' : ''}{totalUnrealizedPnL.toFixed(4)} SOL
            </div>
          )}
          
          {/* Общий PnL (реализованный + нереализованный) */}
          {totalTokensHeld > 0 && tokenPrice && !loading && !priceError && (
            <div className={`text-sm font-bold ${(token.summary.netSOL + totalUnrealizedPnL) > 0 ? 'text-green-700' : 'text-red-700'}`}>
              Total: {(token.summary.netSOL + totalUnrealizedPnL) > 0 ? '+' : ''}{(token.summary.netSOL + totalUnrealizedPnL).toFixed(4)} SOL
            </div>
          )}
          
          <div className="text-xs text-gray-500 mt-1">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {token.wallets.map((w) => (
          <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
        ))}
      </div>
      
      <div className="mt-2 flex space-x-2">
        <button
          onClick={onOpenChart}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
        >
          Open Chart
        </button>
        <button
          onClick={openGmgnChartInNewWindow}
          className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
        >
          Open in New Window
        </button>
        
        {/* Кнопка обновления цены */}
        <button
          onClick={fetchTokenPrice}
          disabled={loading}
          className="px-3 py-2 bg-gray-600 text-white rounded hover:bg-gray-700 transition disabled:opacity-50"
          title="Refresh price"
        >
          {loading ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default TokenCard;