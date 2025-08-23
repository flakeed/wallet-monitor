import { usePrices } from '../hooks/usePrices';
import { useState, useEffect,useMemo } from 'react';
function WalletPill({ wallet, tokenMint }) {
    const [totalPnL, setTotalPnL] = useState(null);
    const { solPrice, tokenPrice, loading, error, ready } = usePrices(tokenMint);
    
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;

    // Memoized PnL calculation - much faster than async fetch
    const calculatedPnL = useMemo(() => {
        if (!tokenMint || !ready || !solPrice || !tokenPrice?.price) {
            return wallet.pnlSol || 0;
        }
    
        const totalTokensBought = wallet.tokensBought || 0;
        const totalTokensSold = wallet.tokensSold || 0;
        const totalSpentSOL = wallet.solSpent || 0;
        const totalReceivedSOL = wallet.solReceived || 0;
    
        const currentHoldings = Math.max(0, totalTokensBought - totalTokensSold);
        
        let realizedPnLSOL = 0;
        let unrealizedPnLSOL = 0;
    
        // ИСПРАВЛЕННАЯ ЛОГИКА - такая же как в TokenCard
        if (totalTokensSold > 0) {
            // Есть продажи - считаем реализованный PnL
            const avgBuyPriceSOL = totalTokensBought > 0 ? totalSpentSOL / totalTokensBought : 0;
            const costOfSoldTokens = totalTokensSold * avgBuyPriceSOL;
            realizedPnLSOL = totalReceivedSOL - costOfSoldTokens;
        }
    
        if (currentHoldings > 0) {
            // Есть холдинги - считаем нереализованный PnL
            if (totalTokensSold > 0) {
                // Частичная продажа
                const avgBuyPriceSOL = totalSpentSOL / totalTokensBought;
                const remainingCostBasisSOL = currentHoldings * avgBuyPriceSOL;
                const currentTokenValueSOL = (currentHoldings * tokenPrice.price) / solPrice;
                unrealizedPnLSOL = currentTokenValueSOL - remainingCostBasisSOL;
            } else {
                // Только покупки - ОСНОВНАЯ ИСПРАВЛЕНИЕ ЗДЕСЬ!
                const currentTokenValueSOL = (currentHoldings * tokenPrice.price) / solPrice;
                unrealizedPnLSOL = currentTokenValueSOL - totalSpentSOL;
            }
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
            </div>
            <div className="text-right ml-2">
                <div className={`text-xs font-semibold ${pnlColor} flex items-center`}>
                    {loading && tokenMint ? (
                        <div className="animate-spin rounded-full h-2 w-2 border border-gray-400 border-t-transparent mr-1"></div>
                    ) : null}
                    {displayPnL > 0 ? '+' : ''}{displayPnL.toFixed(4)} SOL
                </div>
                <div className="text-[9px] text-gray-400">
                    spent {(wallet.solSpent || 0).toFixed(4)} SOL 
                    <br />
                    recv {(wallet.solReceived || 0).toFixed(4)} SOL
                </div>
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