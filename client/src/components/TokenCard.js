import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart, isNewPurchase = false, newPurchaseDetails = null }) {
    const [priceData, setPriceData] = useState(null);
    const [solPrice, setSolPrice] = useState(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const [loadingSolPrice, setLoadingSolPrice] = useState(false);
    const [groupPnL, setGroupPnL] = useState(null);
    const [isHighlighted, setIsHighlighted] = useState(isNewPurchase);
    const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

    // Убираем подсветку через 5 секунд
    useEffect(() => {
        if (isNewPurchase) {
            setIsHighlighted(true);
            const timer = setTimeout(() => {
                setIsHighlighted(false);
            }, 5000);
            return () => clearTimeout(timer);
        }
    }, [isNewPurchase]);

    // Helper function to get auth headers
    const getAuthHeaders = () => {
        const sessionToken = localStorage.getItem('sessionToken');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`
        };
    };

    const fetchTokenPrice = async () => {
        if (!token.mint || loadingPrice) return;
        setLoadingPrice(true);
        try {
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
                    pairAddress: bestPair.pairAddress
                });
            }
        } catch (error) {
            console.error('Error fetching token price:', error);
        } finally {
            setLoadingPrice(false);
        }
    };

    const fetchSolPrice = async () => {
        if (loadingSolPrice) return;
        setLoadingSolPrice(true);
        try {
            const response = await fetch('/api/solana/price', {
                headers: getAuthHeaders()
            });
            const data = await response.json();
            if (data.success) {
                setSolPrice(data.price);
            } else {
                console.error('Failed to fetch SOL price:', data.error);
                setSolPrice(150); 
            }
        } catch (error) {
            console.error('Error fetching SOL price:', error);
            setSolPrice(150);
        } finally {
            setLoadingSolPrice(false);
        }
    };

    const calculateGroupPnL = () => {
        if (!priceData || !priceData.price || !solPrice) return null;

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

        console.log('PnL Calculation Debug:', {
            totalTokensBought,
            totalTokensSold,
            totalSpentSOL,
            totalReceivedSOL,
            tokenPrice: priceData.price,
            solPrice
        });

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

        const currentTokenValueUSD = currentHoldings * priceData.price;
        const remainingCostBasisUSD = remainingCostBasisSOL * solPrice;
        
        const unrealizedPnLUSD = currentTokenValueUSD - remainingCostBasisUSD;
        const unrealizedPnLSOL = unrealizedPnLUSD / solPrice;
        
        const realizedPnLUSD = realizedPnLSOL * solPrice;
        
        const totalPnLUSD = realizedPnLUSD + unrealizedPnLUSD;
        const totalPnLSOL = totalPnLUSD / solPrice;

        console.log('PnL Results:', {
            realizedPnLSOL,
            unrealizedPnLSOL,
            totalPnLSOL,
            currentHoldings,
            currentTokenValueUSD,
            remainingCostBasisSOL,
            remainingCostBasisUSD
        });

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
            remainingCostBasisUSD,
            currentPriceUSD: priceData.price,
            solPrice,
            avgBuyPriceSOL: totalTokensBought > 0 ? totalSpentSOL / totalTokensBought : 0
        };
    };

    useEffect(() => {
        fetchTokenPrice();
        fetchSolPrice();
    }, [token.mint]);

    useEffect(() => {
        if (priceData && priceData.price && solPrice) {
            setGroupPnL(calculateGroupPnL());
        }
    }, [priceData, solPrice, token.wallets]);

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

    const formatTime = (timeString) => {
        if (!timeString) return 'N/A';
        const date = new Date(timeString);
        const now = new Date();
        const diffInMinutes = Math.floor((now - date) / (1000 * 60));
        
        if (diffInMinutes < 1) return 'Just now';
        if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
        return `${Math.floor(diffInMinutes / 1440)}d ago`;
    };

    // Проверяет, была ли активность в последние 10 секунд
    const isRecentActivity = (timeString) => {
        if (!timeString) return false;
        const activityTime = new Date(timeString);
        const now = new Date();
        const timeDiff = now - activityTime;
        return timeDiff <= 10000; // 10 секунд
    };

    return (
        <div className={`border rounded-lg p-4 transition-all duration-500 ${
            isHighlighted 
                ? 'bg-gradient-to-r from-green-50 to-blue-50 border-green-300 shadow-lg transform scale-[1.02]' 
                : 'bg-gray-50'
        }`}>
            {isHighlighted && (
                <div className="flex items-center mb-2 text-green-700 text-sm font-medium">
                    <div className="w-2 h-2 bg-green-500 rounded-full mr-2 animate-pulse"></div>
                    🎉 New purchase detected!
                </div>
            )}
            
            <div className="flex items-center justify-between mb-3">
                <div className="min-w-0">
                    <div className="flex items-center space-x-2">
                        <span className={`text-sm px-2 py-0.5 rounded-full font-semibold transition-all ${
                            isHighlighted 
                                ? 'bg-green-200 text-green-900' 
                                : 'bg-gray-200 text-gray-800'
                        }`}>
                            {token.symbol || 'Unknown'}
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
                    <div className={`text-base font-bold ${netColor}`}>{token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL</div>
                    <div className="text-xs text-gray-500">{token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells</div>
                </div>
            </div>

            {groupPnL && (
                <div className={`mb-3 p-3 rounded-lg border transition-all ${
                    isHighlighted 
                        ? 'bg-green-100 border-green-300' 
                        : 'bg-blue-50 border-blue-200'
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
                                isHighlighted ? 'border-green-300' : 'border-blue-200'
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
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {token.wallets.map((w) => {
                    // Проверяем, покупал ли этот кошелек токен недавно
                    const walletMadeNewPurchase = newPurchaseDetails && 
                        newPurchaseDetails.wallets && 
                        newPurchaseDetails.wallets.has(w.address);
                    
                    return (
                        <WalletPill 
                            key={w.address} 
                            wallet={w} 
                            tokenMint={token.mint}
                            isNewPurchase={walletMadeNewPurchase}
                            recentPurchaseTime={walletMadeNewPurchase ? newPurchaseDetails.latestPurchaseTime : w.lastActivity}
                        />
                    );
                })}
            </div>

            <div className="mt-2 flex space-x-2">
                <button
                    onClick={onOpenChart}
                    className={`flex-1 py-2 rounded transition-colors ${
                        isHighlighted 
                            ? 'bg-green-600 hover:bg-green-700' 
                            : 'bg-blue-600 hover:bg-blue-700'
                    } text-white`}
                >
                    Open Chart
                </button>
                <button
                    onClick={openGmgnChart}
                    className={`flex-1 py-2 rounded transition-colors ${
                        isHighlighted 
                            ? 'bg-emerald-600 hover:bg-emerald-700' 
                            : 'bg-green-600 hover:bg-green-700'
                    } text-white`}
                >
                    Open new tab
                </button>
            </div>
        </div>
    );
}

export default TokenCard;