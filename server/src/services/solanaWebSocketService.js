const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');

class SolanaWebSocketService {
    constructor() {
        this.solanaRpc = process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005';
        this.wsUrl = process.env.WEBHOOK_URL || 'ws://45.134.108.167:5006/ws';
        this.connection = new Connection(this.solanaRpc, {
            commitment: 'confirmed',
            wsEndpoint: this.wsUrl,
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.monitoringService = new WalletMonitoringService();
        this.db = new Database();
        this.ws = null;
        this.subscriptions = new Map();
        this.reconnectInterval = 3000;
        this.maxReconnectAttempts = 20;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.messageCount = 0;
        this.isStarted = false;
        this.batchSize = 400;
        this.maxSubscriptions = 1000;
        this.activeGroupId = null;
    }

    async start(groupId = null) {
        if (this.isStarted && this.activeGroupId === groupId) {
            console.log(`[${new Date().toISOString()}] 🔄 WebSocket service already started for group ${groupId || 'all'}`);
            return;
        }
        console.log(`[${new Date().toISOString()}] 🚀 Starting Solana WebSocket client for ${this.wsUrl}, group: ${groupId || 'all'}`);
        this.activeGroupId = groupId;
        this.isStarted = true;
        this.isConnecting = true;
        await this.connect();
        await this.subscribeToWallets();
        this.isConnecting = false;
    }

    async stop() {
        if (!this.isStarted) {
            console.log(`[${new Date().toISOString()}] 🛑 WebSocket service is not running`);
            return;
        }
        console.log(`[${new Date().toISOString()}] 🛑 Stopping Solana WebSocket client`);
        this.isStarted = false;
        await this.closeWebSocket();
        this.subscriptions.clear();
        this.messageCount = 0;
        this.activeGroupId = null;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                console.log(`[${new Date().toISOString()}] 🔌 WebSocket already connected`);
                resolve();
                return;
            }

            console.log(`[${new Date().toISOString()}] 🔌 Connecting to WebSocket: ${this.wsUrl}`);
            this.ws = new WebSocket(this.wsUrl);

            this.ws.on('open', () => {
                console.log(`[${new Date().toISOString()}] ✅ WebSocket connected`);
                this.reconnectAttempts = 0;
                resolve();
            });

            this.ws.on('message', async (data) => {
                this.messageCount++;
                try {
                    const message = JSON.parse(data.toString());
                    await this.handleMessage(message);
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error processing WebSocket message:`, error);
                }
            });

            this.ws.on('close', () => {
                console.log(`[${new Date().toISOString()}] 🔌 WebSocket disconnected`);
                if (this.isStarted && !this.isConnecting) {
                    this.handleReconnect();
                }
            });

            this.ws.on('error', (error) => {
                console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
                if (!this.isConnecting) {
                    reject(error);
                }
            });
        });
    }

    async handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] 🛑 Max reconnect attempts reached`);
            await this.stop();
            return;
        }

        this.reconnectAttempts++;
        console.log(
            `[${new Date().toISOString()}] ⏳ Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectInterval / 1000} seconds`
        );

        setTimeout(async () => {
            try {
                this.isConnecting = true;
                await this.connect();
                await this.subscribeToWallets();
                this.isConnecting = false;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Reconnect attempt failed:`, error.message);
                this.handleReconnect();
            }
        }, this.reconnectInterval);
    }

    async handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            resolve(message);
            return;
        }

        if (message.method === 'accountNotification') {
            const { walletAddress, signature, blockTime, transactionType, solAmount, tokens } = message.params;
            await this.monitoringService.processTransaction({
                walletAddress,
                signature,
                blockTime,
                transactionType,
                solAmount,
                tokens,
            });
        }
    }

    async subscribeToWallet(walletAddress) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket not open, cannot subscribe to ${walletAddress}`);
            return;
        }

        if (this.subscriptions.has(walletAddress)) {
            console.log(`[${new Date().toISOString()}] ℹ️ Already subscribed to ${walletAddress}`);
            return;
        }

        try {
            const publicKey = new PublicKey(walletAddress);
            const messageId = ++this.messageId;
            const subscribeMessage = {
                jsonrpc: '2.0',
                id: messageId,
                method: 'accountSubscribe',
                params: [walletAddress, { commitment: 'confirmed' }],
            };

            return new Promise((resolve, reject) => {
                this.pendingRequests.set(messageId, { resolve, reject });
                this.ws.send(JSON.stringify(subscribeMessage));
                console.log(`[${new Date().toISOString()}] 📩 Sent subscription request for ${walletAddress}`);

                setTimeout(() => {
                    if (this.pendingRequests.has(messageId)) {
                        this.pendingRequests.delete(messageId);
                        reject(new Error(`Subscription timeout for ${walletAddress}`));
                    }
                }, 10000);
            })
                .then((response) => {
                    if (response.error) {
                        throw new Error(response.error.message);
                    }
                    this.subscriptions.set(walletAddress, response.result);
                    console.log(`[${new Date().toISOString()}] ✅ Subscribed to ${walletAddress}`);
                })
                .catch((error) => {
                    console.error(`[${new Date().toISOString()}] ❌ Failed to subscribe to ${walletAddress}:`, error.message);
                });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Invalid public key ${walletAddress}:`, error.message);
        }
    }

    async unsubscribeFromWallet(walletAddress) {
        if (!this.subscriptions.has(walletAddress)) {
            console.log(`[${new Date().toISOString()}] ℹ️ Not subscribed to ${walletAddress}`);
            return;
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket not open, clearing subscription for ${walletAddress}`);
            this.subscriptions.delete(walletAddress);
            return;
        }

        try {
            const subscriptionId = this.subscriptions.get(walletAddress);
            const messageId = ++this.messageId;
            const unsubscribeMessage = {
                jsonrpc: '2.0',
                id: messageId,
                method: 'accountUnsubscribe',
                params: [subscriptionId],
            };

            return new Promise((resolve, reject) => {
                this.pendingRequests.set(messageId, { resolve, reject });
                this.ws.send(JSON.stringify(unsubscribeMessage));
                console.log(`[${new Date().toISOString()}] 📩 Sent unsubscribe request for ${walletAddress}`);

                setTimeout(() => {
                    if (this.pendingRequests.has(messageId)) {
                        this.pendingRequests.delete(messageId);
                        reject(new Error(`Unsubscribe timeout for ${walletAddress}`));
                    }
                }, 10000);
            })
                .then((response) => {
                    if (response.error) {
                        throw new Error(response.error.message);
                    }
                    this.subscriptions.delete(walletAddress);
                    console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from ${walletAddress}`);
                })
                .catch((error) => {
                    console.error(`[${new Date().toISOString()}] ❌ Failed to unsubscribe from ${walletAddress}:`, error.message);
                    this.subscriptions.delete(walletAddress);
                });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from ${walletAddress}:`, error.message);
            this.subscriptions.delete(walletAddress);
        }
    }

    async subscribeToWallets() {
        const wallets = this.activeGroupId
            ? await this.db.getWalletsByGroup(this.activeGroupId)
            : await this.db.getActiveWallets();
        if (wallets.length > this.maxSubscriptions) {
            console.warn(
                `[${new Date().toISOString()}] ⚠️ Wallet count (${wallets.length}) exceeds maximum (${this.maxSubscriptions})`
            );
            wallets.splice(this.maxSubscriptions);
        }
        console.log(
            `[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets for group ${this.activeGroupId || 'all'}`
        );

        for (const walletAddress of this.subscriptions.keys()) {
            await this.unsubscribeFromWallet(walletAddress);
        }
        this.subscriptions.clear();

        for (let i = 0; i < wallets.length; i += this.batchSize) {
            const batch = wallets.slice(i, i + this.batchSize);
            await Promise.all(
                batch.map(async (wallet) => {
                    await this.subscribeToWallet(wallet.address);
                })
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        console.log(`[${new Date().toISOString()}] ✅ Subscribed to all wallets for group ${this.activeGroupId || 'all'}`);
    }

    async addWallet(address, name = null, groupId) {
        try {
            const wallet = await this.db.addWallet(address, name, groupId);
            if (this.isStarted && (!this.activeGroupId || this.activeGroupId === groupId)) {
                await this.subscribeToWallet(address);
            }
            return wallet;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet ${address}:`, error);
            throw error;
        }
    }

    async removeWallet(address) {
        try {
            await this.unsubscribeFromWallet(address);
            const wallet = await this.db.getWalletByAddress(address);
            if (!wallet) {
                throw new Error('Wallet not found');
            }
            await this.db.removeWallet(address);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${address}:`, error);
            throw error;
        }
    }

    async removeAllWallets() {
        try {
            for (const walletAddress of this.subscriptions.keys()) {
                await this.unsubscribeFromWallet(walletAddress);
            }
            this.subscriptions.clear();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
            throw error;
        }
    }

    getStatus() {
        return {
            isConnected: this.ws ? this.ws.readyState === WebSocket.OPEN : false,
            subscriptionCount: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            isStarted: this.isStarted,
            activeGroupId: this.activeGroupId,
        };
    }

    async closeWebSocket() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket connection closed`);
        }
    }
}

module.exports = SolanaWebSocketService;