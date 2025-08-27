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
        this.maxSubscriptions = 100000;
        this.activeGroupId = null; // Remove activeUserId - now global
    }

    // UPDATED: Start method - no user context needed
    async start(groupId = null) {
        if (this.isStarted && this.activeGroupId === groupId) {
            console.log(`[${new Date().toISOString()}] 🔄 Global WebSocket service already started${groupId ? ` for group ${groupId}` : ''}`);
            return;
        }
        console.log(`[${new Date().toISOString()}] 🚀 Starting Global Solana WebSocket client for ${this.wsUrl}${groupId ? `, group ${groupId}` : ''}`);
        this.isStarted = true;
        this.activeGroupId = groupId;
        try {
            await this.connect();
            await this.subscribeToWallets();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Failed to start global WebSocket service:`, error.message);
            this.isStarted = false;
            throw error;
        }
    }

    async connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WS_READY_STATE_OPEN)) return;
        this.isConnecting = true;

        console.log(`[${new Date().toISOString()}] 🔌 Connecting to WebSocket: ${this.wsUrl}`);
        
        try {
            this.ws?.close();
            this.ws = new WebSocket(this.wsUrl, {
                handshakeTimeout: 10000,
                perMessageDeflate: false,
            });

            this.ws.on('open', () => {
                console.log(`[${new Date().toISOString()}] ✅ Connected to Global Solana WebSocket`);
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

    // UPDATED: Handle logs without user filtering
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
            console.log(`[${new Date().toISOString()}] 🔍 New global transaction detected: ${result.value.signature}`);
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found in global database`);
                return;
            }
            
            // Only filter by active group if one is set
            if (this.activeGroupId && wallet.group_id !== this.activeGroupId) {
                console.log(`[${new Date().toISOString()}] ℹ️ Skipping transaction for wallet ${walletAddress} (not in active group ${this.activeGroupId})`);
                return;
            }
            
            await this.monitoringService.processWebhookMessage({
                signature: result.value.signature,
                walletAddress,
                blockTime: result.value.timestamp || Math.floor(Date.now() / 1000),
                groupId: wallet.group_id
            });
        }
    }

    findWalletBySubscription(subscriptionId) {
        return Array.from(this.subscriptions.entries()).find(([_, subData]) => subData.logs === subscriptionId)?.[0] || null;
    }

    async subscribeToWalletsBatch(walletAddresses, batchSize = 100) {
        if (!walletAddresses || walletAddresses.length === 0) return;
        
        if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Cannot batch subscribe - WebSocket not connected`);
            return;
        }

        console.log(`[${new Date().toISOString()}] 🚀 Starting global batch subscription for ${walletAddresses.length} wallets`);
        const startTime = Date.now();

        const results = {
            successful: 0,
            failed: 0,
            errors: []
        };

        for (let i = 0; i < walletAddresses.length; i += batchSize) {
            const batch = walletAddresses.slice(i, i + batchSize);
            
            console.log(`[${new Date().toISOString()}] 📦 Processing global batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(walletAddresses.length / batchSize)} (${batch.length} wallets)`);

            const batchPromises = batch.map(async (walletAddress) => {
                try {
                    if (this.subscriptions.has(walletAddress)) {
                        console.log(`[${new Date().toISOString()}] ⏭️ Wallet ${walletAddress.slice(0, 8)}... already subscribed globally`);
                        return { success: true, address: walletAddress, action: 'already_subscribed' };
                    }

                    if (this.subscriptions.size >= this.maxSubscriptions) {
                        throw new Error(`Maximum global subscription limit of ${this.maxSubscriptions} reached`);
                    }

                    const logsSubscriptionId = await this.sendRequest('logsSubscribe', [
                        { mentions: [walletAddress] },
                        { commitment: 'confirmed' },
                    ], 'logsSubscribe');

                    this.subscriptions.set(walletAddress, { logs: logsSubscriptionId });
                    results.successful++;
                    
                    return { success: true, address: walletAddress, subscriptionId: logsSubscriptionId };

                } catch (error) {
                    results.failed++;
                    results.errors.push({ address: walletAddress, error: error.message });
                    console.error(`[${new Date().toISOString()}] ❌ Failed to subscribe to ${walletAddress.slice(0, 8)}...: ${error.message}`);
                    return { success: false, address: walletAddress, error: error.message };
                }
            });

            await Promise.all(batchPromises);

            if (i + batchSize < walletAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        const duration = Date.now() - startTime;
        const walletsPerSecond = Math.round((results.successful / duration) * 1000);

        console.log(`[${new Date().toISOString()}] ✅ Global batch subscription completed in ${duration}ms:`);
        console.log(`  - Successful: ${results.successful}`);
        console.log(`  - Failed: ${results.failed}`);
        console.log(`  - Performance: ${walletsPerSecond} subscriptions/second`);
        console.log(`  - Total active subscriptions: ${this.subscriptions.size}`);

        return results;
    }

    async unsubscribeFromWalletsBatch(walletAddresses, batchSize = 100) {
        if (!walletAddresses || walletAddresses.length === 0) return;
    
        console.log(`[${new Date().toISOString()}] 🗑️ Starting global batch unsubscription for ${walletAddresses.length} wallets`);
        const startTime = Date.now();
    
        const results = {
            successful: 0,
            failed: 0,
            errors: []
        };
    
        for (let i = 0; i < walletAddresses.length; i += batchSize) {
            const batch = walletAddresses.slice(i, i + batchSize);
    
            const batchPromises = batch.map(async (walletAddress) => {
                try {
                    const subData = this.subscriptions.get(walletAddress);
                    
                    if (!subData?.logs) {
                        this.subscriptions.delete(walletAddress);
                        results.successful++;
                        return { success: true, address: walletAddress, action: 'not_subscribed' };
                    }
    
                    if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                        try {
                            await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
                            console.log(`[${new Date().toISOString()}] ✅ Successfully unsubscribed from ${walletAddress.slice(0, 8)}... globally`);
                        } catch (wsError) {
                            console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket unsubscribe failed for ${walletAddress.slice(0, 8)}...: ${wsError.message}`);
                        }
                    } else {
                        console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket not connected, skipping network unsubscribe for ${walletAddress.slice(0, 8)}...`);
                    }
    
                    this.subscriptions.delete(walletAddress);
                    results.successful++;
                    
                    return { success: true, address: walletAddress };
    
                } catch (error) {
                    results.failed++;
                    results.errors.push({ address: walletAddress, error: error.message });
                    console.error(`[${new Date().toISOString()}] ❌ Failed to unsubscribe from ${walletAddress.slice(0, 8)}...: ${error.message}`);
                    
                    this.subscriptions.delete(walletAddress);
                    
                    return { success: false, address: walletAddress, error: error.message };
                }
            });
    
            await Promise.all(batchPromises);
    
            if (i + batchSize < walletAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ✅ Global batch unsubscription completed in ${duration}ms: ${results.successful} successful, ${results.failed} failed`);
        console.log(`[${new Date().toISOString()}] 📊 Remaining active subscriptions: ${this.subscriptions.size}`);
    
        return results;
    }

    // UPDATED: Subscribe to all wallets globally (remove user filtering)
    async subscribeToWallets() {
        this.subscriptions.clear();
        const wallets = await this.db.getActiveWallets(this.activeGroupId); // Remove userId parameter
        
        if (wallets.length === 0) {
            console.log(`[${new Date().toISOString()}] ℹ️ No wallets to subscribe globally${this.activeGroupId ? ` for group ${this.activeGroupId}` : ''}`);
            return;
        }
        
        if (wallets.length > this.maxSubscriptions) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet count (${wallets.length}) exceeds maximum (${this.maxSubscriptions}), truncating`);
            wallets.length = this.maxSubscriptions;
        }
        
        console.log(`[${new Date().toISOString()}] 📋 Starting global subscription for ${wallets.length} wallets${this.activeGroupId ? ` for group ${this.activeGroupId}` : ''}`);
        
        if (wallets.length > 0) {
            console.log(`[${new Date().toISOString()}] 🔍 Sample global wallets to subscribe:`);
            wallets.slice(0, 3).forEach(wallet => {
                console.log(`  - ${wallet.address.slice(0, 8)}... (group: ${wallet.group_id}, added by: ${wallet.added_by_username || 'unknown'})`);
            });
        }

        const walletAddresses = wallets.map(w => w.address);
        const results = await this.subscribeToWalletsBatch(walletAddresses, 150);

        console.log(`[${new Date().toISOString()}] 🎉 Global subscription summary:`);
        console.log(`  - Total wallets: ${wallets.length}`);
        console.log(`  - Successful subscriptions: ${results.successful}`);
        console.log(`  - Failed subscriptions: ${results.failed}`);
        console.log(`  - Active subscriptions: ${this.subscriptions.size}`);

        return results;
    }

    // UPDATED: Add wallet without user restriction
    async addWallet(walletAddress, name = null, groupId = null, addedBy = null) {
        try {
            if (this.subscriptions.size >= this.maxSubscriptions) {
                throw new Error(`Cannot add wallet: Maximum global limit of ${this.maxSubscriptions} wallets reached`);
            }
            
            console.log(`[${new Date().toISOString()}] 📝 Adding wallet ${walletAddress.slice(0, 8)}... globally by user ${addedBy}`);
            
            const wallet = await this.monitoringService.addWallet(walletAddress, name, groupId, addedBy);
            
            // Subscribe if relevant to active group
            if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN && 
                (!this.activeGroupId || wallet.group_id === this.activeGroupId)) {
                
                console.log(`[${new Date().toISOString()}] 🔗 Subscribing to new global wallet ${walletAddress.slice(0, 8)}...`);
                await this.subscribeToWallet(walletAddress);
            } else {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping subscription for wallet ${walletAddress.slice(0, 8)}... (not in active scope)`);
            }
            
            return wallet;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding global wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    // UPDATED: Batch wallet addition without user restrictions
    async addWalletsBatchOptimized(wallets) {
        const startTime = Date.now();
        console.log(`[${new Date().toISOString()}] 🚀 Starting global batch wallet addition: ${wallets.length} wallets`);

        const results = {
            addedWallets: [],
            errors: [],
            subscriptionResults: null
        };

        try {
            const dbWallets = wallets.map(w => ({
                address: w.address,
                name: w.name,
                groupId: w.groupId,
                addedBy: w.addedBy
            }));

            const insertedWallets = await this.db.addWalletsBatchOptimized(dbWallets);
            results.addedWallets = insertedWallets;

            console.log(`[${new Date().toISOString()}] ✅ Global database insertion completed: ${insertedWallets.length} wallets added`);

            // Subscribe relevant wallets
            const relevantWallets = insertedWallets.filter(wallet => 
                !this.activeGroupId || wallet.group_id === this.activeGroupId
            );

            if (relevantWallets.length > 0 && this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                console.log(`[${new Date().toISOString()}] 🔗 Starting global WebSocket subscriptions for ${relevantWallets.length} relevant wallets...`);
                
                const walletAddresses = relevantWallets.map(w => w.address);
                results.subscriptionResults = await this.subscribeToWalletsBatch(walletAddresses, 200);
                
                console.log(`[${new Date().toISOString()}] ✅ Global WebSocket subscriptions completed: ${results.subscriptionResults.successful} successful`);
            } else {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping global WebSocket subscriptions (${relevantWallets.length} relevant wallets, WS connected: ${this.ws?.readyState === WS_READY_STATE_OPEN})`);
            }

            const duration = Date.now() - startTime;
            const walletsPerSecond = Math.round((insertedWallets.length / duration) * 1000);

            console.log(`[${new Date().toISOString()}] 🎉 Global batch wallet addition completed in ${duration}ms: ${insertedWallets.length} wallets (${walletsPerSecond} wallets/sec)`);

            return results;

        } catch (error) {
            const duration = Date.now() - startTime;
            console.error(`[${new Date().toISOString()}] ❌ Global batch wallet addition failed after ${duration}ms:`, error.message);
            throw error;
        }
    }

    async unsubscribeFromWallet(walletAddress) {
        const subData = this.subscriptions.get(walletAddress);
        if (!subData?.logs || !this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) return;

        try {
            await this.sendRequest('logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
            console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from global logs for ${walletAddress.slice(0, 8)}...`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error unsubscribing from global ${walletAddress}:`, error.message);
        }
        this.subscriptions.delete(walletAddress);
    }

    async subscribeToWallet(walletAddress) {
        if (this.subscriptions.size >= this.maxSubscriptions) {
            throw new Error(`Maximum global subscription limit of ${this.maxSubscriptions} reached`);
        }
        
        if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Cannot subscribe to global wallet ${walletAddress.slice(0, 8)}... - WebSocket not connected`);
            return;
        }
        
        try {
            if (this.subscriptions.has(walletAddress)) {
                console.log(`[${new Date().toISOString()}] ℹ️ Global wallet ${walletAddress.slice(0, 8)}... already subscribed`);
                return;
            }

            const logsSubscriptionId = await this.sendRequest('logsSubscribe', [
                { mentions: [walletAddress] },
                { commitment: 'confirmed' },
            ], 'logsSubscribe');
            
            this.subscriptions.set(walletAddress, { logs: logsSubscriptionId });
            console.log(`[${new Date().toISOString()}] ✅ Subscribed to global wallet ${walletAddress.slice(0, 8)}... (logs: ${logsSubscriptionId})`);
            
            return { success: true, subscriptionId: logsSubscriptionId };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error subscribing to global wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    // UPDATED: Remove wallet without user restriction
    async removeWallet(walletAddress) {
        try {
            if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                await this.unsubscribeFromWallet(walletAddress);
            }
            await this.monitoringService.removeWallet(walletAddress); // Remove userId parameter
            console.log(`[${new Date().toISOString()}] ✅ Removed global wallet ${walletAddress.slice(0, 8)}...`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing global wallet ${walletAddress}:`, error.message);
            throw error;
        }
    }

    // UPDATED: Remove all wallets without user restriction
    async removeAllWallets(groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🗑️ Starting global wallet removal${groupId ? ` for group ${groupId}` : ''}`);
            
            const walletsToRemove = await this.db.getActiveWallets(groupId); // Remove userId parameter
            const addressesToUnsubscribe = walletsToRemove.map(w => w.address);
    
            if (addressesToUnsubscribe.length > 0) {
                await this.unsubscribeFromWalletsBatch(addressesToUnsubscribe);
            }
    
            await this.monitoringService.removeAllWallets(groupId); // Remove userId parameter
    
            // Resubscribe if needed
            const shouldResubscribe = this.isStarted && (
                (groupId && groupId === this.activeGroupId) ||
                (!groupId) // If removing all wallets
            );
    
            if (shouldResubscribe) {
                console.log(`[${new Date().toISOString()}] 🔄 Resubscribing to remaining global wallets...`);
                await this.subscribeToWallets();
            }
    
            console.log(`[${new Date().toISOString()}] ✅ Global removal completed: ${addressesToUnsubscribe.length} wallets removed, ${this.subscriptions.size} subscriptions remaining`);
    
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in global removeAllWallets:`, error.message);
            throw error;
        }
    }

    // UPDATED: Switch group without user restriction
    async switchGroup(groupId) {
        try {
            const startTime = Date.now();
            console.log(`[${new Date().toISOString()}] 🔄 Switching to global group ${groupId || 'all'}`);

            if (this.subscriptions.size > 0) {
                const currentAddresses = Array.from(this.subscriptions.keys());
                await this.unsubscribeFromWalletsBatch(currentAddresses);
            }

            this.activeGroupId = groupId;
            await this.subscribeToWallets();

            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] ✅ Global group switch completed in ${duration}ms: now monitoring ${this.subscriptions.size} wallets`);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in global switchGroup:`, error.message);
            throw error;
        }
    }

    getDetailedStatus() {
        const baseStatus = this.getStatus();
        
        return {
            ...baseStatus,
            performance: {
                subscriptionsPerSecond: this.subscriptions.size > 0 ? Math.round(this.subscriptions.size / ((Date.now() - this.startTime) / 1000)) : 0,
                messagesPerSecond: this.messageCount > 0 ? Math.round(this.messageCount / ((Date.now() - this.startTime) / 1000)) : 0,
                averageLatency: this.averageLatency || 0
            },
            limits: {
                maxSubscriptions: this.maxSubscriptions,
                currentSubscriptions: this.subscriptions.size,
                utilizationPercent: Math.round((this.subscriptions.size / this.maxSubscriptions) * 100)
            },
            scope: {
                activeGroupId: this.activeGroupId,
                filterActive: Boolean(this.activeGroupId),
                mode: 'global'
            }
        };
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
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached for global service`);
            this.isStarted = false;
            return;
        }

        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Reconnecting global service (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        await new Promise(resolve => setTimeout(resolve, this.reconnectInterval));
        try {
            await this.connect();
            await this.subscribeToWallets();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Global reconnect failed:`, error.message);
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
            addedBy: w.addedBy
          }));
      
          const insertedWallets = await this.db.addWalletsBatch(dbWallets);
          
          for (const wallet of insertedWallets) {
            if (!this.activeGroupId || wallet.group_id === this.activeGroupId) {
              addedWallets.push(wallet);
              if (this.ws && this.ws.readyState === WS_READY_STATE_OPEN) {
                await this.subscribeToWallet(wallet.address).catch(err => errors.push(err.message));
              }
            }
          }
      
          return { addedWallets, errors };
        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ Global batch wallet add error:`, error.message);
          throw error;
        }
    }

    getStatus() {
        return {
            isConnected: this.ws && this.ws.readyState === WS_READY_STATE_OPEN,
            isStarted: this.isStarted,
            activeGroupId: this.activeGroupId,
            subscriptions: this.subscriptions.size,
            messageCount: this.messageCount,
            reconnectAttempts: this.reconnectAttempts,
            wsUrl: this.wsUrl,
            rpcUrl: this.solanaRpc,
            mode: 'global'
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
        console.log(`[${new Date().toISOString()}] ⏹️ Global WebSocket client stopped`);
    }

    async shutdown() {
        await this.stop();
        await this.db.close().catch(() => {});
        console.log(`[${new Date().toISOString()}] ✅ Global WebSocket service shutdown complete`);
    }
}

module.exports = SolanaWebSocketService;