// client/src/components/TokenCard.js - Enhanced with market cap and token age
import React, { useState, useEffect, useMemo } from 'react';
import WalletPill from './WalletPill';
import { useTokenPriceAndInfo } from '../hooks/usePrices';

function TokenCard({ token, onOpenChart }) {
    const [showAllWallets, setShowAllWallets] = useState(false);
    const { solPrice, tokenInfo, tokenPrice, loading: loadingPrice } = useTokenPriceAndInfo(token.mint);

    const WALLETS_DISPLAY_LIMIT = 6;

    // Improved PnL calculation with accurate accounting
    const groupPnL = useMemo(() => {
        if (!tokenPrice || !tokenPrice.price || !solPrice) return null;
    
        let totalTokensBought = 0;
        let totalTokensSold = 0;
        let totalSpentSOL = 0;
        let totalReceivedSOL = 0;
    
        token.wallets.forEach(wallet => {
            totalTokensBought += wallet.tokensBought || 0;
            totalTokensSold += wallet.tokensSold || 0;
            totalSpentSOL += wallet.solSpent || 0;
            totalReceivedSOL += wallet.solReceived || 0;
        });

        // Если нет покупок - нет PnL
        if (totalTokensBought === 0) return null;

        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        const soldTokens = Math.min(totalTokensSold, totalTokensBought);
        
        // Средняя цена покупки в SOL за токен
        const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
        
        let realizedPnLSOL = 0;
        let unrealizedPnLSOL = 0;

        // Расчет реализованного PnL (только если были продажи)
        if (soldTokens > 0) {
            // Стоимость проданных токенов по цене покупки
            const soldTokensCostBasisSOL = soldTokens * avgBuyPriceSOL;
            // Реализованный PnL = выручка от продажи - себестоимость проданных токенов
            realizedPnLSOL = totalReceivedSOL - soldTokensCostBasisSOL;
        }

        // Расчет нереализованного PnL (только для оставшихся токенов)
        if (currentHoldings > 0) {
            // Себестоимость оставшихся токенов
            const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
            // Текущая рыночная стоимость оставшихся токенов
            const currentMarketValueSOL = (currentHoldings * tokenPrice.price) / solPrice;
            // Нереализованный PnL = текущая стоимость - себестоимость
            unrealizedPnLSOL = currentMarketValueSOL - remainingCostBasisSOL;
        }

        const totalPnLSOL = realizedPnLSOL + unrealizedPnLSOL;
        
        // Конвертируем в USD для отображения
        const realizedPnLUSD = realizedPnLSOL * solPrice;
        const unrealizedPnLUSD = unrealizedPnLSOL * solPrice;
        const totalPnLUSD = totalPnLSOL * solPrice;
        
        // Дополнительные метрики для анализа
        const totalInvestedSOL = totalSpentSOL;
        const totalInvestedUSD = totalInvestedSOL * solPrice;
        const currentTokenValueUSD = currentHoldings * tokenPrice.price;
        const totalReturnSOL = totalReceivedSOL + ((currentHoldings * tokenPrice.price) / solPrice);
        const totalReturnUSD = totalReturnSOL * solPrice;
        
        // ROI расчеты
        const realizedROI = totalSpentSOL > 0 ? (realizedPnLSOL / totalSpentSOL) * 100 : 0;
        const totalROI = totalSpentSOL > 0 ? (totalPnLSOL / totalSpentSOL) * 100 : 0;

        return {
            // Основные метрики
            totalTokensBought,
            totalTokensSold,
            currentHoldings,
            soldTokens,
            
            // SOL метрики
            totalSpentSOL,
            totalReceivedSOL,
            avgBuyPriceSOL,
            
            // PnL в SOL
            realizedPnLSOL,
            unrealizedPnLSOL,
            totalPnLSOL,
            
            // PnL в USD
            realizedPnLUSD,
            unrealizedPnLUSD,
            totalPnLUSD,
            
            // Дополнительные метрики
            totalInvestedSOL,
            totalInvestedUSD,
            currentTokenValueUSD,
            totalReturnSOL,
            totalReturnUSD,
            
            // ROI
            realizedROI,
            totalROI,
            
            // Текущие цены
            currentPriceUSD: tokenPrice.price,
            solPrice,
            
            // Проценты
            soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
            holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0
        };
    }, [tokenPrice, solPrice, token.wallets]);

    // Memoize wallet display calculations
    const walletCounts = useMemo(() => {
        const walletsToShow = showAllWallets 
            ? token.wallets 
            : token.wallets.slice(0, WALLETS_DISPLAY_LIMIT);
        const hiddenWalletsCount = token.wallets.length - WALLETS_DISPLAY_LIMIT;
        const shouldShowToggle = token.wallets.length > WALLETS_DISPLAY_LIMIT;
        
        return { walletsToShow, hiddenWalletsCount, shouldShowToggle };
    }, [token.wallets, showAllWallets]);

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => console.log('Address copied to clipboard:', text))
            .catch(err => console.error('Failed to copy address:', err));
    };

    const openGmgnChart = () => {
        if (!token.mint) {
            console.warn('No mint address available for chart');
            return;
        }
        const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}`;
        window.open(gmgnUrl, '_blank');
    };

    const formatNumber = (num, decimals = 2) => {
        if (num === null || num === undefined) return '0';
        if (Math.abs(num) >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return num.toFixed(decimals);
    };

    const formatCurrency = (num) => {
        if (num === null || num === undefined) return '$0';
        return `$${formatNumber(num)}`;
    };

    const formatMarketCap = (marketCap) => {
        if (!marketCap || marketCap <= 0) return 'Unknown';
        return formatCurrency(marketCap);
    };

    const formatTokenAge = (age) => {
        if (!age) return 'Unknown';
        return age.displayText;
    };

    const getAgeColor = (age) => {
        if (!age) return 'text-gray-500';
        if (age.isNew) return 'text-green-600 font-semibold';
        if (age.totalDays < 7) return 'text-blue-600';
        if (age.totalDays < 30) return 'text-yellow-600';
        return 'text-gray-600';
    };

    const getMarketCapColor = (marketCap) => {
        if (!marketCap || marketCap <= 0) return 'text-gray-500';
        if (marketCap >= 1000000000) return 'text-purple-600 font-bold'; // 1B+
        if (marketCap >= 100000000) return 'text-blue-600 font-semibold';  // 100M+
        if (marketCap >= 10000000) return 'text-green-600';   // 10M+
        if (marketCap >= 1000000) return 'text-yellow-600';   // 1M+
        return 'text-red-500'; // Under 1M
    };

    const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
        ? groupPnL.totalPnLSOL > 0
            ? 'text-green-700'
            : groupPnL.totalPnLSOL < 0
            ? 'text-red-700'
            : 'text-gray-700'
        : 'text-gray-700';

    const toggleWalletsDisplay = () => {
        setShowAllWallets(!showAllWallets);
    };

    return (
        <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2 mb-1">
                        <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">{token.symbol || 'Unknown'}</span>
                        <span className="text-gray-600 truncate text-sm">{token.name || 'Unknown Token'}</span>
                        {tokenInfo?.age?.isNew && (
                            <span className="text-xs px-1 py-0.5 bg-green-100 text-green-800 rounded font-medium">NEW</span>
                        )}
                    </div>
                    
                    {/* Token metadata info */}
                    <div className="flex items-center space-x-3 text-xs text-gray-500 mb-2">
                        <div className="flex items-center space-x-1">
                            <span>💰</span>
                            <span className={getMarketCapColor(tokenInfo?.marketCap)}>
                                {formatMarketCap(tokenInfo?.marketCap)}
                            </span>
                        </div>
                        <div className="flex items-center space-x-1">
                            <span>🕒</span>
                            <span className={getAgeColor(tokenInfo?.age)}>
                                {formatTokenAge(tokenInfo?.age)}
                            </span>
                        </div>
                        {tokenInfo?.volume24h && tokenInfo.volume24h > 0 && (
                            <div className="flex items-center space-x-1">
                                <span>📊</span>
                                <span className="text-blue-600">
                                    {formatCurrency(tokenInfo.volume24h)} 24h
                                </span>
                            </div>
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
                    <div className={`text-base font-bold ${netColor} flex items-center`}>
                        {loadingPrice && (
                            <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
                        )}
                        {groupPnL && groupPnL.totalPnLSOL !== undefined
                            ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                            : '0 SOL'}
                    </div>
                    <div className="text-xs text-gray-500">
                        {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
                    </div>
                    {tokenInfo?.price && (
                        <div className="text-xs text-gray-600 mt-1">
                            Price: ${tokenInfo.price.toFixed(tokenInfo.price < 0.01 ? 6 : 4)}
                            {tokenInfo.priceChange24h !== undefined && (
                                <span className={tokenInfo.priceChange24h >= 0 ? 'text-green-600 ml-1' : 'text-red-600 ml-1'}>
                                    {tokenInfo.priceChange24h >= 0 ? '+' : ''}{tokenInfo.priceChange24h.toFixed(2)}%
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {groupPnL && (
                <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Holdings:</span>
                                <span className="font-medium">
                                    {formatNumber(groupPnL.currentHoldings, 0)} tokens
                                    <span className="text-xs text-gray-400 ml-1">
                                        ({groupPnL.holdingPercentage.toFixed(1)}%)
                                    </span>
                                </span>
                            </div>
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
                            <div className="flex justify-between border-t border-blue-200 pt-1">
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

                    {/* Дополнительная информация для понимания расчетов */}
                    <div className="mt-2 pt-2 border-t border-blue-200">
                        <div className="text-xs text-gray-500 space-y-1">
                            <div className="flex justify-between">
                                <span>Bought: {formatNumber(groupPnL.totalTokensBought, 0)} tokens</span>
                                <span>Sold: {formatNumber(groupPnL.soldTokens, 0)} tokens ({groupPnL.soldPercentage.toFixed(1)}%)</span>
                            </div>
                            <div className="flex justify-between">
                                <span>Spent: {groupPnL.totalSpentSOL.toFixed(4)} SOL</span>
                                <span>Received: {groupPnL.totalReceivedSOL.toFixed(4)} SOL</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {walletCounts.walletsToShow.map((w) => (
                    <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
                ))}
            </div>

            {/* Toggle button for showing/hiding wallets */}
            {walletCounts.shouldShowToggle && (
                <div className="mt-2 flex justify-center">
                    <button
                        onClick={toggleWalletsDisplay}
                        className="text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 px-3 py-1 rounded-md transition-colors duration-200 flex items-center space-x-1"
                    >
                        {showAllWallets ? (
                            <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                </svg>
                                <span>Show fewer wallets</span>
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                                <span>Show {walletCounts.hiddenWalletsCount} more wallet{walletCounts.hiddenWalletsCount === 1 ? '' : 's'}</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            <div className="mt-2 flex space-x-2">
                <button
                    onClick={onOpenChart}
                    className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
                    disabled={loadingPrice}
                >
                    {loadingPrice ? 'Loading...' : 'Open Chart'}
                </button>
                <button
                    onClick={openGmgnChart}
                    className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition"
                    disabled={loadingPrice}
                >
                    Open new tab
                </button>
            </div>
        </div>
    );
}

export default TokenCard;