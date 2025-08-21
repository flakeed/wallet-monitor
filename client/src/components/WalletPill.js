import React, { useState, useEffect } from 'react';

function WalletPill({ wallet, tokenMint }) {
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
    const pnlColor = wallet.pnlSol > 0 ? 'text-green-700' : wallet.pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
    const [isHighlighted, setIsHighlighted] = useState(false);

    // Check if the wallet has a recent buy (within 5 seconds)
    useEffect(() => {
        if (wallet.txBuys > 0 && wallet.firstBuyTime) {
            const buyTime = new Date(wallet.firstBuyTime);
            const now = new Date();
            const diffInSeconds = (now - buyTime) / 1000;
            if (diffInSeconds <= 5) {
                setIsHighlighted(true);
                const timer = setTimeout(() => {
                    setIsHighlighted(false);
                }, 5000); // Remove highlight after 5 seconds
                return () => clearTimeout(timer);
            }
        }
    }, [wallet.firstBuyTime, wallet.txBuys]);

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
        <div
            className={`flex items-center justify-between border rounded-md px-2 py-1 bg-white transition-all duration-500 ${
                isHighlighted ? 'bg-green-100 border-green-400' : ''
            }`}
        >
            <div className="truncate max-w-xs">
                <div className="flex items-center space-x-2">
                    <div className="text-xs font-medium text-gray-900 truncate">{label}</div>
                    {isHighlighted && (
                        <span className="text-xs px-1 py-0.5 rounded-full bg-green-500 text-white">
                            New Buy
                        </span>
                    )}
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
                <div className={`text-xs font-semibold ${pnlColor}`}>{wallet.pnlSol > 0 ? '+' : ''}{wallet.pnlSol.toFixed(4)} SOL</div>
                <div className="text-[9px] text-gray-400">
                    spent {wallet.solSpent.toFixed(4)} SOL 
                    <br />
                    recv {wallet.solReceived.toFixed(4)} SOL
                </div>
            </div>
        </div>
    );
}

export default WalletPill;