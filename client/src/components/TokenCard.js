import React, { useState, useEffect } from 'react';
import WalletPill from './WalletPill';

function TokenCard({ token, onOpenChart }) {
    const [priceData, setPriceData] = useState(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const netColor = token.summary.netSOL > 0 ? 'text-green-700' : token.summary.netSOL < 0 ? 'text-red-700' : 'text-gray-700';

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

    useEffect(() => {
        fetchTokenPrice();
    }, [token.mint]);

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => console.log('Address copied to clipboard:', text))
            .catch(err => console.error('Failed to copy address:', err));
    };

    const openDexScreenerChart = () => {
        if (!token.mint) {
            console.warn('No mint address available for chart');
            return;
        }
        const dexScreenerUrl = `https://dexscreener.com/solana/${token.mint}`;
        window.open(dexScreenerUrl, '_blank');
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
                    <div className={`text-base font-bold ${netColor}`}>{token.summary.netSOL > 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL</div>
                    <div className="text-xs text-gray-500">{token.summary.uniqueWallets} wallets · {token.summary.totalBuys} buys · {token.summary.totalSells} sells</div>
                </div>
            </div>

            {/* Показываем текущую цену и базовую статистику если доступно */}
            {priceData && priceData.price > 0 && (
                <div className="mb-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Current Price:</span>
                                <span className="font-medium">{formatCurrency(priceData.price)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">24h Change:</span>
                                <span className={`font-medium ${priceData.change24h >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {priceData.change24h >= 0 ? '+' : ''}{priceData.change24h.toFixed(2)}%
                                </span>
                            </div>
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between">
                                <span className="text-gray-600">24h Volume:</span>
                                <span className="font-medium">{formatCurrency(priceData.volume24h)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-gray-600">Liquidity:</span>
                                <span className="font-medium">{formatCurrency(priceData.liquidity)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Суммарная статистика группы */}
            <div className="mb-3 p-3 bg-green-50 rounded-lg border border-green-200">
                <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1">
                        <div className="flex justify-between">
                            <span className="text-gray-600">Total Spent:</span>
                            <span className="font-medium">{formatNumber(token.summary.totalSpentSOL, 4)} SOL</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-600">Total Received:</span>
                            <span className="font-medium">{formatNumber(token.summary.totalReceivedSOL, 4)} SOL</span>
                        </div>
                    </div>
                    <div className="space-y-1">
                        <div className="flex justify-between">
                            <span className="text-gray-600">Net PnL (SOL):</span>
                            <div className="text-right">
                                <div className={`font-bold ${token.summary.netSOL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {token.summary.netSOL >= 0 ? '+' : ''}{token.summary.netSOL.toFixed(4)} SOL
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-600">Transactions:</span>
                            <span className="font-medium">{token.summary.totalBuys + token.summary.totalSells}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Список кошельков */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {token.wallets.map((w) => (
                    <WalletPill key={w.address} wallet={w} tokenMint={token.mint} />
                ))}
            </div>

            {/* Кнопки действий */}
            <div className="mt-2 flex space-x-2">
                <button
                    onClick={onOpenChart}
                    className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
                >
                    Open Chart
                </button>
                <button
                    onClick={openDexScreenerChart}
                    className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700 transition"
                >
                    DexScreener
                </button>
            </div>
        </div>
    );
}

export default TokenCard;