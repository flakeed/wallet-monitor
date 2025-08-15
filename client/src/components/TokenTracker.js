// client/src/components/TokenTracker.js
import React, { useState, useEffect, useRef } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [totalStats, setTotalStats] = useState({
    totalSpentSOL: 0,
    totalReceivedSOL: 0,
    totalRealizedPnL: 0,
    totalUnrealizedPnL: 0,
    totalCurrentValue: 0,
    totalPnL: 0,
    netSOL: 0
  });

  // Refs для предотвращения дергания
  const containerRef = useRef(null);
  const statsRef = useRef(null);
  const contentRef = useRef(null);
  const lastDataRef = useRef(null);

  // Функция для получения текущих цен токенов через DexScreener API
  const fetchTokenPrices = async (mints) => {
    try {
      const prices = new Map();
      const BATCH_SIZE = 30;
      const mintArray = Array.from(mints);
      
      if (mintArray.length === 0) return prices;
      
      // Получаем цену SOL в USD от DexScreener
      let solPriceUsd = 150;
      try {
        const solResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        const solData = await solResponse.json();
        if (solData.pairs && solData.pairs.length > 0) {
          solPriceUsd = parseFloat(solData.pairs[0].priceUsd) || 150;
        }
      } catch (error) {
        console.warn('Failed to fetch SOL price, using fallback:', error.message);
      }
      
      // Обрабатываем токены пакетами
      for (let i = 0; i < mintArray.length; i += BATCH_SIZE) {
        const batch = mintArray.slice(i, i + BATCH_SIZE);
        const mintList = batch.join(',');
        
        try {
          const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintList}`, {
            headers: {
              'User-Agent': 'WalletMonitor/1.0'
            }
          });
          
          if (!response.ok) {
            console.warn(`DexScreener API returned ${response.status} for batch`);
            continue;
          }
          
          const data = await response.json();
          
          if (data.pairs) {
            const tokenPairs = new Map();
            
            data.pairs.forEach(pair => {
              if (!pair.baseToken || !pair.priceUsd) return;
              
              const mint = pair.baseToken.address;
              if (!batch.includes(mint)) return;
              
              const currentPair = tokenPairs.get(mint);
              const liquidity = parseFloat(pair.liquidity?.usd || 0);
              const volume24h = parseFloat(pair.volume?.h24 || 0);
              const pairScore = liquidity + volume24h;
              
              if (!currentPair || (currentPair.score < pairScore)) {
                tokenPairs.set(mint, {
                  price: parseFloat(pair.priceUsd) / solPriceUsd,
                  priceUsd: parseFloat(pair.priceUsd),
                  liquidity: liquidity,
                  volume24h: volume24h,
                  score: pairScore,
                  dexId: pair.dexId
                });
              }
            });
            
            tokenPairs.forEach((pairData, mint) => {
              prices.set(mint, pairData.price);
            });
          }
          
          if (i + BATCH_SIZE < mintArray.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error) {
          console.error(`Error fetching prices for batch starting at ${i}:`, error.message);
          continue;
        }
      }
      
      return prices;
    } catch (error) {
      console.error('Error fetching token prices from DexScreener:', error);
      return new Map();
    }
  };

  // Функция для агрегации данных о токенах из транзакций с unrealized PnL
  const aggregateTokens = async (transactions, hours, groupId) => {
    // Если нет транзакций, возвращаем пустой массив но сохраняем структуру
    if (!transactions || transactions.length === 0) {
      return [];
    }

    const byToken = new Map();
    const now = new Date();
    
    // Фильтруем транзакции
    const filteredTransactions = transactions.filter((tx) => {
      const txTime = new Date(tx.time);
      const hoursDiff = (now - txTime) / (1000 * 60 * 60);
      const matchesTimeframe = hoursDiff <= parseInt(hours);
      const matchesGroup = !groupId || tx.wallet.group_id === groupId;
      return matchesTimeframe && matchesGroup;
    });

    // Агрегируем данные по токенам
    filteredTransactions.forEach((tx) => {
      const tokens = tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold;
      if (!tokens || tokens.length === 0) return;

      tokens.forEach((token) => {
        if (!byToken.has(token.mint)) {
          byToken.set(token.mint, {
            mint: token.mint,
            symbol: token.symbol || 'Unknown',
            name: token.name || 'Unknown Token',
            decimals: token.decimals || 6,
            wallets: [],
            summary: {
              uniqueWallets: new Set(),
              totalBuys: 0,
              totalSells: 0,
              totalSpentSOL: 0,
              totalReceivedSOL: 0,
              netSOL: 0,
              totalTokensBought: 0,
              totalTokensSold: 0,
              totalTokensHeld: 0,
              currentPrice: 0,
              unrealizedPnL: 0,
            },
          });
        }

        const tokenData = byToken.get(token.mint);
        const walletAddress = tx.wallet.address;
        const wallet = tokenData.wallets.find((w) => w.address === walletAddress);

        if (!wallet) {
          const newWallet = {
            address: walletAddress,
            name: tx.wallet.name || null,
            groupId: tx.wallet.group_id,
            groupName: tx.wallet.group_name,
            txBuys: tx.transactionType === 'buy' ? 1 : 0,
            txSells: tx.transactionType === 'sell' ? 1 : 0,
            solSpent: tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0,
            solReceived: tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0,
            tokensBought: tx.transactionType === 'buy' ? token.amount || 0 : 0,
            tokensSold: tx.transactionType === 'sell' ? token.amount || 0 : 0,
            tokensHeld: 0,
            avgBuyPrice: 0,
            unrealizedPnL: 0,
            realizedPnL: 0,
            totalPnL: 0,
            lastActivity: tx.time,
          };
          
          tokenData.wallets.push(newWallet);
          tokenData.summary.uniqueWallets.add(walletAddress);
        } else {
          wallet.txBuys += tx.transactionType === 'buy' ? 1 : 0;
          wallet.txSells += tx.transactionType === 'sell' ? 1 : 0;
          wallet.solSpent += tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0;
          wallet.solReceived += tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0;
          wallet.tokensBought += tx.transactionType === 'buy' ? token.amount || 0 : 0;
          wallet.tokensSold += tx.transactionType === 'sell' ? token.amount || 0 : 0;
          wallet.lastActivity = tx.time > wallet.lastActivity ? tx.time : wallet.lastActivity;
        }

        tokenData.summary.totalBuys += tx.transactionType === 'buy' ? 1 : 0;
        tokenData.summary.totalSells += tx.transactionType === 'sell' ? 1 : 0;
        tokenData.summary.totalSpentSOL += tx.transactionType === 'buy' ? parseFloat(tx.solSpent) || 0 : 0;
        tokenData.summary.totalReceivedSOL += tx.transactionType === 'sell' ? parseFloat(tx.solReceived) || 0 : 0;
        tokenData.summary.totalTokensBought += tx.transactionType === 'buy' ? token.amount || 0 : 0;
        tokenData.summary.totalTokensSold += tx.transactionType === 'sell' ? token.amount || 0 : 0;
      });
    });

    if (byToken.size === 0) {
      return [];
    }

    // Получаем текущие цены токенов
    const mints = new Set(byToken.keys());
    const prices = await fetchTokenPrices(mints);

    // Вычисляем PnL для каждого кошелька и токена
    const result = Array.from(byToken.values()).map((t) => {
      const currentPrice = prices.get(t.mint) || 0;
      
      t.wallets.forEach((wallet) => {
        wallet.tokensHeld = wallet.tokensBought - wallet.tokensSold;
        
        if (wallet.tokensBought > 0) {
          wallet.avgBuyPrice = wallet.solSpent / wallet.tokensBought;
        }
        
        if (wallet.tokensSold > 0 && wallet.tokensBought > 0) {
          const avgBuyPriceForSold = wallet.solSpent / wallet.tokensBought;
          const costOfSoldTokens = wallet.tokensSold * avgBuyPriceForSold;
          wallet.realizedPnL = wallet.solReceived - costOfSoldTokens;
        }
        
        if (wallet.tokensHeld > 0 && currentPrice > 0) {
          const currentValueSOL = wallet.tokensHeld * currentPrice;
          const costOfHeldTokens = wallet.tokensHeld * wallet.avgBuyPrice;
          wallet.unrealizedPnL = currentValueSOL - costOfHeldTokens;
        }
        
        wallet.totalPnL = wallet.realizedPnL + wallet.unrealizedPnL;
      });

      const summary = {
        ...t.summary,
        uniqueWallets: t.summary.uniqueWallets.size,
        netSOL: +(t.summary.totalReceivedSOL - t.summary.totalSpentSOL).toFixed(6),
        totalTokensHeld: t.wallets.reduce((sum, w) => sum + w.tokensHeld, 0),
        currentPrice: currentPrice,
        totalCostBasis: t.summary.totalSpentSOL,
        currentValue: currentPrice > 0 ? t.wallets.reduce((sum, w) => sum + (w.tokensHeld * currentPrice), 0) : 0,
        totalRealizedPnL: t.wallets.reduce((sum, w) => sum + w.realizedPnL, 0),
        totalUnrealizedPnL: t.wallets.reduce((sum, w) => sum + w.unrealizedPnL, 0),
      };
      
      summary.totalPnL = summary.totalRealizedPnL + summary.totalUnrealizedPnL;

      return { ...t, summary };
    });

    result.sort((a, b) => Math.abs(b.summary.totalPnL) - Math.abs(a.summary.totalPnL));
    return result;
  };

  // Обновляем данные с плавным transition
  const updateData = async () => {
    if (!transactions || transactions.length === 0) {
      // Если нет транзакций, показываем пустое состояние без загрузки
      setItems([]);
      setTotalStats({
        totalSpentSOL: 0,
        totalReceivedSOL: 0,
        totalRealizedPnL: 0,
        totalUnrealizedPnL: 0,
        totalCurrentValue: 0,
        totalPnL: 0,
        netSOL: 0
      });
      setError(null);
      return;
    }

    // Сохраняем текущую высоту контейнера
    if (containerRef.current) {
      const currentHeight = containerRef.current.offsetHeight;
      containerRef.current.style.minHeight = `${currentHeight}px`;
    }

    setLoading(true);
    
    try {
      const aggregatedTokens = await aggregateTokens(transactions, hours, groupId);
      
      // Вычисляем общую статистику
      const newTotalStats = aggregatedTokens.reduce((acc, token) => {
        acc.totalSpentSOL += token.summary.totalSpentSOL;
        acc.totalReceivedSOL += token.summary.totalReceivedSOL;
        acc.totalRealizedPnL += token.summary.totalRealizedPnL;
        acc.totalUnrealizedPnL += token.summary.totalUnrealizedPnL;
        acc.totalCurrentValue += token.summary.currentValue;
        return acc;
      }, {
        totalSpentSOL: 0,
        totalReceivedSOL: 0,
        totalRealizedPnL: 0,
        totalUnrealizedPnL: 0,
        totalCurrentValue: 0,
      });

      newTotalStats.totalPnL = newTotalStats.totalRealizedPnL + newTotalStats.totalUnrealizedPnL;
      newTotalStats.netSOL = newTotalStats.totalReceivedSOL - newTotalStats.totalSpentSOL;

      // Обновляем состояние
      setItems(aggregatedTokens);
      setTotalStats(newTotalStats);
      setError(null);
      lastDataRef.current = { aggregatedTokens, newTotalStats };
      
    } catch (e) {
      console.error('Error aggregating tokens:', e);
      setError(e.message);
      
      // В случае ошибки, используем последние успешные данные если есть
      if (lastDataRef.current) {
        setItems(lastDataRef.current.aggregatedTokens);
        setTotalStats(lastDataRef.current.newTotalStats);
      }
    } finally {
      setLoading(false);
      
      // Убираем фиксированную высоту после обновления
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.style.minHeight = 'auto';
        }
      }, 150);
    }
  };

  // Обновляем данные при изменении зависимостей
  useEffect(() => {
    updateData();
  }, [transactions, hours, groupId]);

  // Синхронизируем hours с timeframe из пропсов
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
    <div ref={containerRef} className="bg-white rounded-lg shadow-sm border p-6 transition-all duration-150">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">Token Tracker</h3>
        <select
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="text-sm border border-gray-300 rounded px-2 py-1"
          disabled={loading}
        >
          <option value="1">Last 1 hour</option>
          <option value="6">Last 6 hours</option>
          <option value="24">Last 24 hours</option>
        </select>
      </div>

      {/* Общая статистика - фиксированная высота */}
      {(items.length > 0 || totalStats.totalSpentSOL > 0) && (
        <div 
          ref={statsRef}
          className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-gray-50 rounded-lg transition-opacity duration-150"
          style={{ minHeight: '88px' }}
        >
          <div className="text-center">
            <div className="text-sm text-gray-600">Total Spent</div>
            <div className="text-lg font-semibold text-red-600">
              {totalStats.totalSpentSOL.toFixed(4)} SOL
            </div>
          </div>
          {/* <div className="text-center">
            <div className="text-sm text-gray-600">Current Value</div>
            <div className="text-lg font-semibold text-blue-600">
              {totalStats.totalCurrentValue.toFixed(4)} SOL
            </div>
          </div> */}
          <div className="text-center">
            <div className="text-sm text-gray-600">Realized PnL</div>
            <div className={`text-lg font-semibold ${totalStats.totalRealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {totalStats.totalRealizedPnL >= 0 ? '+' : ''}{totalStats.totalRealizedPnL.toFixed(4)} SOL
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm text-gray-600">Unrealized PnL</div>
            <div className={`text-lg font-semibold ${totalStats.totalUnrealizedPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {totalStats.totalUnrealizedPnL >= 0 ? '+' : ''}{totalStats.totalUnrealizedPnL.toFixed(4)} SOL
            </div>
          </div>
        </div>
      )}

      {/* Контент с фиксированным состоянием загрузки */}
      <div ref={contentRef} className="relative">
        {loading && (
          <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10 rounded">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              <span className="text-gray-600">Updating prices...</span>
            </div>
          </div>
        )}
        
        {error && !loading && (
          <div className="text-red-600 text-center py-4">{error}</div>
        )}
        
        {!loading && !error && items.length === 0 && transactions.length === 0 && (
          <div className="text-gray-500 text-center py-8">No transactions found for selected group/timeframe</div>
        )}
        
        {!loading && !error && items.length === 0 && transactions.length > 0 && (
          <div className="text-gray-500 text-center py-8">No token data for selected group/timeframe</div>
        )}
        
        {items.length > 0 && (
          <div className="space-y-4">
            {items.map((token) => (
              <TokenCard 
                key={token.mint} 
                token={token} 
                onOpenChart={() => openGmgnChart(token.mint)} 
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default TokenTracker;