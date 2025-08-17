import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

// Список известных стейблкоинов
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJNm', // USDH
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC (old)
  'BXXkv6z8ykpG1yuvUDPgh732wzVHB69RnB9YgSYh3itW', // USDC (Wormhole)
]);

function TokenCard({ token, onOpenChart }) {
  const [priceData, setPriceData] = useState(null);
  const [solPrice, setSolPrice] = useState(null);
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [groupPnL, setGroupPnL] = useState(null);
  
  console.log("token", token);
  const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

  // Проверка, является ли токен стейблкоином
  const isStablecoin = (mint) => {
    return STABLECOIN_MINTS.has(mint);
  };

  // Fetch SOL price from multiple sources
  const fetchSolPrice = async () => {
    try {
      const sources = [
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
      ];

      for (const source of sources) {
        try {
          const response = await fetch(source);
          const data = await response.json();
          
          let price = null;
          if (source.includes('coingecko')) {
            price = data?.solana?.usd;
          } else if (source.includes('dexscreener')) {
            const bestPair = data.pairs?.reduce((prev, current) => 
              (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
            );
            price = parseFloat(bestPair?.priceUsd);
          }
          
          if (price && price > 0) {
            setSolPrice(price);
            console.log(`SOL price fetched: $${price.toFixed(2)}`);
            return;
          }
        } catch (error) {
          console.warn(`Failed to fetch from ${source}:`, error.message);
        }
      }
      
      // Fallback price
      setSolPrice(150);
    } catch (error) {
      console.error('Error fetching SOL price:', error);
      setSolPrice(150);
    }
  };

  // Fetch token price data from DexScreener
  const fetchTokenPrice = async () => {
    if (!token.mint || loadingPrice) return;
    
    setLoadingPrice(true);
    try {
      // Для стейблкоинов не нужно получать цену - они всегда ~$1
      if (isStablecoin(token.mint)) {
        setPriceData({
          price: 1.0, // Стейблкоин = $1
          change24h: 0,
          volume24h: 0,
          liquidity: 0,
          dexId: 'stablecoin',
          pairAddress: null,
          isStablecoin: true
        });
        setLoadingPrice(false);
        return;
      }

      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`);
      const data = await response.json();
      
      if (data.pairs && data.pairs.length > 0) {
        const bestPair = data.pairs.reduce((prev, current) => 
          (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
        );
        setPriceData({
          price: parseFloat(bestPair.priceUsd || 0),
          change24h: parseFloat(bestPair.priceChange?.h24 || 0),
          volume24h: parseFloat(bestPair.volume?.h24 || 0),
          liquidity: parseFloat(bestPair.liquidity?.usd || 0),
          dexId: bestPair.dexId,
          pairAddress: bestPair.pairAddress,
          isStablecoin: false
        });
      }
    } catch (error) {
      console.error('Error fetching token price:', error);
    } finally {
      setLoadingPrice(false);
    }
  };

  // Enhanced PnL calculation with stablecoin support
  const calculateGroupPnL = () => {
    if (!solPrice) return null;

    let totalTokensBought = 0;
    let totalTokensSold = 0;
    let totalSpentSOL = 0;
    let totalReceivedSOL = 0;

    // Sum up all wallet data
    token.wallets.forEach(wallet => {
      totalTokensBought += wallet.tokensBought || 0;
      totalTokensSold += wallet.tokensSold || 0;
      totalSpentSOL += wallet.solSpent || 0;
      totalReceivedSOL += wallet.solReceived || 0;
    });

    const currentHoldings = totalTokensBought - totalTokensSold;
    
    // Enhanced calculation for stablecoins and regular tokens
    let realizedPnLSOL, unrealizedPnLSOL, currentTokenValueUSD;
    
    if (isStablecoin(token.mint)) {
      // Случай 1: САМ ТОКЕН является стейблкоином (USDC, USDT и т.д.)
      // В этом случае 1 токен действительно ≈ $1
      const stablecoinValueUSD = currentHoldings; // 1:1 с USD для стейблкоинов
      currentTokenValueUSD = stablecoinValueUSD;
      
      // Реализованный PnL для стейблкоина
      realizedPnLSOL = totalReceivedSOL - (totalTokensSold > 0 && totalTokensBought > 0 ? 
        (totalTokensSold / totalTokensBought) * totalSpentSOL : 0);
      
      // Нереализованный PnL: текущая стоимость стейблкоинов в SOL минус cost basis
      const remainingCostBasisSOL = totalTokensBought > 0 ? 
        ((totalTokensBought - totalTokensSold) / totalTokensBought) * totalSpentSOL : 0;
      const stablecoinValueInSOL = stablecoinValueUSD / solPrice;
      unrealizedPnLSOL = stablecoinValueInSOL - remainingCostBasisSOL;
      
    } else if (priceData && priceData.price) {
      // Случай 2: ОБЫЧНЫЙ ТОКЕН (может быть куплен за SOL или стейблкоины)
      // Используем рыночную цену токена независимо от того, чем его купили
      currentTokenValueUSD = currentHoldings * priceData.price;
      
      // Реализованный PnL: разница между полученным SOL и потраченным SOL (пропорционально проданным токенам)
      realizedPnLSOL = totalReceivedSOL - (totalTokensSold > 0 && totalTokensBought > 0 ? 
        (totalTokensSold / totalTokensBought) * totalSpentSOL : 0);
      
      // Нереализованный PnL: текущая стоимость оставшихся токенов минус их cost basis в SOL
      const remainingCostBasisSOL = totalTokensBought > 0 ? 
        ((totalTokensBought - totalTokensSold) / totalTokensBought) * totalSpentSOL : 0;
      const remainingCostBasisUSD = remainingCostBasisSOL * solPrice;
      const unrealizedPnLUSD = currentTokenValueUSD - remainingCostBasisUSD;
      unrealizedPnLSOL = unrealizedPnLUSD / solPrice;
      
    } else {
      // Нет данных о цене
      return null;
    }
    
    // Общий PnL
    const realizedPnLUSD = realizedPnLSOL * solPrice;
    const unrealizedPnLUSD = unrealizedPnLSOL * solPrice;
    const totalPnLSOL = realizedPnLSOL + unrealizedPnLSOL;
    const totalPnLUSD = realizedPnLUSD + unrealizedPnLUSD;

    return {
      totalTokensBought,
      totalTokensSold,
      currentHoldings,
      totalSpentSOL,
      totalReceivedSOL,
      realizedPnLSOL,
      realizedPnLUSD,
      unrealizedPnLSOL,
      unrealizedPnLUSD,
      totalPnLSOL,
      totalPnLUSD,
      currentTokenValueUSD,
      remainingCostBasisUSD: (totalTokensBought > 0 ? 
        ((totalTokensBought - totalTokensSold) / totalTokensBought) * totalSpentSOL : 0) * solPrice,
      currentPriceUSD: isStablecoin(token.mint) ? 1.0 : (priceData?.price || 0),
      solPrice,
      isStablecoin: isStablecoin(token.mint)
    };
  };

  useEffect(() => {
    fetchSolPrice();
    fetchTokenPrice();
  }, [token.mint]);

  useEffect(() => {
    if ((priceData || isStablecoin(token.mint)) && solPrice) {
      setGroupPnL(calculateGroupPnL());
    }
  }, [priceData, solPrice, token.wallets]);

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
  const openDexScreenerChart = () => {
    if (!token.mint) {
      console.warn('No mint address available for chart');
      return;
    }
    const dexScreenerUrl = `https://dexscreener.com/solana/${token.mint}`;
    window.open(dexScreenerUrl, '_blank');
  };

  const formatNumber = (num, decimals = 2) => {
    if (num === null || num === undefined) return '0';
    if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
    if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
    return num.toFixed(decimals);
  };

  const formatCurrency = (num) => {
    if (num === null || num === undefined) return '$0';
    return `$${formatNumber(num)}`;
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <span className={`text-sm px-2 py-0.5 rounded-full font-semibold ${
              isStablecoin(token.mint) 
                ? 'bg-blue-200 text-blue-800' 
                : 'bg-gray-200 text-gray-800'
            }`}>
              {token.symbol || 'Unknown'}
              {isStablecoin(token.mint) && <span className="ml-1 text-xs">💵</span>}
            </span>
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
        </div>
        <div className="text-right">
          <div className={`text-base font-bold ${netColor}`}>
            {token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
          </div>
          <div className="text-xs text-gray-500">
            {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
            {isStablecoin(token.mint) && <span className="ml-1 text-blue-600">STABLE</span>}
          </div>
        </div>
      </div>

      {/* Enhanced Group PnL Summary with stablecoin support */}
      {groupPnL && (
        <div className={`mb-3 p-3 rounded-lg border ${
          groupPnL.isStablecoin 
            ? 'bg-blue-50 border-blue-200' 
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">Holdings:</span>
                <span className="font-medium">{formatNumber(groupPnL.currentHoldings, 0)} tokens</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Total Spent:</span>
                <span className="font-medium">{formatNumber(groupPnL.totalSpentSOL, 4)} SOL</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Total Received:</span>
                <span className="font-medium">{formatNumber(groupPnL.totalReceivedSOL, 4)} SOL</span>
              </div>
              {groupPnL.isStablecoin && (
                <div className="flex justify-between">
                  <span className="text-blue-600 text-xs">Current Value:</span>
                  <span className="font-medium text-blue-700">
                    {formatCurrency(groupPnL.currentTokenValueUSD)}
                  </span>
                </div>
              )}
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">Realized PnL:</span>
                <div className="text-right">
                  <div className={`font-medium ${groupPnL.realizedPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {groupPnL.realizedPnLSOL >= 0 ? '+' : ''}{groupPnL.realizedPnLSOL.toFixed(4)} SOL
                  </div>
                  <div className={`text-xs ${groupPnL.realizedPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(groupPnL.realizedPnLUSD)}
                  </div>
                </div>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Unrealized PnL:</span>
                <div className="text-right">
                  <div className={`font-medium ${groupPnL.unrealizedPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {groupPnL.unrealizedPnLSOL >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSOL.toFixed(4)} SOL
                  </div>
                  <div className={`text-xs ${groupPnL.unrealizedPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(groupPnL.unrealizedPnLUSD)}
                  </div>
                </div>
              </div>
              <div className={`flex justify-between border-t pt-1 ${
                groupPnL.isStablecoin ? 'border-blue-300' : 'border-gray-300'
              }`}>
                <span className="text-gray-600 font-medium">Total PnL:</span>
                <div className="text-right">
                  <div className={`font-bold ${groupPnL.totalPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {groupPnL.totalPnLSOL >= 0 ? '+' : ''}{groupPnL.totalPnLSOL.toFixed(4)} SOL
                  </div>
                  <div className={`text-xs ${groupPnL.totalPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatCurrency(groupPnL.totalPnLUSD)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Additional info for different token types */}
          {groupPnL.isStablecoin ? (
            <div className="mt-2 text-xs text-blue-600 border-t border-blue-200 pt-2">
              <div className="flex justify-between items-center">
                <span>Stablecoin (≈$1.00)</span>
                <span>SOL Price: {formatCurrency(groupPnL.solPrice)}</span>
              </div>
            </div>
          ) : priceData && (
            <div className="mt-2 text-xs text-gray-600 border-t border-gray-200 pt-2">
              <div className="flex justify-between items-center">
                <span>Current Price: {formatCurrency(priceData.price)}</span>
                <span>24h Vol: {formatCurrency(priceData.volume24h)}</span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span>Liquidity: {formatCurrency(priceData.liquidity)}</span>
                <span className={`${priceData.change24h >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  24h: {priceData.change24h >= 0 ? '+' : ''}{priceData.change24h.toFixed(2)}%
                </span>
              </div>
            </div>
          )}
        </div>
      )}

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
        {!isStablecoin(token.mint) && (
          <button
            onClick={openDexScreenerChart}
            className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition"
          >
            DexScreener
          </button>
        )}
        {isStablecoin(token.mint) && (
          <button
            disabled
            className="flex-1 bg-gray-400 text-white py-2 rounded cursor-not-allowed"
            title="Stablecoin - no chart needed"
          >
            Stablecoin
          </button>
        )}
      </div>
    </div>
  );
}

export default TokenCard;