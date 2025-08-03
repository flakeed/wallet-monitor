const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');

class ConnectionPool {
  constructor() {
    this.rpcNodes = [
      process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005',
      'https://api.mainnet-beta.solana.com',
    ];
    this.connections = this.rpcNodes.map(url => new Connection(url, 'confirmed'));
    this.currentIndex = 0;
  }

  getConnection() {
    const conn = this.connections[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    return conn;
  }
}

class SolanaWebSocketService {
  constructor() {
    this.solanaRpc = process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005';
    this.wsUrl = process.env.WEBHOOK_URL || 'ws://45.134.108.167:5006/ws';
    this.connectionPool = new ConnectionPool();
    this.monitoringService = new WalletMonitoringService();
    this.db = new Database();
    this.wsPool = new Map();
    this.subscriptions = new Map();
    this.reconnectInterval = 3000;
    this.maxReconnectAttempts = 20;
    this.poolSize = 5;
    this.messageId = 0;
    this.pendingRequests = new Map();
    this.messageCount = 0;
    this.isStarted = false;
  }

  async start() {
    if (this.isStarted) {
      console.log(`[${new Date().toISOString()}] 🔄 WebSocket service already started`);
      return;
    }
    this.isStarted = true;
    console.log(`[${new Date().toISOString()}] 🚀 Starting Solana WebSocket service with ${this.poolSize} connections`);

    for (let i = 0; i < this.poolSize; i++) {
      await this.createWebSocket(i);
    }
    await this.subscribeToWallets();
  }

