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
        this.isStarted = true;
        this.activeGroupId = groupId;
        await this.connect();
        await this.subscribeToWallets();
    }

    async connect() {
        if (this.isConnecting) return;
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
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isConnecting = false;
            if (this.isStarted) this.handleReconnect();
        });

        this.ws.on('ping', (data) => {
            this.ws.pong(data);
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
            this.ws.on('open', () => { clearTimeout(timeout); resolve(); });
            this.ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
        });
    }

    async handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject, type } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            if (message.error) {
                reject(new Error(message.error.message));
            } else {
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
            console.log(`[${new Date().toISOString()}] 🔍 New transaction detected: ${result.value.signature}`);
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
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

    async subscribeToWallets() {
        const wallets = this.activeGroupId
            ? await this.db.getWalletsByGroup(this.activeGroupId)
            : await this.db.getActiveWallets();
        if (wallets.length > this.maxSubscriptions) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet count (${wallets.length}) exceeds maximum (${this.maxSubscriptions})`);
            wallets.splice(this.maxSubscriptions);
        }
        console.log(`[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets for group ${this.activeGroupId || 'all'}`);

        // Unsubscribe from existing subscriptions
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

    async subscribeToWallet(walletAddress) {
        if (this.subscriptions.size >= this.maxSubscriptions) {
            throw new Error(`Maximum subscription limit of ${this.maxSubscriptions} reached`);
        }
        try {
            console.log(`[${new Date().toISOString()}] 🔔 Subscribing to wallet ${walletAddress.slice(0, 8)}...`);
            const logsSubscriptionId = await this.sendRequest('logsSubscribe', [
                { mentions: [walletAddress] },
                { commitment: 'confirmed' },
            ], 'logsSubscribe');
            this.subscriptions.set(walletAddress, { logs: logsSubscriptionId });
            console.log(`[${new Date().toISOString()}] ✅ Subscribed to wallet ${walletAddress.slice(0, 8)}... (logs: ${logsSubscriptionId})`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${walletAddress}:`, error.message);
        }
    }

    async unsubscribeFromWallet(walletAddress) {
        const subData = this.subscriptions.get(walletAddress);
        if (!subData) return;

        if (subData.logs) {
            await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
            console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from logs for ${walletAddress.slice(0, 8)}...`);
        }
        this.subscriptions.delete(walletAddress);
    }

    async addWallet(walletAddress, name = null, groupId = null) {
        try {
            if (this.subscriptions.size >= this.maxSubscriptions) {
                throw new Error(`Cannot add wallet: Maximum limit of ${this.maxSubscriptions} wallets reached`);
            }
            const wallet = await this.monitoringService.addWallet(walletAddress, name, groupId);
            if (this.ws && this.ws.readyState === WebSocket.OPEN && (!this.activeGroupId || this.activeGroupId === groupId)) {
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
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                await this.unsubscribeFromWallet(walletAddress);
            }
            await this.monitoringService.removeWallet(walletAddress);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async removeAllWallets() {
        try {
            console.log(`[${new Date().toISOString()}] 🗑️ Removing all wallet subscriptions from WebSocket service`);
            for (const walletAddress of this.subscriptions.keys()) {
                await this.unsubscribeFromWallet(walletAddress);
            }
            this.subscriptions.clear();
            await this.monitoringService.removeAllWallets();
            console.log(`[${new Date().toISOString()}] ✅ All wallet subscriptions removed from WebSocket service`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets from WebSocket service:`, error.message);
            throw error;
        }
    }

    sendRequest(method, params, type) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket is not connected'));
                return;
            }

            const id = ++this.messageId;
            this.pendingRequests.set(id, { resolve, reject, type });
            this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${type} (id: ${id}) timed out`));
                }
            }, 60000);
        });
    }

    async handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached`);
            this.isStarted = false;
            return;
        }

        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(async () => {
            try {
                await this.connect();
                await this.subscribeToWallets();
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Reconnect failed:`, error.message);
            }
        }, this.reconnectInterval);
    }

    getStatus() {
        const subscriptionDetails = Array.from(this.subscriptions.entries()).map(([addr, subData]) => ({
            address: addr,
            logsSubscription: subData.logs,
        }));

        return {
            isConnected: this.ws && this.ws.readyState === WebSocket.OPEN,
            isStarted: this.isStarted,
            subscriptions: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            wsUrl: this.wsUrl,
            rpcUrl: this.solanaRpc,
            activeGroupId: this.activeGroupId,
            activeWallets: subscriptionDetails,
        };
    }

    async stop() {
        this.isStarted = false;
        this.activeGroupId = null;
        for (const walletAddress of this.subscriptions.keys()) {
            await this.unsubscribeFromWallet(walletAddress);
        }
        if (this.ws) this.ws.close();
        await this.db.close();
        console.log(`[${new Date().toISOString()}] ⏹️ WebSocket client stopped`);
    }
}

module.exports = SolanaWebSocketService;