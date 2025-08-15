import React, { useState, useEffect } from 'react';

function WalletPill({ wallet, tokenMint }) {
  const [tokenPrice, setTokenPrice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [priceError, setPriceError] = useState(false);

  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const pnlColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
  const netTokenAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);

  // Функция для получения цены токена через DexScreener
  const fetchTokenPrice = async (mint) => {
    if (!mint || loading) return;
    
    setLoading(true);
    setPriceError(false);
    
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (!response.ok) throw new Error('Failed to fetch price');
      
      const data = await response.json();
      
      // Ищем пару с SOL (самую ликвидную)
      const solPair = data.pairs?.find(pair => 
        pair.baseToken.address === mint && 
        (pair.quoteToken.symbol === 'SOL' || pair.quoteToken.symbol === 'WSOL')
      );
      
      if (solPair && solPair.priceUsd) {
        // Конвертируем USD цену в SOL цену
        const solPriceUsd = 100; // Приблизительная цена SOL, можно сделать динамической
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
    if (tokenMint && netTokenAmount > 0) {
      fetchTokenPrice(tokenMint);
    }
  }, [tokenMint, netTokenAmount]);

  // Вычисляем нереализованный PnL
  const calculateUnrealizedPnL = () => {
    if (!tokenPrice || netTokenAmount <= 0) return 0;
    
    const currentValue = netTokenAmount * tokenPrice;
    const unrealizedPnL = currentValue - wallet.solSpent;
    return unrealizedPnL;
  };

  const unrealizedPnL = calculateUnrealizedPnL();
  const unrealizedPnLColor = unrealizedPnL > 0 ? 'text-green-600' : unrealizedPnL < 0 ? 'text-red-600' : 'text-gray-600';

  // Function to open token chart with wallet as maker in GMGN
  const openGmgnTokenWithMaker = () => {
    if (!tokenMint || !wallet.address) {
      console.warn('Missing token mint or wallet address');
      return;
    }
    const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
    window.open(gmgnUrl, '_blank');
  };

  // Function to copy wallet address to clipboard
  const copyToClipboard = () => {
    navigator.clipboard.writeText(wallet.address);
  };

  return (
    <div className="flex items-center justify-between border rounded-md px-2 py-1 bg-white">
      <div className="truncate max-w-xs">
        <div className="flex items-center space-x-2">
          <div className="text-xs font-medium text-gray-900 truncate">{label}</div>
          <button
            onClick={copyToClipboard}
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
          <button
            onClick={openGmgnTokenWithMaker}
            className="text-gray-400 hover:text-blue-600 p-0.5 rounded"
            title="Open token chart with this wallet as maker"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </button>
        </div>
        
        {/* Статистика транзакций */}
        <div className="text-[10px] text-gray-500">
          {wallet.txBuys} buys · {wallet.txSells} sells
        </div>
        
        {/* Количество токенов */}
        <div className="text-[10px] text-gray-600">
          {netTokenAmount > 0 && (
            <span>
              {netTokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens
            </span>
          )}
        </div>
      </div>
      
      <div className="text-right ml-2">
        {/* Реализованный PnL */}
        <div className={`text-xs font-semibold ${pnlColor}`}>
          {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
        </div>
        
        {/* Нереализованный PnL */}
        {netTokenAmount > 0 && (
          <div className={`text-[10px] ${unrealizedPnLColor}`}>
            {loading ? (
              <span className="text-gray-400">Loading...</span>
            ) : priceError ? (
              <span className="text-gray-400">No price</span>
            ) : tokenPrice ? (
              <span>
                Unrealized: {unrealizedPnL > 0 ? '+' : ''}{unrealizedPnL.toFixed(4)} SOL
              </span>
            ) : null}
          </div>
        )}
        
        {/* Потрачено и получено */}
        <div className="text-[9px] text-gray-400">
          spent {wallet.solSpent.toFixed(4)} · recv {wallet.solReceived.toFixed(4)}
        </div>
      </div>
    </div>
  );
}

export default WalletPill;