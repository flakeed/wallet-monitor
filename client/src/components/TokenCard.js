import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
    const [priceData, setPriceData] = useState(null);
    const [solPrice, setSolPrice] = useState(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const [loadingSolPrice, setLoadingSolPrice] = useState(false);
    const [groupPnL, setGroupPnL] = useState(null);
    const [showAllWallets, setShowAllWallets] = useState(false);

    const WALLETS_DISPLAY_LIMIT = 6;

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

    const netColor = groupPnL && groupPnL.totalPnLSOL !== undefined
        ? groupPnL.totalPnLSOL > 0
            ? 'text-green-700'
            : groupPnL.totalPnLSOL < 0
            ? 'text-red-700'
            : 'text-gray-700'
        : 'text-gray-700';

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
                        <span className="text-sm px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-semibold">{token.symbol || 'Unknown'}</span>
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
                    <div className={`text-base font-bold ${netColor}`}>
                        {groupPnL && groupPnL.totalPnLSOL !== undefined
                            ? `${groupPnL.totalPnLSOL >= 0 ? '+' : ''}${groupPnL.totalPnLSOL.toFixed(4)} SOL`
                            : '0 SOL'}
                    </div>
                    <div className="text-xs text-gray-500">{token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells</div>
                </div>
            </div>

            {groupPnL && (
                <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
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
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {walletsToShow.map((w) => (
                    <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
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