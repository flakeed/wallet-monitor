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
        console.log(`[${new Date().toISOString()}] 🔧 SolanaWebSocketService initialized`);
    }

    async start(groupId = null) {
        if (this.isStarted) {
            console.log(`[${new Date().toISOString()}] 🔄 WebSocket service already started`);
            return;
        }
        console.log(`[${new Date().toISOString()}] 🚀 Starting Solana WebSocket client for ${this.wsUrl}${groupId ? ` for group ${groupId}` : ''}`);
        this.isStarted = true;
        await this.connect();
        await this.subscribeToWallets(groupId);
    }

    async connect() {
        if (this.isConnecting) {
            console.log(`[${new Date().toISOString()}] 🔌 Already attempting to connect to WebSocket`);
            return;
        }
        this.isConnecting = true;

        console.log(`[${new Date().toISOString()}] 🔌 Connecting to WebSocket: ${this.wsUrl}`);
        this.ws = new WebSocket(this.wsUrl, {
            handshakeTimeout: 10000,
            perMessageDeflate: false,
        });

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Solana WebSocket`);
            this.reconnectAttempts = 0;
            this.isConnecting = false;
            if (this.subscriptions.size > 0) {
                this.resubscribeAll();
            }
        });

        this.ws.on('message', async (data) => {
            this.messageCount++;
            try {
                const message = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] 📬 WebSocket message #${this.messageCount} received`);
                await this.handleMessage(message);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket message:`, error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
            this.isConnecting = false;
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isConnecting = false;
            if (this.isStarted) this.handleReconnect();
        });

        this.ws.on('ping', (data) => {
            console.log(`[${new Date().toISOString()}] 🏓 Received ping, sending pong`);
            this.ws.pong(data);
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.isConnecting = false;
                reject(new Error('Connection timeout'));
            }, 10000);
            this.ws.on('open', () => {
                clearTimeout(timeout);
                resolve();
            });
            this.ws.on('error', (error) => {
                clearTimeout(timeout);
                this.isConnecting = false;
                reject(error);
            });
        });
    }

    async handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts (${this.maxReconnectAttempts}) reached. Stopping.`);
            await this.stop();
            return;
        }

        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectInterval}ms`);
        setTimeout(async () => {
            try {
                await this.connect();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Reconnect failed:`, error.message);
                this.handleReconnect();
            }
        }, this.reconnectInterval);
    }

    async handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject, type } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            if (message.error) {
                console.error(`[${new Date().toISOString()}] ❌ Request ${type} failed:`, message.error.message);
                reject(new Error(message.error.message));
            } else {
                console.log(`[${new Date().toISOString()}] ✅ Request ${type} succeeded:`, message.result);
                resolve(message.result);
            }
            return;
        }

        if (message.method === 'logsNotification') {
            await this.handleLogsNotification(message.params);
        }
    }

    async handleLogsNotification(params) {
        const { result, subscription } = params;
        const walletAddress = this.findWalletBySubscription(subscription);
        if (!walletAddress) {
            console.warn(`[${new Date().toISOString()}] ⚠️ No wallet found for subscription ${subscription}`);
            return;
        }

        if (result.value && result.value.signature) {
            console.log(`[${new Date().toISOString()}] 🔍 New transaction detected for ${walletAddress.slice(0, 8)}...: ${result.value.signature}`);
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found in database`);
                return;
            }
            await this.monitoringService.processWebhookMessage({
                signature: result.value.signature,
                walletAddress,
                blockTime: result.value.timestamp || Math.floor(Date.now() / 1000),
            });
        }
    }

    findWalletBySubscription(subscriptionId) {
        for (const [wallet, subData] of this.subscriptions.entries()) {
            if (subData.logs === subscriptionId) {
                return wallet;
            }
        }
        return null;
    }

    async sendRequest(method, params, type) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
        }

        this.messageId++;
        const request = {
            jsonrpc: '2.0',
            id: this.messageId,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(this.messageId, { resolve, reject, type });
            this.ws.send(JSON.stringify(request), (error) => {
                if (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error sending ${type} request:`, error.message);
                    this.pendingRequests.delete(this.messageId);
                    reject(error);
                }
            });
        });
    }

    async subscribeToWallets(groupId = null) {
        try {
            const wallets = await this.db.getActiveWallets(groupId);
            if (wallets.length === 0) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No active wallets found${groupId ? ` for group ${groupId}` : ''}`);
                return;
            }

            if (wallets.length > this.maxSubscriptions) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet count (${wallets.length}) exceeds maximum (${this.maxSubscriptions})`);
                wallets.splice(this.maxSubscriptions);
            }
            console.log(`[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets${groupId ? ` for group ${groupId}` : ''}`);

            for (let i = 0; i < wallets.length; i += this.batchSize) {
                const batch = wallets.slice(i, i + this.batchSize);
                await Promise.all(
                    batch.map(async (wallet) => {
                        try {
                            await this.subscribeToWallet(wallet.address);
                        } catch (error) {
                            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${wallet.address.slice(0, 8)}...:`, error.message);
                        }
                    })
                );
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            console.log(`[${new Date().toISOString()}] ✅ Subscribed to all wallets${groupId ? ` for group ${groupId}` : ''}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallets:`, error.message);
            throw error;
        }
    }

    async subscribeToWallet(walletAddress) {
        if (this.subscriptions.size >= this.maxSubscriptions) {
            throw new Error(`Maximum subscription limit of ${this.maxSubscriptions} reached`);
        }
        try {
            new PublicKey(walletAddress); // Validate address
            if (this.subscriptions.has(walletAddress)) {
                console.log(`[${new Date().toISOString()}] ℹ️ Already subscribed to wallet ${walletAddress.slice(0, 8)}...`);
                return;
            }
            console.log(`[${new Date().toISOString()}] 🔔 Subscribing to wallet ${walletAddress.slice(0, 8)}...`);
            const logsSubscriptionId = await this.sendRequest('logsSubscribe', [
                { mentions: [walletAddress] },
                { commitment: 'confirmed' },
            ], 'logsSubscribe');
            this.subscriptions.set(walletAddress, { logs: logsSubscriptionId });
            console.log(`[${new Date().toISOString()}] ✅ Subscribed to wallet ${walletAddress.slice(0, 8)}... (logs: ${logsSubscriptionId})`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async unsubscribeFromWallet(walletAddress) {
        const subData = this.subscriptions.get(walletAddress);
        if (!subData) {
            console.log(`[${new Date().toISOString()}] ℹ️ No subscription found for wallet ${walletAddress.slice(0, 8)}...`);
            return;
        }

        try {
            if (subData.logs) {
                await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
                console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from logs for ${walletAddress.slice(0, 8)}...`);
            }
            this.subscriptions.delete(walletAddress);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from wallet ${walletAddress}:`, error.message);
        }
    }

    async resubscribeAll() {
        console.log(`[${new Date().toISOString()}] 🔄 Resubscribing to ${this.subscriptions.size} wallets`);
        const walletAddresses = Array.from(this.subscriptions.keys());
        this.subscriptions.clear();
        for (const walletAddress of walletAddresses) {
            try {
                await this.subscribeToWallet(walletAddress);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error resubscribing to wallet ${walletAddress.slice(0, 8)}...:`, error.message);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        console.log(`[${new Date().toISOString()}] ✅ Resubscribed to all wallets`);
    }

    async addWallet(walletAddress, name = null, groupId = null) {
        try {
            if (this.subscriptions.size >= this.maxSubscriptions) {
                throw new Error(`Cannot add wallet: Maximum limit of ${this.maxSubscriptions} wallets reached`);
            }
            const wallet = await this.monitoringService.addWallet(walletAddress, name, groupId);
            await this.subscribeToWallet(walletAddress);
            console.log(`[${new Date().toISOString()}] ✅ Added and subscribed to wallet ${walletAddress.slice(0, 8)}...${groupId ? ` in group ${groupId}` : ''}`);
            return wallet;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async removeWallet(walletAddress) {
        try {
            await this.unsubscribeFromWallet(walletAddress);
            await this.monitoringService.removeWallet(walletAddress);
            console.log(`[${new Date().toISOString()}] ✅ Removed wallet ${walletAddress.slice(0, 8)}...`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async stop() {
        if (!this.isStarted) {
            console.log(`[${new Date().toISOString()}] ℹ️ WebSocket service already stopped`);
            return;
        }
        this.isStarted = false;
        for (const walletAddress of this.subscriptions.keys()) {
            await this.unsubscribeFromWallet(walletAddress);
        }
        this.subscriptions.clear();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        console.log(`[${new Date().toISOString()}] ⏹️ WebSocket service stopped`);
    }

    getStatus() {
        return {
            isStarted: this.isStarted,
            isConnected: this.ws && this.ws.readyState === WebSocket.OPEN,
            subscriptionCount: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            rpcEndpoint: this.solanaRpc,
            wsEndpoint: this.wsUrl,
        };
    }
}

module.exports = SolanaWebSocketService;