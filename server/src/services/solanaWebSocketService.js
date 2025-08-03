const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const Database = require('../database/connection');
const { fastTokenService } = require('./fastTokenService');

class OptimizedSolanaWebSocketService {
    constructor() {
        this.solanaRpc = process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005';
        this.wsUrl = process.env.WEBHOOK_URL || 'ws://45.134.108.167:5006/ws';
        
        // Оптимизированное соединение с RPC
        this.connection = new Connection(this.solanaRpc, {
            commitment: 'confirmed',
            wsEndpoint: this.solanaRpc.replace('http', 'ws').replace('https', 'wss'),
            confirmTransactionInitialTimeout: 10000,
        });
        
        this.db = new Database();
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        
        // WebSocket для подключения к ноде
        this.ws = null;
        this.subscriptions = new Map(); // wallet -> subscriptionId
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.isStarted = false;
        
        // Кеш для быстрого доступа (минимальный, основной кеш в fastTokenService)
        this.walletCache = new Map();
        
        // Статистика
        this.stats = {
            messagesReceived: 0,
            transactionsProcessed: 0,
            startTime: Date.now(),
            lastTransaction: null
        };
        
        // Пул для обработки транзакций
        this.processingQueue = [];
        this.isProcessingQueue = false;
        
        console.log('🚀 Optimized Solana WebSocket Service initialized');
    }

    async start() {
        if (this.isStarted) {
            console.log('⚠️ Service already started');
            return;
        }

        console.log('🔌 Starting optimized WebSocket service...');
        this.isStarted = true;
        
        await this.connect();
        await this.loadWalletsCache();
        await this.subscribeToAllWallets();
        
        console.log('✅ Optimized WebSocket service started');
    }

