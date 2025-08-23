// client/src/components/WalletPill.js - Complete Enhanced Version with Price-aware PnL
import { usePrices } from '../hooks/usePrices';
import { useState, useEffect, useMemo } from 'react';

function WalletPill({ wallet, tokenMint }) {
    const [totalPnL, setTotalPnL] = useState(null);
    const [pnlBreakdown, setPnlBreakdown] = useState(null);
    const [showDetails, setShowDetails] = useState(false);
    const { solPrice, tokenPrice, loading, error, ready } = usePrices(tokenMint);
    
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;

    // Enhanced PnL calculation with price-based accuracy
    const calculatedPnL = useMemo(() => {
        if (!tokenMint || !ready) {
            return {
                totalPnL: wallet.pnlSol || 0,
                breakdown: null,
                usesPriceData: false
            };
        }

        const totalTokensBought = wallet.tokensBought || 0;
        const totalTokensSold = wallet.tokensSold || 0;
        const totalSolSpent = wallet.solSpent || 0;
        const totalSolReceived = wallet.solReceived || 0;

        // Check for enhanced price data from backend
        const hasPriceData = Boolean(
            wallet.avgBuyPriceUsd && 
            wallet.avgBuyPriceUsd > 0 && 
            wallet.totalUsdInvested && 
            wallet.totalUsdInvested > 0
        );
        
        if (totalTokensBought === 0) {
            return {
                totalPnL: wallet.pnlSol || 0,
                breakdown: null,
                usesPriceData: false,
                currentHoldings: 0,
                soldTokens: 0,
                totalTokensBought: 0,
                holdingPercentage: 0,
            };
        }

        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        const soldTokens = Math.min(totalTokensSold, totalTokensBought);
        
        let realizedPnLSol = 0;
        let realizedPnLUsd = 0;
        let unrealizedPnLSol = 0;
        let unrealizedPnLUsd = 0;
        let breakdown = null;

        if (hasPriceData && solPrice) {
            // Use precise price-based calculations
            const totalUsdInvested = wallet.totalUsdInvested || 0;
            const totalUsdReceived = wallet.totalUsdReceived || 0;
            const avgBuyPriceUsd = wallet.avgBuyPriceUsd || 0;
            const avgSellPriceUsd = wallet.avgSellPriceUsd || 0;
            
            // Realized PnL from completed trades using FIFO or average cost
            if (soldTokens > 0 && totalUsdInvested > 0) {
                // Calculate cost basis for sold tokens
                const soldTokensCostBasis = (totalUsdInvested / totalTokensBought) * soldTokens;
                realizedPnLUsd = totalUsdReceived - soldTokensCostBasis;
                realizedPnLSol = realizedPnLUsd / solPrice;
            }
            
            // Unrealized PnL from current holdings
            if (currentHoldings > 0 && tokenPrice?.price) {
                const currentValueUsd = currentHoldings * tokenPrice.price;
                const holdingsCostBasisUsd = (totalUsdInvested / totalTokensBought) * currentHoldings;
                unrealizedPnLUsd = currentValueUsd - holdingsCostBasisUsd;
                unrealizedPnLSol = unrealizedPnLUsd / solPrice;
            }

            breakdown = {
                // Price information
                avgBuyPriceUsd: avgBuyPriceUsd,
                avgSellPriceUsd: avgSellPriceUsd,
                currentPriceUsd: tokenPrice?.price || 0,
                
                // Investment totals
                totalInvestedUsd: totalUsdInvested,
                totalReceivedUsd: totalUsdReceived,
                currentHoldingsValueUsd: currentHoldings * (tokenPrice?.price || 0),
                
                // PnL breakdown
                realizedPnLUsd: realizedPnLUsd,
                unrealizedPnLUsd: unrealizedPnLUsd,
                totalPnLUsd: realizedPnLUsd + unrealizedPnLUsd,
                
                // Performance metrics
                realizedROI: totalUsdInvested > 0 ? (realizedPnLUsd / totalUsdInvested) * 100 : 0,
                totalROI: totalUsdInvested > 0 ? ((realizedPnLUsd + unrealizedPnLUsd) / totalUsdInvested) * 100 : 0,
                priceImprovement: avgBuyPriceUsd > 0 && tokenPrice?.price ? 
                    ((tokenPrice.price - avgBuyPriceUsd) / avgBuyPriceUsd) * 100 : 0,
                
                // Portfolio metrics
                costBasisPerToken: totalTokensBought > 0 ? totalUsdInvested / totalTokensBought : 0,
                averageROI: avgBuyPriceUsd > 0 && avgSellPriceUsd > 0 ? 
                    ((avgSellPriceUsd - avgBuyPriceUsd) / avgBuyPriceUsd) * 100 : 0,
            };
        } else {
            // Fallback to SOL-based calculations
            if (soldTokens > 0 && totalTokensBought > 0) {
                const avgBuyPriceSOL = totalSolSpent / totalTokensBought;
                const soldTokensCostBasisSOL = soldTokens * avgBuyPriceSOL;
                realizedPnLSol = totalSolReceived - soldTokensCostBasisSOL;
                realizedPnLUsd = realizedPnLSol * (solPrice || 150);
            }

            if (currentHoldings > 0 && tokenPrice?.price && solPrice) {
                const avgBuyPriceSOL = totalSolSpent / totalTokensBought;
                const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
                const currentMarketValueSOL = (currentHoldings * tokenPrice.price) / solPrice;
                unrealizedPnLSol = currentMarketValueSOL - remainingCostBasisSOL;
                unrealizedPnLUsd = unrealizedPnLSol * solPrice;
            }

            // Basic breakdown for SOL-based calculations
            breakdown = {
                avgBuyPriceUsd: totalSolSpent > 0 && solPrice ? (totalSolSpent * solPrice) / totalTokensBought : 0,
                avgSellPriceUsd: soldTokens > 0 && solPrice ? (totalSolReceived * solPrice) / soldTokens : 0,
                currentPriceUsd: tokenPrice?.price || 0,
                totalInvestedUsd: totalSolSpent * (solPrice || 150),
                currentHoldingsValueUsd: currentHoldings * (tokenPrice?.price || 0),
                realizedPnLUsd: realizedPnLUsd,
                unrealizedPnLUsd: unrealizedPnLUsd,
                totalPnLUsd: realizedPnLUsd + unrealizedPnLUsd,
                realizedROI: totalSolSpent > 0 ? (realizedPnLSol / totalSolSpent) * 100 : 0,
                totalROI: totalSolSpent > 0 ? ((realizedPnLSol + unrealizedPnLSol) / totalSolSpent) * 100 : 0,
                priceImprovement: 0,
            };
        }

        return {
            totalPnL: realizedPnLSol + unrealizedPnLSol,
            realizedPnL: realizedPnLSol,
            unrealizedPnL: unrealizedPnLSol,
            breakdown,
            usesPriceData: hasPriceData,
            currentHoldings,
            soldTokens,
            totalTokensBought,
            holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0,
            soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
        };
    }, [tokenMint, ready, solPrice, tokenPrice, wallet]);

    // Update state when calculation changes
    useEffect(() => {
        setTotalPnL(calculatedPnL.totalPnL);
        setPnlBreakdown(calculatedPnL.breakdown);
    }, [calculatedPnL]);

    const displayPnL = totalPnL !== null ? totalPnL : (wallet.pnlSol || 0);
    const pnlColor = displayPnL > 0 ? 'text-green-600' : displayPnL < 0 ? 'text-red-600' : 'text-gray-600';

    const openGmgnTokenWithMaker = () => {
        if (!tokenMint || !wallet.address) {
            console.warn('Missing token mint or wallet address');
            return;
        }
        const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
        window.open(gmgnUrl, '_blank');
    };

    const copyToClipboard = () => {
        navigator.clipboard.writeText(wallet.address)
            .then(() => console.log('Wallet address copied to clipboard'))
            .catch(err => console.error('Failed to copy address:', err));
    };

    // Utility functions for formatting
    const formatNumber = (num, decimals = 2) => {
        if (num === null || num === undefined || isNaN(num)) return '0';
        if (Math.abs(num) >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return num.toFixed(decimals);
    };

    const formatCurrency = (num, currency = '$') => {
        if (num === null || num === undefined || isNaN(num)) return `${currency}0`;
        const absNum = Math.abs(num);
        if (absNum >= 1e6) return `${currency}${(num / 1e6).toFixed(2)}M`;
        if (absNum >= 1e3) return `${currency}${(num / 1e3).toFixed(1)}K`;
        return `${currency}${num.toFixed(2)}`;
    };

    const formatPercentage = (num, showPlus = true) => {
        if (num === null || num === undefined || isNaN(num)) return '0%';
        const sign = showPlus && num > 0 ? '+' : '';
        return `${sign}${num.toFixed(1)}%`;
    };

    const getColorClass = (value) => {
        if (value > 0) return 'text-green-600';
        if (value < 0) return 'text-red-600';
        return 'text-gray-600';
    };

    return (
        <div className="flex items-center justify-between border rounded-md px-2 py-1 bg-white hover:bg-gray-50 transition-colors relative">
            <div className="truncate max-w-xs flex-1">
                <div className="flex items-center space-x-2">
                    {/* Wallet label with quality indicator */}
                    <div className="text-xs font-medium text-gray-900 truncate flex items-center space-x-1">
                        <span>{label}</span>
                        {calculatedPnL.usesPriceData && (
                            <span 
                                className="px-1 py-0.5 text-xs bg-blue-100 text-blue-700 rounded font-medium"
                                title="Enhanced calculations with price data"
                            >
                                ✓
                            </span>
                        )}
                        {error && (
                            <span 
                                className="px-1 py-0.5 text-xs bg-red-100 text-red-700 rounded"
                                title={`Error: ${error}`}
                            >
                                !
                            </span>
                        )}
                    </div>
                    
                    {/* Action buttons */}
                    <div className="flex items-center space-x-1">
                        <button
                            onClick={copyToClipboard}
                            className="text-gray-400 hover:text-blue-600 p-0.5 rounded transition-colors"
                            title="Copy wallet address"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                        <button
                            onClick={openGmgnTokenWithMaker}
                            className="text-gray-400 hover:text-blue-600 p-0.5 rounded transition-colors"
                            title="Open token chart with this wallet as maker"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                        </button>
                        <button
                            onClick={() => setShowDetails(!showDetails)}
                            className="text-gray-400 hover:text-gray-600 p-0.5 rounded transition-colors"
                            title={showDetails ? "Hide details" : "Show details"}
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d={showDetails ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
                            </svg>
                        </button>
                    </div>
                </div>
                
                {/* Basic transaction info */}
                <div className="flex items-center justify-between text-[10px] text-gray-500 mt-0.5">
                    <span>{wallet.txBuys || 0} buys · {wallet.txSells || 0} sells</span>
                    {loading && tokenMint && (
                        <div className="animate-spin rounded-full h-2 w-2 border border-gray-400 border-t-transparent"></div>
                    )}
                </div>
                
                {/* Holdings information */}
                {calculatedPnL.currentHoldings > 0 && (
                    <div className="text-[9px] text-gray-400 mt-1">
                        <div className="flex justify-between items-center">
                            <span title={`Holdings: ${calculatedPnL.currentHoldings.toFixed(2)} tokens (${calculatedPnL.holdingPercentage.toFixed(1)}%)`}>
                                Holdings: {calculatedPnL.currentHoldings > 1000 ? 
                                    formatNumber(calculatedPnL.currentHoldings, 0) : 
                                    calculatedPnL.currentHoldings.toFixed(0)
                                } ({calculatedPnL.holdingPercentage.toFixed(0)}%)
                            </span>
                            {pnlBreakdown?.currentPriceUsd > 0 && (
                                <span className="text-blue-600 font-medium">
                                    {formatCurrency(pnlBreakdown.currentPriceUsd)}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Sold tokens info */}
                {calculatedPnL.soldTokens > 0 && (
                    <div className="text-[9px] text-gray-400">
                        <span>
                            Sold: {formatNumber(calculatedPnL.soldTokens, 0)} tokens ({calculatedPnL.soldPercentage.toFixed(0)}%)
                        </span>
                    </div>
                )}
            </div>
            
            {/* PnL Display */}
            <div className="text-right ml-2 min-w-[80px]">
                <div className={`text-xs font-bold ${pnlColor} flex items-center justify-end`}>
                    {displayPnL > 0 ? '+' : ''}{displayPnL.toFixed(4)} SOL
                </div>
                
                {/* Enhanced breakdown display */}
                {calculatedPnL.realizedPnL !== undefined && calculatedPnL.unrealizedPnL !== undefined ? (
                    <div className="text-[8px] text-gray-500 space-y-0.5 mt-1">
                        <div className="flex justify-between">
                            <span>Real:</span>
                            <span className={`font-medium ${getColorClass(calculatedPnL.realizedPnL)}`}>
                                {calculatedPnL.realizedPnL >= 0 ? '+' : ''}{calculatedPnL.realizedPnL.toFixed(4)}
                            </span>
                        </div>
                        <div className="flex justify-between">
                            <span>Unreal:</span>
                            <span className={`font-medium ${getColorClass(calculatedPnL.unrealizedPnL)}`}>
                                {calculatedPnL.unrealizedPnL >= 0 ? '+' : ''}{calculatedPnL.unrealizedPnL.toFixed(4)}
                            </span>
                        </div>
                        
                        {/* Show price improvement if available */}
                        {pnlBreakdown?.priceImprovement !== undefined && Math.abs(pnlBreakdown.priceImprovement) > 0.1 && (
                            <div className="flex justify-between">
                                <span>Price Δ:</span>
                                <span className={`font-medium ${getColorClass(pnlBreakdown.priceImprovement)}`}>
                                    {formatPercentage(pnlBreakdown.priceImprovement)}
                                </span>
                            </div>
                        )}
                    </div>
                ) : (
                    // Fallback display for basic data
                    <div className="text-[8px] text-gray-500 space-y-0.5 mt-1">
                        <div className="flex justify-between">
                            <span>Spent:</span>
                            <span>{(wallet.solSpent || 0).toFixed(4)}</span>
                        </div>
                        <div className="flex justify-between">
                            <span>Recv:</span>
                            <span>{(wallet.solReceived || 0).toFixed(4)}</span>
                        </div>
                    </div>
                )}

                {/* USD values if available */}
                {pnlBreakdown && pnlBreakdown.totalPnLUsd !== 0 && (
                    <div className="text-[8px] text-gray-500 mt-1 pt-1 border-t border-gray-200">
                        <div className={`font-medium ${getColorClass(pnlBreakdown.totalPnLUsd)}`}>
                            USD: {formatCurrency(pnlBreakdown.totalPnLUsd)}
                        </div>
                    </div>
                )}

                {/* ROI indicator */}
                {pnlBreakdown && Math.abs(pnlBreakdown.totalROI) > 1 && (
                    <div className="text-[8px] mt-0.5">
                        <span className={`font-medium ${getColorClass(pnlBreakdown.totalROI)}`}>
                            ROI: {formatPercentage(pnlBreakdown.totalROI)}
                        </span>
                    </div>
                )}
            </div>

            {/* Detailed breakdown tooltip/popup */}
            {showDetails && pnlBreakdown && (
                <div className="absolute top-full left-0 right-0 mt-1 p-2 bg-white border border-gray-300 rounded-md shadow-lg text-xs z-10">
                    <div className="grid grid-cols-2 gap-2 text-[10px]">
                        <div className="space-y-1">
                            <h4 className="font-medium text-gray-800 text-[11px]">Investment</h4>
                            <div className="space-y-0.5">
                                <div className="flex justify-between">
                                    <span>Bought:</span>
                                    <span>{formatNumber(calculatedPnL.totalTokensBought, 0)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Avg Buy:</span>
                                    <span>{formatCurrency(pnlBreakdown.avgBuyPriceUsd)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Invested:</span>
                                    <span>{formatCurrency(pnlBreakdown.totalInvestedUsd)}</span>
                                </div>
                            </div>
                        </div>
                        
                        <div className="space-y-1">
                            <h4 className="font-medium text-gray-800 text-[11px]">Performance</h4>
                            <div className="space-y-0.5">
                                <div className="flex justify-between">
                                    <span>Current:</span>
                                    <span>{formatCurrency(pnlBreakdown.currentPriceUsd)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Holdings:</span>
                                    <span>{formatCurrency(pnlBreakdown.currentHoldingsValueUsd)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Total ROI:</span>
                                    <span className={getColorClass(pnlBreakdown.totalROI)}>
                                        {formatPercentage(pnlBreakdown.totalROI)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    {/* Data quality indicator */}
                    <div className="mt-2 pt-1 border-t border-gray-200 text-center">
                        <span className={`px-2 py-1 rounded-full text-[9px] ${
                            calculatedPnL.usesPriceData 
                                ? 'bg-green-100 text-green-700' 
                                : 'bg-yellow-100 text-yellow-700'
                        }`}>
                            {calculatedPnL.usesPriceData 
                                ? '✓ Enhanced price calculations' 
                                : '⚠ Estimated from SOL flows'
                            }
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}

export default WalletPill;