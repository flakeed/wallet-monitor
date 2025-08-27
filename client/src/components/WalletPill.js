import { useTokenPriceAndInfo } from '../hooks/usePrices';
import { useState, useEffect, useMemo } from 'react';

function WalletPill({ wallet, tokenMint }) {
    const [totalPnL, setTotalPnL] = useState(null);
    const { solPrice, tokenInfo, tokenPrice, loading, error, ready } = useTokenPriceAndInfo(tokenMint);
    
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;

    // Improved PnL calculation with accurate accounting for individual wallet
    const calculatedPnL = useMemo(() => {
        if (!tokenMint || !ready || !solPrice || !tokenPrice?.price) {
            return wallet.pnlSol || 0;
        }

        const totalTokensBought = wallet.tokensBought || 0;
        const totalTokensSold = wallet.tokensSold || 0;
        const totalSpentSOL = wallet.solSpent || 0;
        const totalReceivedSOL = wallet.solReceived || 0;

        // Если нет покупок - возвращаем базовый PnL
        if (totalTokensBought === 0) {
            return wallet.pnlSol || 0;
        }

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

        return realizedPnLSOL + unrealizedPnLSOL;
    }, [tokenMint, ready, solPrice, tokenPrice, wallet.tokensBought, wallet.tokensSold, wallet.solSpent, wallet.solReceived]);

    // Update state when calculation changes
    useEffect(() => {
        setTotalPnL(calculatedPnL);
    }, [calculatedPnL]);

    // Determine color based on PnL
    const displayPnL = totalPnL !== null ? totalPnL : (wallet.pnlSol || 0);
    const pnlColor = displayPnL > 0 ? 'text-green-700' : displayPnL < 0 ? 'text-red-700' : 'text-gray-700';

    const openGmgnTokenWithMaker = () => {
        if (!tokenMint || !wallet.address) {
            console.warn('Missing token mint or wallet address');
            return;
        }
        const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
        window.open(gmgnUrl, '_blank');
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(wallet.address);
    };

    // Additional metrics for tooltip or detailed view
    const getDetailedMetrics = () => {
        if (!tokenMint || !ready || !solPrice || !tokenPrice?.price) return null;

        const totalTokensBought = wallet.tokensBought || 0;
        const totalTokensSold = wallet.tokensSold || 0;
        const totalSpentSOL = wallet.solSpent || 0;
        const totalReceivedSOL = wallet.solReceived || 0;

        if (totalTokensBought === 0) return null;

        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        const soldTokens = Math.min(totalTokensSold, totalTokensBought);
        const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
        
        let realizedPnLSOL = 0;
        let unrealizedPnLSOL = 0;

        if (soldTokens > 0) {
            const soldTokensCostBasisSOL = soldTokens * avgBuyPriceSOL;
            realizedPnLSOL = totalReceivedSOL - soldTokensCostBasisSOL;
        }

        if (currentHoldings > 0) {
            const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
            const currentMarketValueSOL = (currentHoldings * tokenPrice.price) / solPrice;
            unrealizedPnLSOL = currentMarketValueSOL - remainingCostBasisSOL;
        }

        return {
            totalTokensBought,
            totalTokensSold,
            currentHoldings,
            soldTokens,
            avgBuyPriceSOL,
            avgBuyPriceUSD: avgBuyPriceSOL * solPrice,
            currentPriceUSD: tokenPrice.price,
            realizedPnLSOL,
            unrealizedPnLSOL,
            totalPnLSOL: realizedPnLSOL + unrealizedPnLSOL,
            realizedPnLUSD: realizedPnLSOL * solPrice,
            unrealizedPnLUSD: unrealizedPnLSOL * solPrice,
            totalPnLUSD: (realizedPnLSOL + unrealizedPnLSOL) * solPrice,
            soldPercentage: (soldTokens / totalTokensBought) * 100,
            holdingPercentage: (currentHoldings / totalTokensBought) * 100,
            totalROI: totalSpentSOL > 0 ? ((realizedPnLSOL + unrealizedPnLSOL) / totalSpentSOL) * 100 : 0,
            currentHoldingValueUSD: currentHoldings * tokenPrice.price
        };
    };

    const metrics = getDetailedMetrics();

    // Format numbers for display
    const formatNumber = (num, decimals = 2) => {
        if (num === null || num === undefined) return '0';
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return num.toFixed(decimals);
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
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                    <span>{wallet.txBuys} buys · {wallet.txSells} sells</span>
                    {error && <span className="text-red-500" title={error}>⚠</span>}
                </div>
                {/* Enhanced token info display */}
                {metrics && (
                    <div className="text-[9px] text-gray-400 mt-1 space-y-0.5">
                        <div className="flex justify-between">
                            <span>Holdings: {formatNumber(metrics.currentHoldings, 0)}</span>
                            <span className="text-blue-600">
                                ${formatNumber(metrics.currentHoldingValueUSD)}
                            </span>
                        </div>
                        {tokenInfo && (
                            <div className="flex justify-between items-center">
                                <span>Price: ${tokenInfo.price.toFixed(tokenInfo.price < 0.01 ? 6 : 4)}</span>
                                {tokenInfo.priceChange24h !== undefined && (
                                    <span className={tokenInfo.priceChange24h >= 0 ? 'text-green-500' : 'text-red-500'}>
                                        {tokenInfo.priceChange24h >= 0 ? '+' : ''}{tokenInfo.priceChange24h.toFixed(2)}%
                                    </span>
                                )}
                            </div>
                        )}
                        {/* Token metadata indicators */}
                        {tokenInfo && (
                            <div className="flex items-center space-x-2 text-[8px]">
                                {tokenInfo.age && (
                                    <span className={tokenInfo.age.isNew ? 'text-green-600 font-semibold' : 'text-gray-500'}>
                                        {tokenInfo.age.displayText}
                                    </span>
                                )}
                                {tokenInfo.marketCap && (
                                    <span className="text-purple-600">
                                        MC: ${formatNumber(tokenInfo.marketCap)}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {!metrics && (
                    <div className="text-[9px] text-gray-400 mt-1">
                        spent {(wallet.solSpent || 0).toFixed(4)} SOL 
                        <br />
                        recv {(wallet.solReceived || 0).toFixed(4)} SOL
                    </div>
                )}
            </div>
            <div className="text-right ml-2">
                <div className={`text-xs font-semibold ${pnlColor} flex items-center`}>
                    {loading && tokenMint ? (
                        <div className="animate-spin rounded-full h-2 w-2 border border-gray-400 border-t-transparent mr-1"></div>
                    ) : null}
                    {displayPnL > 0 ? '+' : ''}{displayPnL.toFixed(4)} SOL
                </div>
                {metrics ? (
                    <div className="text-[9px] text-gray-400 space-y-0.5">
                        <div className={metrics.realizedPnLSOL !== 0 ? (metrics.realizedPnLSOL > 0 ? 'text-green-500' : 'text-red-500') : ''}>
                            Real: {metrics.realizedPnLSOL >= 0 ? '+' : ''}{metrics.realizedPnLSOL.toFixed(4)} SOL
                        </div>
                        <div className={metrics.unrealizedPnLSOL !== 0 ? (metrics.unrealizedPnLSOL > 0 ? 'text-green-500' : 'text-red-500') : ''}>
                            Unreal: {metrics.unrealizedPnLSOL >= 0 ? '+' : ''}{metrics.unrealizedPnLSOL.toFixed(4)} SOL
                        </div>
                        {/* Show ROI if significant */}
                        {Math.abs(metrics.totalROI) > 5 && (
                            <div className={metrics.totalROI > 0 ? 'text-green-500 font-semibold' : 'text-red-500 font-semibold'}>
                                ROI: {metrics.totalROI >= 0 ? '+' : ''}{metrics.totalROI.toFixed(1)}%
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="text-[9px] text-gray-400">
                        spent {(wallet.solSpent || 0).toFixed(4)} SOL 
                        <br />
                        recv {(wallet.solReceived || 0).toFixed(4)} SOL
                    </div>
                )}
                {error && (
                    <div className="text-[8px] text-red-500" title={error}>
                        ⚠ Price error
                    </div>
                )}
            </div>
        </div>
    );
}

export default WalletPill;