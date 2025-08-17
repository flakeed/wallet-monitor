// Обновленный client/src/components/TokenTracker.js

import React, { useState, useEffect } from 'react';
import TokenCard from './TokenCard';

function TokenTracker({ groupId, transactions, timeframe }) {
  const [items, setItems] = useState([]);
  const [hours, setHours] = useState(timeframe || '24');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Функция для агрегации данных о токенах из транзакций с поддержкой стейблкоинов
  const aggregateTokens = (transactions, hours, groupId) => {
    const byToken = new Map();

    // Константы для стейблкоинов
    const STABLECOINS = {
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      'So11111111111111111111111111111111111111112': 'WSOL'
    };

    // Фильтруем транзакции по времени и groupId
    const now = new Date();
    const filteredTransactions = transactions.filter((tx) => {
      const txTime = new Date(tx.time);
      const hoursDiff = (now - txTime) / (1000 * 60 * 60);
      const matchesTimeframe = hoursDiff <= parseInt(hours);
      const matchesGroup = !groupId || tx.wallet.group_id === groupId;
      return matchesTimeframe && matchesGroup;
    });

    console.log(`[TokenTracker] Processing ${filteredTransactions.length} filtered transactions`);

    // Агрегируем данные по токенам
    filteredTransactions.forEach((tx) => {
      const tokens = tx.transactionType === 'buy' ? tx.tokensBought : tx.tokensSold;
      if (!tokens || tokens.length === 0) return;

      // Определяем SOL эквивалент для этой транзакции
      let solEquivalent = 0;
      if (tx.solSpent && tx.transactionType === 'buy') {
        solEquivalent = parseFloat(tx.solSpent);
      } else if (tx.solReceived && tx.transactionType === 'sell') {
        solEquivalent = parseFloat(tx.solReceived);
      }

      // Проверяем, была ли это транзакция через стейблкоин
      let isStablecoinTrade = false;
      let stablecoinAmount = 0;
      let stablecoinSymbol = '';

      // Ищем стейблкоин в токенах транзакции
      tokens.forEach(token => {
        if (STABLECOINS[token.mint]) {
          isStablecoinTrade = true;
          stablecoinAmount = token.amount || 0;
          stablecoinSymbol = STABLECOINS[token.mint];
          
          // Конвертируем стейблкоин в SOL эквивалент если это основная валюта торговли
          if (stablecoinSymbol === 'USDC' || stablecoinSymbol === 'USDT') {
            const SOL_PRICE_USD = 150; // Примерная цена SOL
            solEquivalent = stablecoinAmount / SOL_PRICE_USD;
          } else if (stablecoinSymbol === 'WSOL') {
            solEquivalent = stablecoinAmount;
          }
        }
      });

      tokens.forEach((token) => {
        // Пропускаем стейблкоины в отображении (они не являются "торгуемыми" токенами)
        if (STABLECOINS[token.mint]) {
          console.log(`[TokenTracker] Skipping stablecoin ${STABLECOINS[token.mint]} in display`);
          return;
        }

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
              stablecoinTrades: 0, // Новое поле для отслеживания торговли через стейблкоины
            },
          });
        }

        const tokenData = byToken.get(token.mint);
        const walletAddress = tx.wallet.address;
        const wallet = tokenData.wallets.find((w) => w.address === walletAddress);

        // Обновляем статистику кошелька
        if (!wallet) {
          tokenData.wallets.push({
            address: walletAddress,
            name: tx.wallet.name || null,
            groupId: tx.wallet.group_id,
            groupName: tx.wallet.group_name,
            txBuys: tx.transactionType === 'buy' ? 1 : 0,
            txSells: tx.transactionType === 'sell' ? 1 : 0,
            solSpent: tx.transactionType === 'buy' ? solEquivalent : 0,
            solReceived: tx.transactionType === 'sell' ? solEquivalent : 0,
            tokensBought: tx.transactionType === 'buy' ? token.amount || 0 : 0,
            tokensSold: tx.transactionType === 'sell' ? token.amount || 0 : 0,
            pnlSol: (tx.transactionType === 'sell' ? solEquivalent : 0) - 
                    (tx.transactionType === 'buy' ? solEquivalent : 0),
            lastActivity: tx.time,
            isStablecoinTrade: isStablecoinTrade,
            stablecoinInfo: isStablecoinTrade ? `${stablecoinAmount.toFixed(2)} ${stablecoinSymbol}` : null,
          });
          tokenData.summary.uniqueWallets.add(walletAddress);
        } else {
          wallet.txBuys += tx.transactionType === 'buy' ? 1 : 0;
          wallet.txSells += tx.transactionType === 'sell' ? 1 : 0;
          wallet.solSpent += tx.transactionType === 'buy' ? solEquivalent : 0;
          wallet.solReceived += tx.transactionType === 'sell' ? solEquivalent : 0;
          wallet.tokensBought += tx.transactionType === 'buy' ? token.amount || 0 : 0;
          wallet.tokensSold += tx.transactionType === 'sell' ? token.amount || 0 : 0;
          wallet.pnlSol = wallet.solReceived - wallet.solSpent;
          wallet.lastActivity = tx.time > wallet.lastActivity ? tx.time : wallet.lastActivity;
          
          // Обновляем информацию о стейблкоин торговле
          if (isStablecoinTrade) {
            wallet.isStablecoinTrade = true;
            wallet.stablecoinInfo = `${stablecoinAmount.toFixed(2)} ${stablecoinSymbol}`;
          }
        }

        // Обновляем summary
        tokenData.summary.totalBuys += tx.transactionType === 'buy' ? 1 : 0;
        tokenData.summary.totalSells += tx.transactionType === 'sell' ? 1 : 0;
        tokenData.summary.totalSpentSOL += tx.transactionType === 'buy' ? solEquivalent : 0;
        tokenData.summary.totalReceivedSOL += tx.transactionType === 'sell' ? solEquivalent : 0;
        
        if (isStablecoinTrade) {
          tokenData.summary.stablecoinTrades += 1;
        }
      });
    });

    // Формируем итоговый массив токенов
    const result = Array.from(byToken.values()).map((t) => ({
      ...t,
      summary: {
        ...t.summary,
        uniqueWallets: t.summary.uniqueWallets.size,
        netSOL: +(t.summary.totalReceivedSOL - t.summary.totalSpentSOL).toFixed(6),
      },
    }));

    // Сортируем по абсолютному значению netSOL
    result.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));

    console.log(`[TokenTracker] Aggregated ${result.length} unique tokens`);
    console.log(`[TokenTracker] Stablecoin trades detected in ${result.filter(t => t.summary.stablecoinTrades > 0).length} tokens`);

    return result;
  };

  // Обновляем items при изменении transactions, hours или groupId
  useEffect(() => {
    setLoading(true);
    try {
      const aggregatedTokens = aggregateTokens(transactions, hours, groupId);
      console.log('Aggregated tokens with stablecoin support:', aggregatedTokens);
      setItems(aggregatedTokens);
      setError(null);
    } catch (e) {
      setError(e.message);
      console.error('[TokenTracker] Error aggregating tokens:', e);
    } finally {
      setLoading(false);
    }
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
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-semibold text-gray-900">
          Token Tracker 
          <span className="text-sm font-normal text-gray-500 ml-2">
            (includes stablecoin trades)
          </span>
        </h3>
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
          {/* Статистика по типам торговли */}
          <div className="mb-4 p-3 bg-blue-50 rounded-lg">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div className="text-center">
                <div className="font-semibold text-blue-900">
                  {items.filter(t => t.summary.stablecoinTrades === 0).length}
                </div>
                <div className="text-blue-700">SOL Trades</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-purple-900">
                  {items.filter(t => t.summary.stablecoinTrades > 0).length}
                </div>
                <div className="text-purple-700">Stablecoin Trades</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-green-900">
                  {items.length}
                </div>
                <div className="text-green-700">Total Tokens</div>
              </div>
            </div>
          </div>

          {items.map((token) => (
            <div key={token.mint} className="mb-4">
              <TokenCard 
                token={token} 
                onOpenChart={() => openGmgnChart(token.mint)} 
                showStablecoinInfo={true}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TokenTracker;