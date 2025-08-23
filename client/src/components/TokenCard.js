// client/src/components/TokenCard.js - Enhanced with precise price-based PnL
import React, { useState, useEffect, useMemo } from 'react';
import WalletPill from './WalletPill';
import { usePrices } from '../hooks/usePrices';

function TokenCard({ token, onOpenChart }) {
    const [showAllWallets, setShowAllWallets] = useState(false);
    const [showPnLBreakdown, setShowPnLBreakdown] = useState(false);
    const { solPrice, tokenPrice: priceData, loading: loadingPrice } = usePrices(token.mint);

    const WALLETS_DISPLAY_LIMIT = 6;

    // Enhanced PnL calculation with price-based accuracy
    const groupPnL = useMemo(() => {
        if (!token.wallets || token.wallets.length === 0) return null;
    
        let totalTokensBought = 0;
        let totalTokensSold = 0;
        let totalSolSpent = 0;
        let totalSolReceived = 0;
        let totalUsdInvested = 0;
        let totalUsdReceived = 0;
        let priceBasedCalculationsAvailable = false;

        // Check if wallets have price-based data
        token.wallets.forEach(wallet => {
            totalTokensBought += wallet.tokensBought || 0;
            totalTokensSold += wallet.tokensSold || 0;
            totalSolSpent += wallet.solSpent || 0;
            totalSolReceived += wallet.solReceived || 0;
            
            // Check for enhanced price data
            if (wallet.avgBuyPriceUsd && wallet.totalUsdInvested) {
                totalUsdInvested += wallet.totalUsdInvested || 0;
                totalUsdReceived += wallet.totalUsdReceived || 0;
                priceBasedCalculationsAvailable = true;
            }
        });

        // If no purchases, return null
        if (totalTokensBought === 0) return null;

        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        const soldTokens = Math.min(totalTokensSold, totalTokensBought);
        
        let realizedPnLSol = 0;
        let realizedPnLUsd = 0;
        let unrealizedPnLSol = 0;
        let unrealizedPnLUsd = 0;
        let avgBuyPriceUsd = 0;
        let avgSellPriceUsd = 0;

        if (priceBasedCalculationsAvailable && totalUsdInvested > 0) {
            // Use precise price-based calculations
            realizedPnLUsd = totalUsdReceived - (totalUsdInvested * (soldTokens / totalTokensBought));
            avgBuyPriceUsd = totalUsdInvested / totalTokensBought;
            avgSellPriceUsd = soldTokens > 0 ? totalUsdReceived / soldTokens : 0;
            
            // Convert to SOL using current or average SOL price
            const avgSolPrice = solPrice || 150;
            realizedPnLSol = realizedPnLUsd / avgSolPrice;
            
            // Unrealized PnL using current market price
            if (currentHoldings > 0 && priceData?.price) {
                const currentMarketValueUsd = currentHoldings * priceData.price;
                const holdingsCostBasisUsd = avgBuyPriceUsd * currentHoldings;
                unrealizedPnLUsd = currentMarketValueUsd - holdingsCostBasisUsd;
                unrealizedPnLSol = unrealizedPnLUsd / avgSolPrice;
            }
        } else {
            // Fallback to SOL-based calculations
            avgBuyPriceUsd = totalSolSpent > 0 && solPrice ? (totalSolSpent * solPrice) / totalTokensBought : 0;
            
            // Realized PnL from SOL flows
            if (soldTokens > 0) {
                const avgBuyPriceSOL = totalSolSpent / totalTokensBought;
                const soldTokensCostBasisSOL = soldTokens * avgBuyPriceSOL;
                realizedPnLSol = totalSolReceived - soldTokensCostBasisSOL;
                realizedPnLUsd = realizedPnLSol * (solPrice || 150);
            }

            // Unrealized PnL using current market price
            if (currentHoldings > 0 && priceData?.price && solPrice) {
                const avgBuyPriceSOL = totalSolSpent / totalTokensBought;
                const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
                const currentMarketValueSOL = (currentHoldings * priceData.price) / solPrice;
                unrealizedPnLSol = currentMarketValueSOL - remainingCostBasisSOL;
                unrealizedPnLUsd = unrealizedPnLSol * solPrice;
            }
        }

        const totalPnLSol = realizedPnLSol + unrealizedPnLSol;
        const totalPnLUsd = realizedPnLUsd + unrealizedPnLUsd;
        
        // Calculate ROI
        const totalInvestedSOL = totalSolSpent;
        const totalInvestedUSD = priceBasedCalculationsAvailable ? totalUsdInvested : totalSolSpent * (solPrice || 150);
        
        const realizedROI = totalInvestedSOL > 0 ? (realizedPnLSol / totalInvestedSOL) * 100 : 0;
        const totalROI = totalInvestedSOL > 0 ? (totalPnLSol / totalInvestedSOL) * 100 : 0;
        
        return {
            // Holdings data
            totalTokensBought,
            totalTokensSold,
            currentHoldings,
            soldTokens,
            
            // Investment amounts
            totalSolSpent,
            totalSolReceived,
            totalUsdInvested: priceBasedCalculationsAvailable ? totalUsdInvested : totalSolSpent * (solPrice || 150),
            totalUsdReceived: priceBasedCalculationsAvailable ? totalUsdReceived : totalSolReceived * (solPrice || 150),
            
            // Price data
            avgBuyPriceUsd,
            avgSellPriceUsd,
            avgBuyPriceSOL: totalSolSpent > 0 ? totalSolSpent / totalTokensBought : 0,
            currentPriceUSD: priceData?.price || 0,
            solPrice: solPrice || 150,
            
            // PnL in SOL
            realizedPnLSol,
            unrealizedPnLSol,
            totalPnLSol,
            
            // PnL in USD
            realizedPnLUsd,
            unrealizedPnLUsd,
            totalPnLUsd,
            
            // Performance metrics
            realizedROI,
            totalROI,
            priceImprovement: avgBuyPriceUsd > 0 && avgSellPriceUsd > 0 ? 
                ((avgSellPriceUsd - avgBuyPriceUsd) / avgBuyPriceUsd) * 100 : 0,
            
            // Portfolio allocation
            soldPercentage: totalTokensBought > 0 ? (soldTokens / totalTokensBought) * 100 : 0,
            holdingPercentage: totalTokensBought > 0 ? (currentHoldings / totalTokensBought) * 100 : 0,
            
            // Data quality indicators
            priceBasedCalculationsAvailable,
            hasPriceData: priceData?.price > 0,
        };
    }, [priceData, solPrice, token.wallets]);

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
        if (num === null || num === undefined || isNaN(num)) return '0';
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return num.toFixed(decimals);
    };

    const formatCurrency = (num, currency = '') => {
        if (num === null || num === undefined || isNaN(num)) return `${currency}0`;
        return `${currency}${formatNumber(Math.abs(num))}`;
    };

    const formatPercentage = (num) => {
        if (num === null || num === undefined || isNaN(num)) return '0%';
        return `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`;
    };

    const getColorClass = (value, isPositive = null) => {
        if (isPositive !== null) {
            return isPositive ? 'text-green-600' : 'text-red-600';
        }
        if (value > 0) return 'text-green-600';
        if (value < 0) return 'text-red-600';
        return 'text-gray-600';
    };

    const toggleWalletsDisplay = () => {
        setShowAllWallets(!showAllWallets);
    };

    const togglePnLBreakdown = () => {
        setShowPnLBreakdown(!showPnLBreakdown);
    };

    return (
        <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2">
                        <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">
                            {token.symbol || 'Unknown'}
                        </span>
                        <span className="text-gray-600 truncate">{token.name || 'Unknown Token'}</span>
                        {groupPnL?.priceBasedCalculationsAvailable && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-600 font-medium">
                                Enhanced
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
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} 
                                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className="text-right">
                    <div className={`text-base font-bold flex items-center ${groupPnL ? getColorClass(groupPnL.totalPnLSol) : 'text-gray-700'}`}>
                        {loadingPrice && (
                            <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-1"></div>
                        )}
                        {groupPnL ? 
                            `${groupPnL.totalPnLSol >= 0 ? '+' : ''}${groupPnL.totalPnLSol.toFixed(4)} SOL`
                            : '0 SOL'
                        }
                    </div>
                    <div className="text-xs text-gray-500">
                        {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
                    </div>
                    {groupPnL?.totalPnLUsd && (
                        <div className={`text-xs ${getColorClass(groupPnL.totalPnLUsd)}`}>
                            {formatCurrency(groupPnL.totalPnLUsd)}
                        </div>
                    )}
                </div>
            </div>

            {/* Enhanced PnL Breakdown */}
            {groupPnL && (
                <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex justify-between items-center mb-2">
                        <h4 className="text-sm font-medium text-blue-900">Performance Analysis</h4>
                        <button
                            onClick={togglePnLBreakdown}
                            className="text-xs text-blue-600 hover:text-blue-800"
                        >
                            {showPnLBreakdown ? 'Hide Details' : 'Show Details'}
                        </button>
                    </div>
                    
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
                            {groupPnL.currentPriceUSD > 0 && (
                                <div className="flex justify-between">
                                    <span className="text-gray-600">Current Value:</span>
                                    <span className="font-medium text-blue-600">
                                        {formatCurrency(groupPnL.currentHoldings * groupPnL.currentPriceUSD)}
                                    </span>
                                </div>
                            )}
                        </div>
                        
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Realized PnL:</span>
                                <div className="text-right">
                                    <div className={`font-medium ${getColorClass(groupPnL.realizedPnLSol)}`}>
                                        {groupPnL.realizedPnLSol >= 0 ? '+' : ''}{groupPnL.realizedPnLSol.toFixed(4)} SOL
                                    </div>
                                    {groupPnL.priceBasedCalculationsAvailable && (
                                        <div className={`text-xs ${getColorClass(groupPnL.realizedPnLUsd)}`}>
                                            {formatCurrency(groupPnL.realizedPnLUsd)}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Unrealized PnL:</span>
                                <div className="text-right">
                                    <div className={`font-medium ${getColorClass(groupPnL.unrealizedPnLSol)}`}>
                                        {groupPnL.unrealizedPnLSol >= 0 ? '+' : ''}{groupPnL.unrealizedPnLSol.toFixed(4)} SOL
                                    </div>
                                    {groupPnL.priceBasedCalculationsAvailable && (
                                        <div className={`text-xs ${getColorClass(groupPnL.unrealizedPnLUsd)}`}>
                                            {formatCurrency(groupPnL.unrealizedPnLUsd)}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex justify-between border-t border-blue-200 pt-1">
                                <span className="text-gray-600 font-medium">Total PnL:</span>
                                <div className="text-right">
                                    <div className={`font-bold ${getColorClass(groupPnL.totalPnLSol)}`}>
                                        {groupPnL.totalPnLSol >= 0 ? '+' : ''}{groupPnL.totalPnLSol.toFixed(4)} SOL
                                    </div>
                                    {groupPnL.priceBasedCalculationsAvailable && (
                                        <div className={`text-xs ${getColorClass(groupPnL.totalPnLUsd)}`}>
                                            {formatCurrency(groupPnL.totalPnLUsd)}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Detailed breakdown */}
                    {showPnLBreakdown && (
                        <div className="mt-3 pt-3 border-t border-blue-200">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                                <div className="space-y-2">
                                    <h5 className="font-medium text-blue-800">Investment Details</h5>
                                    <div className="space-y-1">
                                        <div className="flex justify-between">
                                            <span>Bought:</span>
                                            <span>{formatNumber(groupPnL.totalTokensBought, 0)} tokens</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>Sold:</span>
                                            <span>{formatNumber(groupPnL.soldTokens, 0)} tokens ({groupPnL.soldPercentage.toFixed(1)}%)</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>SOL Spent:</span>
                                            <span>{groupPnL.totalSolSpent.toFixed(4)} SOL</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>SOL Received:</span>
                                            <span>{groupPnL.totalSolReceived.toFixed(4)} SOL</span>
                                        </div>
                                    </div>
                                </div>
                                
                                <div className="space-y-2">
                                    <h5 className="font-medium text-blue-800">Price Analysis</h5>
                                    <div className="space-y-1">
                                        {groupPnL.avgBuyPriceUsd > 0 && (
                                            <div className="flex justify-between">
                                                <span>Avg Buy:</span>
                                                <span>{formatCurrency(groupPnL.avgBuyPriceUsd, '')}</span>
                                            </div>
                                        )}
                                        {groupPnL.avgSellPriceUsd > 0 && (
                                            <div className="flex justify-between">
                                                <span>Avg Sell:</span>
                                                <span>{formatCurrency(groupPnL.avgSellPriceUsd, '')}</span>
                                            </div>
                                        )}
                                        {groupPnL.currentPriceUSD > 0 && (
                                            <div className="flex justify-between">
                                                <span>Current:</span>
                                                <span>{formatCurrency(groupPnL.currentPriceUSD, '')}</span>
                                            </div>
                                        )}
                                        <div className="flex justify-between font-medium">
                                            <span>Total ROI:</span>
                                            <span className={getColorClass(groupPnL.totalROI)}>
                                                {formatPercentage(groupPnL.totalROI)}
                                            </span>
                                        </div>
                                        {groupPnL.priceImprovement !== 0 && (
                                            <div className="flex justify-between">
                                                <span>Price Δ:</span>
                                                <span className={getColorClass(groupPnL.priceImprovement)}>
                                                    {formatPercentage(groupPnL.priceImprovement)}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                            
                            {/* Data quality indicator */}
                            <div className="mt-2 text-xs text-center">
                                <span className={`px-2 py-1 rounded-full text-xs ${
                                    groupPnL.priceBasedCalculationsAvailable 
                                        ? 'bg-green-100 text-green-700' 
                                        : 'bg-yellow-100 text-yellow-700'
                                }`}>
                                    {groupPnL.priceBasedCalculationsAvailable 
                                        ? '✓ Price-based calculations' 
                                        : '⚠ SOL-flow based estimates'
                                    }
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Wallet pills */}
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

            {/* Action buttons */}
            <div className="mt-3 flex space-x-2">
                <button
                    onClick={onOpenChart}
                    className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition text-sm font-medium"
                    disabled={loadingPrice}
                >
                    {loadingPrice ? (
                        <div className="flex items-center justify-center">
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Loading...
                        </div>
                    ) : (
                        'Open Chart'
                    )}
                </button>
                <button
                    onClick={openGmgnChart}
                    className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition text-sm font-medium"
                    disabled={loadingPrice}
                >
                    New Tab
                </button>
            </div>
        </div>
    );
}

export default TokenCard;