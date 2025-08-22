// client/src/components/TokenCard.js - FINAL OPTIMIZED VERSION

import React, { useState, useMemo } from 'react';
import WalletPill from './WalletPill';
import { useTokenPnL } from '../hooks/useTokenPnL';

function TokenCard({ token, onOpenChart }) {
    const [showAllWallets, setShowAllWallets] = useState(false);

    const WALLETS_DISPLAY_LIMIT = 6;

    // Prepare token data for PnL calculation
    const tokenForPnL = useMemo(() => ({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        totalTokensBought: token.wallets.reduce((sum, w) => sum + (w.tokensBought || 0), 0),
        totalTokensSold: token.wallets.reduce((sum, w) => sum + (w.tokensSold || 0), 0),
        totalSpentSOL: token.wallets.reduce((sum, w) => sum + (w.solSpent || 0), 0),
        totalReceivedSOL: token.wallets.reduce((sum, w) => sum + (w.solReceived || 0), 0)
    }), [token]);

    // Use optimized PnL hook
    const { getTokenPnL, loading, error } = useTokenPnL([tokenForPnL]);
    const pnlData = getTokenPnL(token.mint);

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
        if (Math.abs(num) >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
        if (Math.abs(num) >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
        return num.toFixed(decimals);
    };

    const formatCurrency = (num) => {
        if (num === null || num === undefined) return '$0';
        return `$${formatNumber(num)}`;
    };

    // Determine color and display values
    const getPnLDisplay = () => {
        if (loading) {
            return {
                solValue: '... SOL',
                usdValue: '$...',
                color: 'text-gray-500',
                loading: true,
                hasValidData: false
            };
        }

        if (!pnlData) {
            // Fallback to basic calculation
            const basicPnL = token.wallets.reduce((sum, w) => sum + (w.pnlSol || 0), 0);
            return {
                solValue: `${basicPnL >= 0 ? '+' : ''}${basicPnL.toFixed(4)} SOL`,
                usdValue: '$0',
                color: basicPnL > 0 ? 'text-green-700' : basicPnL < 0 ? 'text-red-700' : 'text-gray-700',
                loading: false,
                hasValidData: false
            };
        }

        const solValue = pnlData.totalPnLSOL || 0;
        const usdValue = pnlData.totalPnLUSD || 0;
        
        const color = solValue > 0 ? 'text-green-700' : solValue < 0 ? 'text-red-700' : 'text-gray-700';
        
        return {
            solValue: `${solValue >= 0 ? '+' : ''}${solValue.toFixed(4)} SOL`,
            usdValue: formatCurrency(Math.abs(usdValue)),
            color,
            loading: false,
            hasValidData: pnlData.hasValidData
        };
    };

    const pnlDisplay = getPnLDisplay();

    // Determine which wallets to show
    const walletsToShow = showAllWallets 
        ? token.wallets 
        : token.wallets.slice(0, WALLETS_DISPLAY_LIMIT);
    
    const hiddenWalletsCount = token.wallets.length - WALLETS_DISPLAY_LIMIT;
    const shouldShowToggle = token.wallets.length > WALLETS_DISPLAY_LIMIT;

    const toggleWalletsDisplay = () => {
        setShowAllWallets(!showAllWallets);
    };

    return (
        <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
                <div className="min-w-0">
                    <div className="flex items-center space-x-2">
                        <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">
                            {token.symbol || 'Unknown'}
                        </span>
                        <span className="text-gray-600 truncate">{token.name || 'Unknown Token'}</span>
                        {error && (
                            <span className="text-xs text-red-500" title={error}>⚠️</span>
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
                    <div className={`text-base font-bold ${pnlDisplay.color} flex items-center`}>
                        {pnlDisplay.loading && (
                            <div className="animate-spin rounded-full h-3 w-3 border border-gray-400 border-t-transparent mr-2"></div>
                        )}
                        {pnlDisplay.solValue}
                        {!pnlDisplay.hasValidData && !pnlDisplay.loading && (
                            <span className="text-xs text-gray-400 ml-1" title="Price data unavailable">*</span>
                        )}
                    </div>
                    <div className="text-xs text-gray-500">
                        {token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells
                    </div>
                </div>
            </div>

            {/* Enhanced PnL Details */}
            {pnlData && pnlData.hasValidData && (
                <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Holdings:</span>
                                <span className="font-medium">{formatNumber(pnlData.currentHoldings, 0)} tokens</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Current Value:</span>
                                <span className="font-medium">{formatCurrency(pnlData.currentValueUSD)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Token Price:</span>
                                <span className="font-medium">{formatCurrency(pnlData.currentPrice)}</span>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Realized PnL:</span>
                                <div className="text-right">
                                    <div className={`font-medium ${pnlData.realizedPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {pnlData.realizedPnLSOL >= 0 ? '+' : ''}{pnlData.realizedPnLSOL.toFixed(4)} SOL
                                    </div>
                                    <div className={`text-xs ${pnlData.realizedPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {formatCurrency(pnlData.realizedPnLUSD)}
                                    </div>
                                </div>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Unrealized PnL:</span>
                                <div className="text-right">
                                    <div className={`font-medium ${pnlData.unrealizedPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {pnlData.unrealizedPnLSOL >= 0 ? '+' : ''}{pnlData.unrealizedPnLSOL.toFixed(4)} SOL
                                    </div>
                                    <div className={`text-xs ${pnlData.unrealizedPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {formatCurrency(pnlData.unrealizedPnLUSD)}
                                    </div>
                                </div>
                            </div>
                            <div className="flex justify-between border-t border-blue-200 pt-1">
                                <span className="text-gray-600 font-medium">Total PnL:</span>
                                <div className="text-right">
                                    <div className={`font-bold ${pnlData.totalPnLSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {pnlData.totalPnLSOL >= 0 ? '+' : ''}{pnlData.totalPnLSOL.toFixed(4)} SOL
                                    </div>
                                    <div className={`text-xs ${pnlData.totalPnLUSD >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {formatCurrency(pnlData.totalPnLUSD)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Loading state for PnL */}
            {loading && !pnlData && (
                <div className="mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="flex items-center justify-center space-x-2 text-sm text-gray-500">
                        <div className="animate-spin rounded-full h-4 w-4 border border-gray-300 border-t-transparent"></div>
                        <span>Loading PnL data...</span>
                    </div>
                </div>
            )}

            {/* Error state for PnL */}
            {error && !loading && (
                <div className="mb-3 p-3 bg-red-50 rounded-lg border border-red-200">
                    <div className="flex items-center space-x-2 text-sm text-red-600">
                        <span>⚠️</span>
                        <span>Failed to load PnL data - using basic calculation</span>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {walletsToShow.map((w) => (
                    <WalletPill 
                        key={w.address} 
                        wallet={w} 
                        tokenMint={token.mint}
                        pnlData={pnlData}
                    />
                ))}
            </div>

            {/* Toggle button for showing/hiding wallets */}
            {shouldShowToggle && (
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
                                <span>Show {hiddenWalletsCount} more wallet{hiddenWalletsCount === 1 ? '' : 's'}</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            <div className="mt-2 flex space-x-2">
                <button
                    onClick={onOpenChart}
                    className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
                >
                    Open Chart
                </button>
                <button
                    onClick={openGmgnChart}
                    className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition"
                >
                    Open new tab
                </button>
            </div>
        </div>
    );
}

export default TokenCard;