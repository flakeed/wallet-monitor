import React from 'react';

function WalletPill({ wallet, tokenMint }) {
    // Add null checks to prevent errors
    if (!wallet || !wallet.address) {
        console.warn('WalletPill: Invalid wallet data:', wallet);
        return (
            <div className="flex items-center justify-between border rounded-md px-2 py-1 bg-red-50 border-red-200">
                <div className="text-xs text-red-600">Invalid wallet data</div>
            </div>
        );
    }

    // Формируем метку кошелька (имя или сокращенный адрес)
    const label = wallet.name || `${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)}`;
    
    // Цвет для PnL: зеленый для положительного, красный для отрицательного, серый для нулевого
    // PnL уже рассчитан на backend и приходит в SOL (включая конвертацию из USDC)
    const pnlSol = wallet.pnlSol || 0;
    const pnlColor = pnlSol > 0 ? 'text-green-700' : pnlSol < 0 ? 'text-red-700' : 'text-gray-700';
    
    // Чистое количество токенов (куплено - продано)
    const netAmount = (wallet.tokensBought || 0) - (wallet.tokensSold || 0);

    // Открытие графика на gmgn.ai с указанием кошелька как maker
    const openGmgnTokenWithMaker = () => {
        if (!tokenMint || !wallet.address) {
            console.warn('Missing token mint or wallet address');
            return;
        }
        const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(tokenMint)}?maker=${encodeURIComponent(wallet.address)}`;
        window.open(gmgnUrl, '_blank');
    };

    // Копирование адреса кошелька в буфер обмена
    const copyToClipboard = () => {
        if (wallet.address) {
            navigator.clipboard.writeText(wallet.address);
        }
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
                        disabled={!wallet.address}
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
                        disabled={!tokenMint || !wallet.address}
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
                <div className="text-[10px] text-gray-500">
                    {wallet.txBuys || 0} buys · {wallet.txSells || 0} sells
                </div>
            </div>
            <div className="text-right ml-2">
                <div className={`text-xs font-semibold ${pnlColor}`}>
                    {pnlSol > 0 ? '+' : ''}{pnlSol.toFixed(4)} SOL
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