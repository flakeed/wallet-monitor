import React, { useState, useEffect } from 'react';
import solPriceService from '../../../server/src/services/solPriceService';

function WalletPill({ wallet, tokenMint }) {
  const [tokenPrice, setTokenPrice] = useState(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [unrealizedPnL, setUnrealizedPnL] = useState(null);

  const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
  const pnlColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
  const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);
  
  // Получаем цену токена с DexScreener
  useEffect(() => {
    const fetchTokenPrice = async () => {
      if (!tokenMint || netAmount <= 0) return;
      
      setPriceLoading(true);
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
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
          
          // Рассчитываем нереализованный PnL используя актуальную цену SOL
          if (priceUSD > 0 && netAmount > 0) {
            const unrealizedPnLSOL = solPriceService.calculateUnrealizedPnL(
              netAmount, 
              priceUSD, 
              wallet.solSpent
            );
            setUnrealizedPnL(unrealizedPnLSOL);
          }
        }
      } catch (error) {
        console.error('Error fetching token price:', error);
      } finally {
        setPriceLoading(false);
      }
    };

    fetchTokenPrice();
  }, [tokenMint, netAmount, wallet.solSpent]);

  // Цвет для нереализованного PnL
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
        <div className="text-[10px] text-gray-500">
          {wallet.txBuys} buys · {wallet.txSells} sells
          {netAmount > 0 && (
            <span className="ml-1 text-blue-600">
              · {netAmount.toLocaleString()} tokens
            </span>
          )}
        </div>
        {tokenPrice && (
          <div className="text-[9px] text-gray-400">
            ${tokenPrice.toFixed(6)} per token
            {priceLoading && <span className="ml-1">⏳</span>}
          </div>
        )}
      </div>
      <div className="text-right ml-2">
        {/* Реализованный PnL */}
        <div className={`text-xs font-semibold ${pnlColor}`}>
          {wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL
        </div>
        
        {/* Нереализованный PnL */}
        {unrealizedPnL !== null && netAmount > 0 && (
          <div className={`text-[10px] font-medium ${unrealizedPnLColor}`}>
            Unreal: {unrealizedPnL > 0 ? '+' : ''}{unrealizedPnL.toFixed(4)} SOL
          </div>
        )}
        
        {/* Потрачено SOL */}
        <div className="text-[9px] text-gray-400">
          spent {wallet.solSpent.toFixed(4)} SOL
        </div>
        
        {/* Получено SOL */}
        {wallet.solReceived > 0 && (
          <div className="text-[9px] text-gray-400">
            recv {wallet.solReceived.toFixed(4)} SOL
          </div>
        )}
      </div>
    </div>
  );
}

export default WalletPill;