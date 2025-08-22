// client/src/components/WalletPill.js - OPTIMIZED VERSION

import React, { useState, useEffect } from 'react';

function WalletPill({ wallet, tokenMint, pnlData }) {
    const [walletPnL, setWalletPnL] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;

    // Calculate individual wallet PnL based on group PnL data
    const calculateWalletPnL = () => {
        if (!pnlData || !pnlData.hasValidData || !pnlData.currentPrice || !pnlData.solPrice) {
            // Fallback to realized PnL only
            return {
                totalPnLSOL: wallet.pnlSol || 0,
                totalPnLUSD: (wallet.pnlSol || 0) * (pnlData?.solPrice || 150),
                hasValidData: false
            };
        }

        try {
            const totalTokensBought = wallet.tokensBought || 0;
            const totalTokensSold = wallet.tokensSold || 0;
            const totalSpentSOL = wallet.solSpent || 0;
            const totalReceivedSOL = wallet.solReceived || 0;

            const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
            
            let realizedPnLSOL = 0;
            let remainingCostBasisSOL = 0;

            if (totalTokensBought > 0 && totalTokensSold > 0) {
                const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
                const costOfSoldTokens = totalTokensSold * avgBuyPriceSOL;
                realizedPnLSOL = totalReceivedSOL - costOfSoldTokens;
                remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
            } else {
                realizedPnLSOL = totalReceivedSOL - totalSpentSOL;
                remainingCostBasisSOL = totalSpentSOL;
            }

            const currentTokenValueUSD = currentHoldings * pnlData.currentPrice;
            const remainingCostBasisUSD = remainingCostBasisSOL * pnlData.solPrice;
            
            const unrealizedPnLUSD = currentTokenValueUSD - remainingCostBasisUSD;
            const unrealizedPnLSOL = unrealizedPnLUSD / pnlData.solPrice;
            
            const totalPnLSOL = realizedPnLSOL + unrealizedPnLSOL;
            const totalPnLUSD = totalPnLSOL * pnlData.solPrice;
            
            return {
                totalPnLSOL,
                totalPnLUSD,
                realizedPnLSOL,
                unrealizedPnLSOL,
                currentHoldings,
                currentValueUSD: currentTokenValueUSD,
                hasValidData: true
            };
        } catch (error) {
            console.warn('Error calculating wallet PnL:', error);
            return {
                totalPnLSOL: wallet.pnlSol || 0,
                totalPnLUSD: (wallet.pnlSol || 0) * (pnlData?.solPrice || 150),
                hasValidData: false
            };
        }
    };

    // Recalculate when pnlData changes
    useEffect(() => {
        if (pnlData) {
            setWalletPnL(calculateWalletPnL());
        } else {
            setWalletPnL({
                totalPnLSOL: wallet.pnlSol || 0,
                totalPnLUSD: 0,
                hasValidData: false
            });
        }
    }, [pnlData, wallet]);

    // Determine color based on PnL
    const displayPnL = walletPnL ? walletPnL.totalPnLSOL : (wallet.pnlSol || 0);
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
        navigator.clipboard.writeText(wallet.address)
            .then(() => console.log('Wallet address copied'))
            .catch(err => console.error('Failed to copy:', err));
    };

    const formatTime = (timeString) => {
        if (!timeString) return 'N/A';
        const date = new Date(timeString);
        const now = new Date();
        const diffInMinutes = Math.floor((now - date) / (1000 * 60));
        
        if (diffInMinutes < 1) return 'now';
        if (diffInMinutes < 60) return `${diffInMinutes}m`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
        return `${Math.floor(diffInMinutes / 1440)}d`;
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
                    {tokenMint && (
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
                    )}
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                    <span>{wallet.txBuys || 0} buys · {wallet.txSells || 0} sells</span>
                    {walletPnL && walletPnL.currentHoldings > 0 && (
                        <span className="text-blue-600">
                            {walletPnL.currentHoldings.toFixed(0)} tokens
                        </span>
                    )}
                </div>
            </div>
            
            <div className="text-right ml-2">
                <div className={`text-xs font-semibold ${pnlColor} flex items-center`}>
                    {isLoading && (
                        <div className="animate-spin rounded-full h-2 w-2 border border-gray-400 border-t-transparent mr-1"></div>
                    )}
                    {displayPnL > 0 ? '+' : ''}{displayPnL.toFixed(4)} SOL
                    {walletPnL && !walletPnL.hasValidData && (
                        <span className="text-gray-400 ml-1" title="Estimated (price data unavailable)">*</span>
                    )}
                </div>
                
                {/* Enhanced details when PnL data is available */}
                {walletPnL && walletPnL.hasValidData ? (
                    <div className="text-[9px] text-gray-400">
                        <div>R: {walletPnL.realizedPnLSOL.toFixed(3)} SOL</div>
                        <div>U: {walletPnL.unrealizedPnLSOL.toFixed(3)} SOL</div>
                        {walletPnL.currentValueUSD > 0 && (
                            <div className="text-blue-500">
                                ${walletPnL.currentValueUSD.toFixed(0)}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="text-[9px] text-gray-400">
                        <div>spent {(wallet.solSpent || 0).toFixed(4)} SOL</div>
                        <div>recv {(wallet.solReceived || 0).toFixed(4)} SOL</div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default WalletPill;