    async connect() {
        return new Promise((resolve, reject) => {
            console.log(`🔗 Connecting to ${this.wsUrl}`);
            
            this.ws = new WebSocket(this.wsUrl);
            
            this.ws.on('open', () => {
                console.log('✅ WebSocket connected');
                resolve();
            });
            
            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });
            
            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
                reject(error);
            });
            
            this.ws.on('close', () => {
                console.log('🔌 WebSocket disconnected');
                if (this.isStarted) {
                    setTimeout(() => this.reconnect(), 1000);
                }
            });
        });
    }

    async handleMessage(data) {
        this.stats.messagesReceived++;
        
        try {
            const message = JSON.parse(data.toString());
            
            // Обработка ответов на запросы
            if (message.id && this.pendingRequests.has(message.id)) {
                const { resolve, reject } = this.pendingRequests.get(message.id);
                this.pendingRequests.delete(message.id);
                
                if (message.error) {
                    reject(new Error(message.error.message));
                } else {
                    resolve(message.result);
                }
                return;
            }
            
            // Обработка уведомлений о логах
            if (message.method === 'logsNotification') {
                await this.processLogsNotification(message.params);
            }
            
        } catch (error) {
            console.error('❌ Error handling message:', error.message);
        }
    }

    async processLogsNotification(params) {
        const { result, subscription } = params;
        const walletAddress = this.findWalletBySubscription(subscription);
        
        if (!walletAddress) {
            console.warn(`⚠️ Unknown subscription: ${subscription}`);
            return;
        }

        if (result.value && result.value.signature) {
            // Добавляем в очередь для быстрой обработки
            this.processingQueue.push({
                signature: result.value.signature,
                walletAddress,
                timestamp: Date.now()
            });
            
            // Запускаем обработку если не активна
            if (!this.isProcessingQueue) {
                setImmediate(() => this.processTransactionQueue());
            }
        }
    }

    async processTransactionQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
        
        while (this.processingQueue.length > 0) {
            const batch = this.processingQueue.splice(0, 5); // Обрабатываем батчами
            
            await Promise.all(batch.map(async (item) => {
                try {
                    await this.processTransaction(item);
                } catch (error) {
                    console.error(`❌ Error processing transaction ${item.signature}:`, error.message);
                }
            }));
        }
        
        this.isProcessingQueue = false;
    }

    async processTransaction({ signature, walletAddress, timestamp }) {
        const startTime = Date.now();
        
        try {
            // Проверяем, не обработана ли уже транзакция
            const exists = await this.redis.exists(`tx:${signature}`);
            if (exists) {
                console.log(`⏭️ Transaction ${signature} already processed`);
                return;
            }
            
            // Быстрое получение транзакции
            const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            
            if (!tx || !tx.meta) {
                console.warn(`⚠️ Invalid transaction: ${signature}`);
                return;
            }
            
            // Анализ изменений SOL
            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            
            if (Math.abs(solChange) < 0.001) {
                console.log(`⏭️ Minimal SOL change: ${signature}`);
                return;
            }
            
            const transactionType = solChange < 0 ? 'buy' : 'sell';
            const solAmount = Math.abs(solChange);
            
            // Быстрый анализ токенов
            const tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType);
            
            if (tokenChanges.length === 0) {
                console.log(`⏭️ No token changes: ${signature}`);
                return;
            }
            
            // Получаем цену SOL из быстрого сервиса
            const solPrice = await fastTokenService.getSolPrice();
            const usdAmount = solPrice * solAmount;
            
            // Создаем объект транзакции для фронтенда
            const transactionData = {
                signature,
                walletAddress,
                walletName: this.walletCache.get(walletAddress)?.name || null,
                transactionType,
                solAmount: solAmount.toFixed(6),
                usdAmount: usdAmount.toFixed(2),
                tokens: tokenChanges.map(tc => ({
                    mint: tc.mint,
                    symbol: tc.symbol,
                    name: tc.name,
                    amount: (tc.rawChange / Math.pow(10, tc.decimals)).toFixed(tc.decimals),
                    logoURI: tc.logoURI
                })),
                timestamp: new Date(tx.blockTime * 1000).toISOString(),
                processingTime: Date.now() - startTime
            };
            
            // Сохраняем в базу данных (асинхронно)
            setImmediate(() => this.saveTransactionToDb(transactionData, tx.blockTime));
            
            // Отправляем в Redis для фронтенда (приоритет)
            await this.redis.publish('transactions', JSON.stringify(transactionData));
            
            // Кешируем обработанную транзакцию
            await this.redis.setex(`tx:${signature}`, 3600, '1');
            
            this.stats.transactionsProcessed++;
            this.stats.lastTransaction = transactionData;
            
            console.log(`✅ Processed ${signature} in ${Date.now() - startTime}ms`);
            
        } catch (error) {
            console.error(`❌ Error processing transaction ${signature}:`, error.message);
        }
    }

    async analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
        
        for (const post of meta.postTokenBalances || []) {
            const pre = meta.preTokenBalances?.find(p => 
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );
            
            if (!pre || post.mint === WRAPPED_SOL_MINT) continue;
            
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            // Проверяем направление изменения
            if ((transactionType === 'buy' && rawChange <= 0) || 
                (transactionType === 'sell' && rawChange >= 0)) {
                continue;
            }
            
            // Получаем метаданные токена
            // Получаем метаданные токена через быстрый сервис
            const tokenInfo = await fastTokenService.getTokenMetadata(post.mint);
            
            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange),
                decimals: post.uiTokenAmount.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
                logoURI: tokenInfo.logoURI
            });
        }
        
        return tokenChanges;
    }

    async saveTransactionToDb(transactionData, blockTime) {
        try {
            const wallet = this.walletCache.get(transactionData.walletAddress);
            if (!wallet) return;
            
            await this.db.withTransaction(async (client) => {
                // Сохраняем транзакцию
                const txQuery = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        sol_spent, usd_spent, sol_received, usd_received
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id
                `;
                
                const solAmount = parseFloat(transactionData.solAmount);
                const usdAmount = parseFloat(transactionData.usdAmount);
                
                const result = await client.query(txQuery, [
                    wallet.id,
                    transactionData.signature,
                    new Date(blockTime * 1000),
                    transactionData.transactionType,
                    transactionData.transactionType === 'buy' ? solAmount : 0,
                    transactionData.transactionType === 'buy' ? usdAmount : 0,
                    transactionData.transactionType === 'sell' ? solAmount : 0,
                    transactionData.transactionType === 'sell' ? usdAmount : 0
                ]);
                
                const transactionId = result.rows[0].id;
                
                // Сохраняем токены
                for (const token of transactionData.tokens) {
                    await this.saveTokenOperation(client, transactionId, token, transactionData.transactionType);
                }
            });
            
        } catch (error) {
            console.error(`❌ Error saving transaction to DB:`, error.message);
        }
    }

    async saveTokenOperation(client, transactionId, token, operationType) {
        try {
            // Добавляем/обновляем токен
            const tokenQuery = `
                INSERT INTO tokens (mint, symbol, name, logo_uri, decimals)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;
            
            const tokenResult = await client.query(tokenQuery, [
                token.mint,
                token.symbol,
                token.name,
                token.logoURI,
                6 // default decimals
            ]);
            
            const tokenId = tokenResult.rows[0].id;
            
            // Добавляем операцию
            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type)
                VALUES ($1, $2, $3, $4)
            `;
            
            await client.query(operationQuery, [
                transactionId,
                tokenId,
                parseFloat(token.amount),
                operationType
            ]);
            
        } catch (error) {
            console.error('❌ Error saving token operation:', error.message);
        }
    }

    async loadWalletsCache() {
        try {
            const wallets = await this.db.getActiveWallets();
            console.log(`📋 Loading ${wallets.length} wallets into cache`);
            
            this.walletCache.clear();
            for (const wallet of wallets) {
                this.walletCache.set(wallet.address, wallet);
            }
            
            console.log(`✅ Loaded ${this.walletCache.size} wallets into cache`);
        } catch (error) {
            console.error('❌ Error loading wallets cache:', error.message);
        }
    }

    async subscribeToAllWallets() {
        console.log(`🔔 Subscribing to ${this.walletCache.size} wallets`);
        
        for (const [address] of this.walletCache) {
            await this.subscribeToWallet(address);
        }
        
        console.log(`✅ Subscribed to all wallets`);
    }

    async subscribeToWallet(walletAddress) {
        try {
            const subscriptionId = await this.sendRequest('logsSubscribe', [
                { mentions: [walletAddress] },
                { commitment: 'confirmed' }
            ]);
            
            this.subscriptions.set(walletAddress, subscriptionId);
            console.log(`✅ Subscribed to ${walletAddress.slice(0, 8)}... (${subscriptionId})`);
            
        } catch (error) {
            console.error(`❌ Error subscribing to ${walletAddress}:`, error.message);
        }
    }

    async addWallet(address, name = null) {
        try {
            // Валидация адреса
            new PublicKey(address);
            
            // Добавляем в базу
            const wallet = await this.db.addWallet(address, name);
            
            // Добавляем в кеш
            this.walletCache.set(address, wallet);
            
            // Подписываемся на события
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                await this.subscribeToWallet(address);
            }
            
            console.log(`✅ Added wallet: ${name || address.slice(0, 8)}...`);
            return wallet;
            
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            // Отписываемся от событий
            const subscriptionId = this.subscriptions.get(address);
            if (subscriptionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
                await this.sendRequest('logsUnsubscribe', [subscriptionId]);
                this.subscriptions.delete(address);
            }
            
            // Удаляем из кеша
            this.walletCache.delete(address);
            
            // Удаляем из базы
            await this.db.removeWallet(address);
            
            console.log(`✅ Removed wallet: ${address.slice(0, 8)}...`);
            
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    findWalletBySubscription(subscriptionId) {
        for (const [address, subId] of this.subscriptions) {
            if (subId === subscriptionId) {
                return address;
            }
        }
        return null;
    }

    sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }
            
            const id = ++this.messageId;
            this.pendingRequests.set(id, { resolve, reject });
            
            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params
            }));
            
            // Timeout
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 10000);
        });
    }

    async reconnect() {
        if (!this.isStarted) return;
        
        console.log('🔄 Reconnecting...');
        
        try {
            await this.connect();
            await this.subscribeToAllWallets();
            console.log('✅ Reconnected successfully');
        } catch (error) {
            console.error('❌ Reconnection failed:', error.message);
            setTimeout(() => this.reconnect(), 2000);
        }
    }

    getStatus() {
        return {
            isConnected: this.ws && this.ws.readyState === WebSocket.OPEN,
            isStarted: this.isStarted,
            subscriptions: this.subscriptions.size,
            cachedWallets: this.walletCache.size,
            tokenServiceStats: fastTokenService.getStats(),
            stats: {
                ...this.stats,
                uptime: Date.now() - this.stats.startTime,
                queueLength: this.processingQueue.length
            }
        };
    }

    async stop() {
        console.log('⏹️ Stopping service...');
        
        this.isStarted = false;
        
        // Отписываемся от всех событий
        for (const [address] of this.subscriptions) {
            try {
                const subscriptionId = this.subscriptions.get(address);
                if (subscriptionId && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    await this.sendRequest('logsUnsubscribe', [subscriptionId]);
                }
            } catch (error) {
                console.error(`❌ Error unsubscribing from ${address}:`, error.message);
            }
        }
        
        // Закрываем соединения
        if (this.ws) {
            this.ws.close();
        }
        
        await this.redis.quit();
        await this.db.close();
        await fastTokenService.close();
        
        console.log('✅ Service stopped');
    }
}

module.exports = OptimizedSolanaWebSocketService;