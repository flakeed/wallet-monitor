const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        // Используем правильный RPC URL для вашей ноды
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', 'confirmed');
        this.isMonitoring = false; // WebSocket теперь управляет мониторингом
        this.monitoringInterval = null;
        this.processedSignatures = new Set();
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0,
            startTime: Date.now()
        };
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.isProcessingQueue = false;
        this.queueKey = 'webhook:queue';
        
        console.log(`[${new Date().toISOString()}] 🔧 MonitoringService initialized with RPC: ${this.connection.rpcEndpoint}`);
    }

    startMonitoring() {
        console.log('⚠️ Legacy monitoring is deprecated. Use WebSocket service instead.');
        this.isMonitoring = false;
    }

    stopMonitoring() {
        this.isMonitoring = false;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        console.log('⏹️ Legacy monitoring stopped');
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (true) {
            const requestData = await this.redis.rpop(this.queueKey);
            if (!requestData) break;

            let request;
            try {
                request = JSON.parse(requestData);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, error.message);
                continue;
            }

            const { requestId, signature, walletAddress } = request;
            console.log(`[${new Date().toISOString()}] 🔄 Processing queued signature ${signature} (requestId: ${requestId})`);

            try {
                const wallet = await this.db.getWalletByAddress(walletAddress);
                if (!wallet) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
                    continue;
                }

                const sigStatus = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
                if (!sigStatus.value || sigStatus.value.err) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Invalid or failed transaction ${signature}`);
                    continue;
                }

                const blockTime = sigStatus.value.blockTime;
                if (!blockTime) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ No blockTime for signature ${signature}`);
                    continue;
                }

                const sigObject = { signature, blockTime };
                const txData = await this.processTransaction(sigObject, wallet);
                if (txData) {
                    console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature} for wallet ${walletAddress}`);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${signature}:`, error.message);
            }

            // УБИРАЕМ ЗАДЕРЖКУ для моментальной обработки
            // await new Promise(resolve => setTimeout(resolve, 300)); - УДАЛЕНО
        }

        this.isProcessingQueue = false;

        const queueLength = await this.redis.llen(this.queueKey);
        if (queueLength > 0) {
            setImmediate(() => this.processQueue());
        }
    }

    async processWebhookMessage(message) {
        const { signature, walletAddress } = message;

        const requestId = require('uuid').v4();
        await this.redis.lpush(this.queueKey, JSON.stringify({
            requestId,
            signature,
            walletAddress,
            timestamp: Date.now()
        }));
        console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature} with requestId ${requestId}`);

        if (!this.isProcessingQueue) {
            // НЕМЕДЛЕННО запускаем обработку очереди
            setImmediate(() => this.processQueue());
        }
    }

    async checkWalletTransactions(wallet) {
        try {
            const pubkey = new PublicKey(wallet.address);

            const signatures = await this.connection.getSignaturesForAddress(pubkey, {
                limit: 10
            });

            let newTransactionsCount = 0;

            for (const sig of signatures) {
                if (this.processedSignatures.has(sig.signature)) {
                    continue;
                }

                const txData = await this.processTransaction(sig, wallet);
                if (txData) {
                    newTransactionsCount++;
                    this.processedSignatures.add(sig.signature);
                    
                    if (txData.type === 'buy') {
                        this.stats.totalBuyTransactions++;
                    } else if (txData.type === 'sell') {
                        this.stats.totalSellTransactions++;
                    }
                }

                // УБИРАЕМ ЗАДЕРЖКУ между транзакциями
                // await new Promise(resolve => setTimeout(resolve, 300)); - УДАЛЕНО
            }

            if (newTransactionsCount > 0) {
                console.log(`✅ ${wallet.name || wallet.address.slice(0, 8)}...: ${newTransactionsCount} new transactions`);
                await this.db.updateWalletStats(wallet.id);
            }

            return { newTransactions: newTransactionsCount };

        } catch (error) {
            console.error(`❌ Error checking wallet ${wallet.address}:`, error.message);
            throw error;
        }
    }

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }

            // Проверяем, не обрабатывали ли мы уже эту транзакцию
            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1',
                [sig.signature]
            );

            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed`);
                return null;
            }

            console.log(`[${new Date().toISOString()}] 🔍 Fetching transaction data for ${sig.signature.slice(0, 20)}...`);

            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });

            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature}`);
                return null;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            
            let transactionType, solAmount;
            if (solChange < -0.001) { // Увеличиваем минимальный порог
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
            } else if (solChange > 0.001) { 
                transactionType = 'sell';
                solAmount = solChange;
            } else {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange}`);
                return null; 
            }

            const tokenChanges = this.analyzeTokenChanges(tx.meta, transactionType);
            if (tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
                return null;
            }

            console.log(`[${new Date().toISOString()}] 🔍 Processing ${transactionType} transaction ${sig.signature}: ${solAmount} SOL, ${tokenChanges.length} tokens`);

            return await this.db.withTransaction(async (client) => {
                const solPrice = await fetchHistoricalSolPrice(new Date(sig.blockTime * 1000));
                const usdAmount = solPrice * solAmount;

                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        ${transactionType === 'buy' ? 'sol_spent, usd_spent' : 'sol_received, usd_received'}
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;

                let result;
                try {
                    result = await client.query(query, [
                        wallet.id,
                        sig.signature,
                        new Date(sig.blockTime * 1000).toISOString(),
                        transactionType,
                        solAmount,
                        usdAmount
                    ]);
                } catch (error) {
                    if (error.code === '23505') {
                        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already exists`);
                        return null; 
                    }
                    throw error;
                }

                const transaction = result.rows[0];

                // ПАРАЛЛЕЛЬНО сохраняем токены для ускорения
                const tokenSavePromises = tokenChanges.map(tokenChange => 
                    this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
                );
                await Promise.all(tokenSavePromises);

                console.log(`[${new Date().toISOString()}] ✅ Saved ${transactionType} transaction ${sig.signature}: ${solAmount} SOL (${usdAmount.toFixed(2)})`);

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    usdAmount,
                    tokensChanged: tokenChanges.length
                };
            });

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            return null;
        }
    }

    analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];

        (meta.postTokenBalances || []).forEach((post) => {
            const pre = meta.preTokenBalances?.find(p =>
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );

            if (!pre) return;
            if (post.mint === WRAPPED_SOL_MINT) return;

            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            // Для покупок ожидаем положительное изменение токенов
            if (transactionType === 'buy' && rawChange <= 0) return;
            // Для продаж ожидаем отрицательное изменение токенов
            if (transactionType === 'sell' && rawChange >= 0) return;

            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange),
                decimals: post.uiTokenAmount.decimals,
            });
        });

        return tokenChanges;
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            // УСКОРЯЕМ получение метаданных токена
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
            if (!tokenInfo) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No metadata found for token ${tokenChange.mint}`);
                return;
            }

            const tokenUpsertQuery = `
                INSERT INTO tokens (mint, symbol, name, logo_uri, decimals) 
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;

            const tokenResult = await client.query(tokenUpsertQuery, [
                tokenChange.mint,
                tokenInfo.symbol,
                tokenInfo.name,
                tokenInfo.logoURI,
                tokenInfo.decimals
            ]);

            const tokenId = tokenResult.rows[0].id;
            const amount = tokenChange.rawChange / Math.pow(10, tokenChange.decimals);

            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;

            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);

            console.log(`[${new Date().toISOString()}] ✅ Saved token operation: ${transactionType} ${amount} ${tokenInfo.symbol}`);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error saving token operation for ${tokenChange.mint}:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name);
            console.log(`[${new Date().toISOString()}] ✅ Added wallet for monitoring: ${name || address.slice(0, 8)}...`);
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (wallet) {
                const transactions = await this.db.getRecentTransactions(24 * 7);
                const walletSignatures = transactions
                    .filter(tx => tx.wallet_address === address)
                    .map(tx => tx.signature);
                walletSignatures.forEach(sig => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet and associated data: ${address.slice(0, 8)}...`);
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            processedSignatures: this.processedSignatures.size,
            rpcEndpoint: this.connection.rpcEndpoint,
            stats: {
                ...this.stats,
                uptime: Date.now() - this.stats.startTime
            }
        };
    }

    async getDetailedStats() {
        try {
            const dbStats = await this.db.getMonitoringStats();
            const topTokens = await this.db.getTopTokens(5);
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async close() {
        this.stopMonitoring();
        await this.redis.quit();
        await this.db.close();
    }
}

module.exports = WalletMonitoringService;