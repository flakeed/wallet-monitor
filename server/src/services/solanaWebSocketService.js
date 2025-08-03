const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');

class SolanaWebSocketService {
    constructor() {
        this.solanaRpc=process.env.SOLANA_RPC_URL;
        this.rpcUrl = process.env.WEBHOOK_URL;
        this.wsUrl = this.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        this.connection = new Connection(this.solanaRpc, 'confirmed');
        this.monitoringService = new WalletMonitoringService();
        this.db = new Database();
        this.ws = null;
        this.subscriptions = new Map(); // wallet -> subscription id
        this.reconnectInterval = 5000;
        this.maxReconnectAttempts = 10;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.messageCount = 0;
    }

    async start() {
        console.log(`[${new Date().toISOString()}] 🚀 Starting Solana WebSocket client for ${this.wsUrl}`);
        await this.connect();
        await this.subscribeToWallets();
    }

    async connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Solana WebSocket at ${this.wsUrl}`);
            this.reconnectAttempts = 0;
            this.isConnecting = false;
        });

        this.ws.on('message', (data) => {
            this.messageCount++;
            console.log(`[${new Date().toISOString()}] WebSocket message #${this.messageCount} received`);
            
            try {
                const message = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] Parsed message:`, JSON.stringify(message, null, 2));
                this.handleMessage(message);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error parsing WebSocket message:`, error.message);
                console.log(`[${new Date().toISOString()}] Raw message:`, data.toString());
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isConnecting = false;
            this.handleReconnect();
        });

        return new Promise((resolve) => {
            this.ws.on('open', resolve);
        });
    }

    async handleMessage(message) {
        // Обрабатываем ответы на наши запросы
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject, type } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);

            if (message.error) {
                console.error(`[${new Date().toISOString()}] ❌ ${type} error:`, message.error);
                reject(new Error(message.error.message));
            } else {
                console.log(`[${new Date().toISOString()}] ✅ ${type} success:`, message.result);
                resolve(message.result);
            }
            return;
        }

        // Обрабатываем уведомления о подписках
        if (message.method === 'accountNotification') {
            await this.handleAccountNotification(message.params);
        } else if (message.method === 'signatureNotification') {
            await this.handleSignatureNotification(message.params);
        }
    }

    async handleAccountNotification(params) {
        try {
            const { result, subscription } = params;
            console.log(`[${new Date().toISOString()}] 📬 Account notification for subscription ${subscription}`);

            // Находим кошелек по subscription ID
            const walletAddress = this.findWalletBySubscription(subscription);
            if (!walletAddress) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No wallet found for subscription ${subscription}`);
                return;
            }

            const newLamports = result.value.lamports;
            console.log(`[${new Date().toISOString()}] 💰 Balance change detected for wallet ${walletAddress.slice(0, 8)}... New balance: ${newLamports / 1e9} SOL`);
            
            // Получаем последние транзакции для этого кошелька
            // Это нужно для получения signature транзакции, которая вызвала изменение баланса
            await this.checkRecentTransactions(walletAddress);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error handling account notification:`, error.message);
        }
    }

    async handleSignatureNotification(params) {
        try {
            const { result, subscription } = params;
            console.log(`[${new Date().toISOString()}] 📝 Signature notification:`, result);

            if (result.err) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Transaction failed:`, result.err);
                return;
            }

            // Здесь можно добавить дополнительную обработку уведомлений о подписях
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error handling signature notification:`, error.message);
        }
    }

    findWalletBySubscription(subscriptionId) {
        for (const [wallet, subData] of this.subscriptions.entries()) {
            if (typeof subData === 'object') {
                if (subData.account === subscriptionId || subData.logs === subscriptionId) {
                    return wallet;
                }
            } else if (subData === subscriptionId) {
                // Backward compatibility
                return wallet;
            }
        }
        return null;
    }

    async checkRecentTransactions(walletAddress) {
        try {
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found in database`);
                return;
            }

            console.log(`[${new Date().toISOString()}] 🔍 Checking recent transactions for ${walletAddress.slice(0, 8)}...`);
            
            const pubkey = new PublicKey(walletAddress);
            // Получаем только последние 3 транзакции - новые транзакции будут в начале списка
            const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 3 });

            let processedCount = 0;

            for (const sig of signatures) {
                if (!sig.signature || !sig.blockTime) continue;

                try {
                    // Проверяем, не обрабатывали ли мы уже эту транзакцию
                    const existingTx = await this.db.pool.query(
                        'SELECT id FROM transactions WHERE signature = $1',
                        [sig.signature]
                    );

                    if (existingTx.rows.length > 0) {
                        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature.slice(0, 20)}... already processed, skipping`);
                        continue; // Транзакция уже обработана
                    }

                    console.log(`[${new Date().toISOString()}] 🆕 Processing new transaction ${sig.signature.slice(0, 20)}...`);
                    
                    const txData = await this.monitoringService.processTransaction(sig, wallet);
                    if (txData) {
                        processedCount++;
                        console.log(`[${new Date().toISOString()}] ✅ Successfully processed ${txData.type} transaction: ${txData.solAmount} SOL (${txData.usdAmount.toFixed(2)})`);
                        
                        // Логируем детали токенов
                        if (txData.tokensChanged > 0) {
                            console.log(`[${new Date().toISOString()}] 🪙 ${txData.tokensChanged} token(s) ${txData.type === 'buy' ? 'bought' : 'sold'}`);
                        }
                    } else {
                        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature.slice(0, 20)}... was not a token operation`);
                    }
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature.slice(0, 20)}...:`, error.message);
                }

                // Добавляем задержку между обработкой транзакций чтобы не перегружать RPC
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (processedCount > 0) {
                console.log(`[${new Date().toISOString()}] 📊 Processed ${processedCount} new transaction(s) for ${walletAddress.slice(0, 8)}...`);
                // Обновляем статистику кошелька
                await this.db.updateWalletStats(wallet.id);
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error checking recent transactions for ${walletAddress}:`, error.message);
        }
    }

    async subscribeToWallets() {
        try {
            const wallets = await this.db.getActiveWallets();
            console.log(`[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets`);

            for (const wallet of wallets) {
                await this.subscribeToWallet(wallet.address);
                // Добавляем небольшую задержку между подписками
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`[${new Date().toISOString()}] ✅ Successfully subscribed to all wallets`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallets:`, error.message);
        }
    }

    async subscribeToWallet(walletAddress) {
        try {
            // Подписываемся на изменения аккаунта
            const accountSubscriptionId = await this.sendRequest('accountSubscribe', [
                walletAddress,
                { commitment: 'confirmed' }
            ], 'accountSubscribe');

            this.subscriptions.set(walletAddress, {
                account: accountSubscriptionId,
                logs: null // Можно добавить подписку на логи если нужно
            });

            console.log(`[${new Date().toISOString()}] ✅ Subscribed to wallet ${walletAddress.slice(0, 8)}... (account: ${accountSubscriptionId})`);

            return accountSubscriptionId;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async unsubscribeFromWallet(walletAddress) {
        try {
            const subData = this.subscriptions.get(walletAddress);
            if (!subData) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No subscription found for wallet ${walletAddress}`);
                return;
            }

            if (typeof subData === 'object') {
                // Новый формат с несколькими подписками
                if (subData.account) {
                    await this.sendRequest('accountUnsubscribe', [subData.account], 'accountUnsubscribe');
                    console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from account updates for ${walletAddress.slice(0, 8)}...`);
                }
                if (subData.logs) {
                    await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
                    console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from logs for ${walletAddress.slice(0, 8)}...`);
                }
            } else {
                // Старый формат - одна подписка
                await this.sendRequest('accountUnsubscribe', [subData], 'accountUnsubscribe');
                console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from wallet ${walletAddress.slice(0, 8)}...`);
            }

            this.subscriptions.delete(walletAddress);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from wallet ${walletAddress}:`, error.message);
        }
    }

    async addWallet(walletAddress, name = null) {
        try {
            // Добавляем кошелек в базу данных
            const wallet = await this.monitoringService.addWallet(walletAddress, name);
            
            // Подписываемся на обновления этого кошелька
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                await this.subscribeToWallet(walletAddress);
            }

            return wallet;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async removeWallet(walletAddress) {
        try {
            // Отписываемся от обновлений кошелька
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                await this.unsubscribeFromWallet(walletAddress);
            }

            // Удаляем кошелек из базы данных
            await this.monitoringService.removeWallet(walletAddress);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    sendRequest(method, params, type = method) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket is not connected'));
                return;
            }

            const id = ++this.messageId;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.pendingRequests.set(id, { resolve, reject, type });

            console.log(`[${new Date().toISOString()}] 📤 Sending ${type} request:`, JSON.stringify(request));
            this.ws.send(JSON.stringify(request));

            // Таймаут для запросов
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${type} (id: ${id}) timed out`));
                }
            }, 30000);
        });
    }

    async handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached. Stopping WebSocket client.`);
            return;
        }

        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectInterval}ms...`);

        setTimeout(async () => {
            try {
                await this.connect();
                // После переподключения заново подписываемся на все кошельки
                await this.subscribeToWallets();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Reconnect failed:`, error.message);
            }
        }, this.reconnectInterval);
    }

    getStatus() {
        const subscriptionDetails = Array.from(this.subscriptions.entries()).map(([addr, subData]) => {
            if (typeof subData === 'object') {
                return {
                    address: addr,
                    accountSubscription: subData.account,
                    logsSubscription: subData.logs
                };
            } else {
                return {
                    address: addr,
                    subscriptionId: subData
                };
            }
        });

        return {
            isConnected: this.ws && this.ws.readyState === WebSocket.OPEN,
            subscriptions: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            activeWallets: subscriptionDetails
        };
    }

    async stop() {
        console.log(`[${new Date().toISOString()}] ⏹️ Stopping Solana WebSocket client`);
        
        // Отписываемся от всех кошельков
        const unsubscribePromises = Array.from(this.subscriptions.keys()).map(
            walletAddress => this.unsubscribeFromWallet(walletAddress)
        );
        
        try {
            await Promise.all(unsubscribePromises);
            console.log(`[${new Date().toISOString()}] ✅ Successfully unsubscribed from all wallets`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error during unsubscribe:`, error.message);
        }

        if (this.ws) {
            this.ws.close();
        }

        await this.db.close();
    }
}

module.exports = SolanaWebSocketService;