const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const WS_READY_STATE_CLOSED = 3;

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
        this.maxSubscriptions = 10000;
        this.activeGroupId = null;
        this.activeUserId = null;
    }

    async start(groupId = null, userId = null) {
        if (this.isStarted && this.activeGroupId === groupId && this.activeUserId === userId) {
            console.log(`[${new Date().toISOString()}] 🔄 WebSocket service already started for group ${groupId || 'all'} and user ${userId || 'all'}`);
            return;
        }
        console.log(`[${new Date().toISOString()}] 🚀 Starting Solana WebSocket client for ${this.wsUrl}${groupId ? `, group ${groupId}` : ''}${userId ? `, user ${userId}` : ''}`);
        this.isStarted = true;
        this.activeGroupId = groupId;
        this.activeUserId = userId;
        try {
            await this.connect();
            await this.subscribeToWallets();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to start WebSocket service:`, error.message);
            this.isStarted = false;
            throw error;
        }
    }

    async connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WS_READY_STATE_OPEN)) return;
        this.isConnecting = true;

        console.log(`[${new Date().toISOString()}] 🔌 Connecting to WebSocket: ${this.wsUrl}`);
        
        try {
            this.ws?.close(); // Ensure previous connection is closed
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
                    await this.handleMessage(message);
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket message:`, error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
                this.handleReconnect();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
                this.isConnecting = false;
                if (this.isStarted) this.handleReconnect();
            });

            this.ws.on('ping', (data) => {
                this.ws.pong(data);
            });

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
                this.ws.on('open', () => { clearTimeout(timeout); resolve(); });
                this.ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to create WebSocket connection:`, error.message);
            this.isConnecting = false;
            throw error;
        }
    }

    async handleMessage(message) {
        if (!message || typeof message !== 'object') {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid message format`);
            return;
        }

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
        if (!params?.result || !params.subscription) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Invalid logs notification params`);
            return;
        }
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
            
            if (this.activeUserId && wallet.user_id !== this.activeUserId) {
                console.log(`[${new Date().toISOString()}] ℹ️ Skipping transaction for wallet ${walletAddress} (not in active user ${this.activeUserId})`);
                return;
            }
            
            if (this.activeGroupId && wallet.group_id !== this.activeGroupId) {
                console.log(`[${new Date().toISOString()}] ℹ️ Skipping transaction for wallet ${walletAddress} (not in active group ${this.activeGroupId})`);
                return;
            }
            
            await this.monitoringService.processWebhookMessage({
                signature: result.value.signature,
                walletAddress,
                blockTime: result.value.timestamp || Math.floor(Date.now() / 1000),
                userId: wallet.user_id,
                groupId: wallet.group_id
            });
        }
    }

    findWalletBySubscription(subscriptionId) {
        return Array.from(this.subscriptions.entries()).find(([_, subData]) => subData.logs === subscriptionId)?.[0] || null;
    }

    async subscribeToWallets() {
        this.subscriptions.clear();
        const wallets = await this.db.getActiveWallets(this.activeGroupId, this.activeUserId);
        
        if (wallets.length > this.maxSubscriptions) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet count (${wallets.length}) exceeds maximum (${this.maxSubscriptions})`);
            wallets.length = this.maxSubscriptions; // Truncate array
        }
        
        console.log(`[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets for user ${this.activeUserId}${this.activeGroupId ? `, group ${this.activeGroupId}` : ''}`);
        if (wallets.length > 0) {
            console.log(`[${new Date().toISOString()}] 🔍 Sample wallets to subscribe:`);
            wallets.slice(0, 3).forEach(wallet => {
                console.log(`  - ${wallet.address.slice(0, 8)}... (user: ${wallet.user_id}, group: ${wallet.group_id})`);
            });
        }
    
        for (let i = 0; i < wallets.length; i += this.batchSize) {
            const batch = wallets.slice(i, i + this.batchSize);
            await Promise.all(batch.map(wallet => this.subscribeToWallet(wallet.address)));
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`[${new Date().toISOString()}] ✅ Subscribed to ${this.subscriptions.size} wallets for user ${this.activeUserId}${this.activeGroupId ? `, group ${this.activeGroupId}` : ''}`);
    }

    async subscribeToWallet(walletAddress) {
        if (this.subscriptions.size >= this.maxSubscriptions) {
            throw new Error(`Maximum subscription limit of ${this.maxSubscriptions} reached`);
        }
        
        if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Cannot subscribe to wallet ${walletAddress.slice(0, 8)}... - WebSocket not connected`);
            return;
        }
        
        try {
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
        if (!subData?.logs || !this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) return;

        try {
            await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
            console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from logs for ${walletAddress.slice(0, 8)}...`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from ${walletAddress}:`, error.message);
        }
        this.subscriptions.delete(walletAddress);
    }

    async addWallet(walletAddress, name = null, groupId = null, userId = null) {
        try {
            if (this.subscriptions.size >= this.maxSubscriptions) {
                throw new Error(`Cannot add wallet: Maximum limit of ${this.maxSubscriptions} wallets reached`);
            }
            
            const wallet = await this.monitoringService.addWallet(walletAddress, name, groupId, userId);
            if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN && 
                (!this.activeGroupId || wallet.group_id === this.activeGroupId) &&
                (!this.activeUserId || wallet.user_id === this.activeUserId)) {
                await this.subscribeToWallet(walletAddress);
            }
            return wallet;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async removeWallet(walletAddress, userId = null) {
        try {
            if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                await this.unsubscribeFromWallet(walletAddress);
            }
            await this.monitoringService.removeWallet(walletAddress, userId);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    async removeAllWallets(groupId = null, userId = null) {
        try {
            if ((!groupId || groupId === this.activeGroupId) && (!userId || userId === this.activeUserId)) {
                for (const walletAddress of this.subscriptions.keys()) {
                    await this.unsubscribeFromWallet(walletAddress);
                }
                this.subscriptions.clear();
            }
            await this.monitoringService.removeAllWallets(groupId, userId);
            if ((groupId && groupId === this.activeGroupId) || (userId && userId === this.activeUserId)) {
                await this.subscribeToWallets();
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets from WebSocket service:`, error.message);
            throw error;
        }
    }

    async switchGroup(groupId, userId = null) {
        try {
            await this.stop();
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.start(groupId, userId);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error switching group:`, error.message);
            throw error;
        }
    }

    sendRequest(method, params, type) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) {
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

        await new Promise(resolve => setTimeout(resolve, this.reconnectInterval));
        try {
            await this.connect();
            await this.subscribeToWallets();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Reconnect failed:`, error.message);
        }
    }

    async addWalletsBatch(wallets) {
        const addedWallets = [];
        const errors = [];
      
        try {
          const dbWallets = wallets.map(w => ({
            address: w.address,
            name: w.name,
            groupId: w.groupId,
            userId: w.userId
          }));
      
          const insertedWallets = await this.db.addWalletsBatch(dbWallets);
          
          for (const wallet of insertedWallets) {
            if ((!this.activeGroupId || wallet.group_id === this.activeGroupId) &&
                (!this.activeUserId || wallet.user_id === this.activeUserId)) {
              addedWallets.push(wallet);
              if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                await this.subscribeToWallet(wallet.address).catch(err => errors.push(err.message));
              }
            }
          }
      
          return { addedWallets, errors };
        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ Batch wallet add error:`, error.message);
          throw error;
        }
    }

    getStatus() {
        return {
            isConnected: this.ws && this.ws.readyState === WS_READY_STATE_OPEN,
            isStarted: this.isStarted,
            activeGroupId: this.activeGroupId,
            activeUserId: this.activeUserId,
            subscriptions: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            wsUrl: this.wsUrl,
            rpcUrl: this.solanaRpc,
        };
    }

    async stop() {
        this.isStarted = false;
        for (const walletAddress of this.subscriptions.keys()) {
            await this.unsubscribeFromWallet(walletAddress).catch(() => {});
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        console.log(`[${new Date().toISOString()}] ⏹️ WebSocket client stopped`);
    }

    async shutdown() {
        await this.stop();
        await this.db.close().catch(() => {});
        console.log(`[${new Date().toISOString()}] ✅ WebSocket service shutdown complete`);
    }
}

module.exports = SolanaWebSocketService;