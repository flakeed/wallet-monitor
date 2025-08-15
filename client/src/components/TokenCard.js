import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';
import solPriceService from '../../../server/src/services/solPriceService';

function TokenCard({ token, onOpenChart }) {
  const [tokenPrice, setTokenPrice] = useState(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [totalUnrealizedPnL, setTotalUnrealizedPnL] = useState(null);
  const [totalTokensHeld, setTotalTokensHeld] = useState(0);

  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

  // Рассчитываем общее количество токенов
  useEffect(() => {
    const totalTokens = token.wallets.reduce((sum, wallet) => {
      const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
      return sum + Math.max(0, netAmount);
    }, 0);
    setTotalTokensHeld(totalTokens);
  }, [token.wallets]);

  // Получаем цену токена с DexScreener
  useEffect(() => {
    const fetchTokenPrice = async () => {
      if (!token.mint) return;
      
      setPriceLoading(true);
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`);
        const data = await response.json();
        
        if (data.pairs && data.pairs.length > 0) {
          // Берем пару с наибольшей ликвидностью
          const bestPair = data.pairs.reduce((best, current) => {
            const bestLiquidity = parseFloat(best.liquidity?.usd || 0);
            const currentLiquidity = parseFloat(current.liquidity?.usd || 0);
            return currentLiquidity > bestLiquidity ? current : best;
          });
          
          const priceUSD = parseFloat(bestPair.priceUsd || 0);
          setTokenPrice(priceUSD);
          
          // Рассчитываем общий нереализованный PnL используя актуальную цену SOL
          if (priceUSD > 0) {
            let totalUnrealized = 0;
            
            token.wallets.forEach(wallet => {
              const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
              if (netAmount > 0) {
                const unrealizedPnL = solPriceService.calculateUnrealizedPnL(
                  netAmount, 
                  priceUSD, 
                  wallet.solSpent
                );
                totalUnrealized += unrealizedPnL;
              }
            });
            
            setTotalUnrealizedPnL(totalUnrealized);
          }
        }
      } catch (error) {
        console.error('Error fetching token price:', error);
      } finally {
        setPriceLoading(false);
      }
    };

    fetchTokenPrice();
  }, [token.mint, token.wallets]);

  // Цвет для нереализованного PnL
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
            {tokenPrice && (
              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                ${tokenPrice.toFixed(6)}
                {priceLoading && <span className="ml-1">⏳</span>}
              </span>
            )}
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
        </div>
        <div className="text-right">
          {/* Реализованный PnL */}
          <div className={`text-base font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          
          {/* Нереализованный PnL */}
          {totalUnrealizedPnL !== null && (
            <div className={`text-sm font-semibold ${unrealizedPnLColor}`}>
              Unreal: {totalUnrealizedPnL > 0 ? '+' : ''}{totalUnrealizedPnL.toFixed(4)} SOL
            </div>
          )}
          
          <div className="text-xs text-gray-500">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
          </div>
          
          {/* Общее количество токенов */}
          {totalTokensHeld > 0 && (
            <div className="text-xs text-blue-600 font-medium">
              {totalTokensHeld.toLocaleString()} tokens held
            </div>
          )}
          
          {/* Общая сумма потраченных SOL */}
          <div className="text-xs text-gray-400">
            Total spent: {token.summary.totalSpentSOL.toFixed(4)} SOL
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
      </div>
    </div>
  );
}

export default TokenCard;