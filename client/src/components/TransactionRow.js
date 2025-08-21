import React, { useState, useEffect } from 'react';

function TransactionRow({ transaction, index, isNew: propIsNew }) {
    const [isNew, setIsNew] = useState(propIsNew || false);
    
    // Проверяем, является ли транзакция новой (менее 5 секунд назад)
    useEffect(() => {
        if (propIsNew) {
            setIsNew(true);
            return;
        }

        const transactionTime = new Date(transaction.time);
        const now = new Date();
        const timeDiff = now - transactionTime;
        
        // Если транзакция новее 5 секунд, показываем подсветку
        if (timeDiff < 5000) {
            setIsNew(true);
            
            // Убираем подсветку через оставшееся время
            const timeoutId = setTimeout(() => {
                setIsNew(false);
            }, 5000 - timeDiff);
            
            return () => clearTimeout(timeoutId);
        }
    }, [transaction.time, propIsNew]);

    // Обновляем состояние когда propIsNew меняется
    useEffect(() => {
        if (propIsNew !== undefined) {
            setIsNew(propIsNew);
        }
    }, [propIsNew]);

    const formatTime = (timeString) => {
        const date = new Date(timeString);
        const now = new Date();
        const diffInMinutes = Math.floor((now - date) / (1000 * 60));
        
        if (diffInMinutes < 1) return 'Just now';
        if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h ago`;
        return `${Math.floor(diffInMinutes / 1440)}d ago`;
    };

    const formatTokens = (tokens) => {
        if (!tokens || tokens.length === 0) return 'No tokens';
        
        if (tokens.length === 1) {
            const token = tokens[0];
            return `${token.amount?.toFixed(2) || 'N/A'} ${token.symbol || 'Unknown'}`;
        }
        
        return `${tokens.length} tokens`;
    };

    const openTransaction = () => {
        window.open(`https://solscan.io/tx/${transaction.signature}`, '_blank');
    };

    const copySignature = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(transaction.signature);
    };

    const copyWalletAddress = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(transaction.wallet.address);
    };

    const typeColor = transaction.transactionType === 'buy' 
        ? 'text-green-700 bg-green-50' 
        : 'text-red-700 bg-red-50';

    const typeIcon = transaction.transactionType === 'buy' 
        ? '🛒' 
        : '💸';

    // Классы для подсветки новых транзакций
    const highlightClasses = isNew 
        ? 'bg-gray-100 border-gray-300 shadow-md transform scale-[1.02]' 
        : 'bg-white border-gray-200 hover:bg-gray-50';

    const transitionClasses = 'transition-all duration-500 ease-in-out';

    return (
        <div 
            className={`${highlightClasses} ${transitionClasses} border rounded-lg p-4 cursor-pointer`}
            onClick={openTransaction}
        >
            {/* Индикатор новой транзакции */}
            {isNew && (
                <div className="flex items-center justify-center mb-2">
                    <div className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded-full animate-pulse">
                        ✨ New Transaction
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                    {/* Тип транзакции */}
                    <div className={`${typeColor} px-2 py-1 rounded-full text-xs font-medium flex items-center space-x-1`}>
                        <span>{typeIcon}</span>
                        <span className="uppercase">{transaction.transactionType}</span>
                    </div>
                    
                    {/* Время */}
                    <div className="text-xs text-gray-500">
                        {formatTime(transaction.time)}
                    </div>
                </div>

                {/* SOL Amount */}
                <div className="text-right">
                    <div className="font-medium text-gray-900">
                        {transaction.transactionType === 'buy' 
                            ? `${transaction.solSpent} SOL spent`
                            : `${transaction.solReceived} SOL received`
                        }
                    </div>
                </div>
            </div>

            {/* Wallet Info */}
            <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                    <span className="text-sm text-gray-600">Wallet:</span>
                    <button
                        onClick={copyWalletAddress}
                        className="text-sm font-mono text-blue-600 hover:text-blue-800 hover:underline"
                        title="Click to copy wallet address"
                    >
                        {transaction.wallet.name || `${transaction.wallet.address.slice(0, 8)}...`}
                    </button>
                    {transaction.wallet.group_name && (
                        <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
                            {transaction.wallet.group_name}
                        </span>
                    )}
                </div>

                {/* Signature */}
                <button
                    onClick={copySignature}
                    className="text-xs font-mono text-gray-500 hover:text-gray-700 hover:underline"
                    title="Click to copy transaction signature"
                >
                    {transaction.signature.slice(0, 8)}...
                </button>
            </div>

            {/* Tokens */}
            <div className="mt-2">
                <div className="text-sm text-gray-600">
                    <span className="font-medium">
                        {transaction.transactionType === 'buy' ? 'Tokens bought:' : 'Tokens sold:'}
                    </span>
                    <span className="ml-2">
                        {formatTokens(
                            transaction.transactionType === 'buy' 
                                ? transaction.tokensBought 
                                : transaction.tokensSold
                        )}
                    </span>
                </div>

                {/* Token Details */}
                {((transaction.transactionType === 'buy' && transaction.tokensBought?.length > 0) ||
                  (transaction.transactionType === 'sell' && transaction.tokensSold?.length > 0)) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {(transaction.transactionType === 'buy' 
                            ? transaction.tokensBought 
                            : transaction.tokensSold
                        ).map((token, tokenIndex) => (
                            <span
                                key={tokenIndex}
                                className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded"
                                title={`${token.name} (${token.mint})`}
                            >
                                {token.symbol || 'Unknown'}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            {/* Click hint */}
            <div className="mt-2 text-xs text-gray-400 text-center">
                Click to view on Solscan
            </div>
        </div>
    );
}

export default TransactionRow;