  async createWebSocket(index) {
    const ws = new WebSocket(this.wsUrl, {
      handshakeTimeout: 10000,
      perMessageDeflate: false
    });

    ws.on('open', () => {
      console.log(`[${new Date().toISOString()}] ✅ WebSocket ${index} connected`);
      this.wsPool.set(index, { ws, reconnectAttempts: 0 });
    });

    ws.on('message', async (data) => {
      this.messageCount++;
      try {
        const message = JSON.parse(data.toString());
        console.log(`[${new Date().toISOString()}] 📬 WebSocket ${index} message #${this.messageCount}:`, JSON.stringify(message, null, 2));
        await this.handleMessage(message, index);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket ${index} message:`, error.message);
      }
    });

    ws.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] ❌ WebSocket ${index} error:`, error.message);
    });

    ws.on('close', (code, reason) => {
      console.log(`[${new Date().toISOString()}] 🔌 WebSocket ${index} closed. Code: ${code}, Reason: ${reason.toString()}`);
      if (this.isStarted) this.handleReconnect(index);
    });

    ws.on('ping', (data) => ws.pong(data));
    this.wsPool.set(index, { ws, reconnectAttempts: 0 });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`WebSocket ${index} connection timeout`)), 10000);
      ws.on('open', () => { clearTimeout(timeout); resolve(); });
      ws.on('error', (error) => { clearTimeout(timeout); reject(error); });
    });
  }

  async handleMessage(message, wsIndex) {
    if (message.id && this.pendingRequests.has(`${wsIndex}:${message.id}`)) {
      const { resolve, reject, type } = this.pendingRequests.get(`${wsIndex}:${message.id}`);
      this.pendingRequests.delete(`${wsIndex}:${message.id}`);
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
        blockTime: result.value.timestamp || Math.floor(Date.now() / 1000)
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
    const wallets = await this.db.getActiveWallets();
    console.log(`[${new Date().toISOString()}] 📋 Subscribing to ${wallets.length} wallets`);

    let wsIndex = 0;
    for (const wallet of wallets) {
      const wsData = this.wsPool.get(wsIndex % this.poolSize);
      if (!wsData || wsData.ws.readyState !== WebSocket.OPEN) {
        console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket ${wsIndex % this.poolSize} not ready`);
        continue;
      }
      await this.subscribeToWallet(wallet.address, wsIndex % this.poolSize);
      wsIndex++;
    }
    console.log(`[${new Date().toISOString()}] ✅ Subscribed to all wallets`);
  }

  async subscribeToWallet(walletAddress, wsIndex) {
    try {
      console.log(`[${new Date().toISOString()}] 🔔 Subscribing to wallet ${walletAddress.slice(0, 8)}... on WebSocket ${wsIndex}`);
      const logsSubscriptionId = await this.sendRequest(wsIndex, 'logsSubscribe', [
        { mentions: [walletAddress] },
        { commitment: 'confirmed' }
      ], 'logsSubscribe');
      this.subscriptions.set(walletAddress, { logs: logsSubscriptionId, wsIndex });
      console.log(`[${new Date().toISOString()}] ✅ Subscribed to wallet ${walletAddress.slice(0, 8)}... (logs: ${logsSubscriptionId})`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error subscribing to wallet ${walletAddress}:`, error.message);
    }
  }

  async unsubscribeFromWallet(walletAddress) {
    const subData = this.subscriptions.get(walletAddress);
    if (!subData) return;

    const wsIndex = subData.wsIndex;
    const wsData = this.wsPool.get(wsIndex);
    if (wsData && wsData.ws.readyState === WebSocket.OPEN && subData.logs) {
      await this.sendRequest(wsIndex, 'logsUnsubscribe', [subData.logs], 'logsUnsubscribe');
      console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from logs for ${walletAddress.slice(0, 8)}...`);
    }
    this.subscriptions.delete(walletAddress);
  }

  async addWallet(walletAddress, name = null) {
    try {
      const wallet = await this.monitoringService.addWallet(walletAddress, name);
      const wsIndex = this.subscriptions.size % this.poolSize;
      const wsData = this.wsPool.get(wsIndex);
      if (wsData && wsData.ws.readyState === WebSocket.OPEN) {
        await this.subscribeToWallet(walletAddress, wsIndex);
      }
      return wallet;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error adding wallet ${walletAddress}:`, error.message);
      throw error;
    }
  }

  async removeWallet(walletAddress) {
    try {
      if (this.subscriptions.has(walletAddress)) {
        await this.unsubscribeFromWallet(walletAddress);
      }
      await this.monitoringService.removeWallet(walletAddress);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Error removing wallet ${walletAddress}:`, error.message);
      throw error;
    }
  }

  sendRequest(wsIndex, method, params, type) {
    return new Promise((resolve, reject) => {
      const wsData = this.wsPool.get(wsIndex);
      if (!wsData || wsData.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`WebSocket ${wsIndex} is not connected`));
        return;
      }

      const id = ++this.messageId;
      this.pendingRequests.set(`${wsIndex}:${id}`, { resolve, reject, type });
      wsData.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

      setTimeout(() => {
        if (this.pendingRequests.has(`${wsIndex}:${id}`)) {
          this.pendingRequests.delete(`${wsIndex}:${id}`);
          reject(new Error(`Request ${type} (id: ${id}) on WebSocket ${wsIndex} timed out`));
        }
      }, 60000);
    });
  }

  async handleReconnect(wsIndex) {
    const wsData = this.wsPool.get(wsIndex);
    if (!wsData || wsData.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached for WebSocket ${wsIndex}`);
      return;
    }

    wsData.reconnectAttempts++;
    console.log(`[${new Date().toISOString()}] 🔄 Reconnecting WebSocket ${wsIndex} (${wsData.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.createWebSocket(wsIndex);
        const wallets = Array.from(this.subscriptions.entries())
          .filter(([_, subData]) => subData.wsIndex === wsIndex)
          .map(([addr, _]) => addr);
        for (const wallet of wallets) {
          await this.subscribeToWallet(wallet, wsIndex);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Reconnect failed for WebSocket ${wsIndex}:`, error.message);
      }
    }, this.reconnectInterval);
  }

  getStatus() {
    const subscriptionDetails = Array.from(this.subscriptions.entries()).map(([addr, subData]) => ({
      address: addr,
      logsSubscription: subData.logs,
      wsIndex: subData.wsIndex
    }));

    return {
      isConnected: Array.from(this.wsPool.values()).some(wsData => wsData.ws.readyState === WebSocket.OPEN),
      isStarted: this.isStarted,
      subscriptions: this.subscriptions.size,
      messageCount: this.messageCount,
      reconnectAttempts: Array.from(this.wsPool.entries()).map(([index, wsData]) => ({ wsIndex: index, attempts: wsData.reconnectAttempts })),
      wsUrl: this.wsUrl,
      rpcUrl: this.solanaRpc,
      activeWallets: subscriptionDetails
    };
  }

  async stop() {
    this.isStarted = false;
    for (const [index, wsData] of this.wsPool.entries()) {
      if (wsData.ws.readyState === WebSocket.OPEN) {
        wsData.ws.close();
      }
    }
    this.subscriptions.clear();
    this.wsPool.clear();
    await this.db.close();
    console.log(`[${new Date().toISOString()}] ⏹️ WebSocket service stopped`);
  }
}

module.exports = SolanaWebSocketService;