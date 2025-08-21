import React, { useState, useEffect } from 'react';

function WalletPill({ wallet, tokenMint }) {
    const [totalPnL, setTotalPnL] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
    
    // Helper function to get auth headers
    const getAuthHeaders = () => {
        const sessionToken = localStorage.getItem('sessionToken');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
        };
    };

    // Fetch token price and calculate total PnL
    const calculateTotalPnL = async () => {
        if (!tokenMint || isLoading) return;
        
        setIsLoading(true);
        try {
            // Fetch token price from DexScreener
            const priceResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
            const priceData = await priceResponse.json();
            
            // Fetch SOL price
            const solResponse = await fetch('/api/solana/price', {
                headers: getAuthHeaders()
            });
            const solData = await solResponse.json();
            
            if (priceData.pairs && priceData.pairs.length > 0 && solData.success) {
                const bestPair = priceData.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                const tokenPriceUSD = parseFloat(bestPair.priceUsd || 0);
                const solPriceUSD = solData.price;

                if (tokenPriceUSD > 0 && solPriceUSD > 0) {
                    // Calculate total PnL like in TokenCard.js
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

                    const currentTokenValueUSD = currentHoldings * tokenPriceUSD;
                    const remainingCostBasisUSD = remainingCostBasisSOL * solPriceUSD;
                    
                    const unrealizedPnLUSD = currentTokenValueUSD - remainingCostBasisUSD;
                    const unrealizedPnLSOL = unrealizedPnLUSD / solPriceUSD;
                    
                    const totalPnLSOL = realizedPnLSOL + unrealizedPnLSOL;
                    
                    setTotalPnL(totalPnLSOL);
                }
            }
        } catch (error) {
            console.error('Error calculating total PnL:', error);
            // Fallback to realized PnL if calculation fails
            setTotalPnL(wallet.pnlSol || 0);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (tokenMint) {
            calculateTotalPnL();
        } else {
            // If no token mint, use realized PnL
            setTotalPnL(wallet.pnlSol || 0);
        }
    }, [tokenMint, wallet]);

    // Determine color based on total PnL or fallback to realized PnL
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
                </div>
            </div>
            <div className="text-right ml-2">
                <div className={`text-xs font-semibold ${pnlColor} flex items-center`}>
                    {isLoading && tokenMint ? (
                        <div className="animate-spin rounded-full h-2 w-2 border border-gray-400 border-t-transparent mr-1"></div>
                    ) : null}
                    {displayPnL > 0 ? '+' : ''}{displayPnL.toFixed(4)} SOL
                </div>
                <div className="text-[9px] text-gray-400">
                    spent {(wallet.solSpent || 0).toFixed(4)} SOL 
                    <br />
                    recv {(wallet.solReceived || 0).toFixed(4)} SOL
                </div>
            </div>
        </div>
    );
}

export default WalletPill;