const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');
const Redis = require('ioredis');

class WebhookService {
    constructor() {
        this.wsUrl = 'ws://45.134.108.167:5006/ws';
        this.connection = new Connection('http://45.134.108.167:5005', 'confirmed');
        this.monitoringService = new WalletMonitoringService();
        this.db = new Database();
        this.ws = null;
        this.reconnectInterval = 5000;
        this.maxReconnectAttempts = 10;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.subscriptions = new Set();
    }

    async start() {
        console.log(`[${new Date().toISOString()}] 🚀 Starting WebSocket client for ${this.wsUrl}`);
        await this.loadSubscriptions();
        this.connect();
        // Subscribe to Redis for wallet subscription changes
        this.redis.subscribe('wallet:subscribe', 'wallet:unsubscribe', (err) => {
            if (err) {
                console.error(`[${new Date().toISOString()}] ❌ Redis subscription error:`, err.message);
            } else {
                console.log(`[${new Date().toISOString()}] ✅ Subscribed to Redis channels`);
            }
        });
        this.redis.on('message', (channel, message) => {
            this.handleRedisMessage(channel, message);
        });
    }

    async loadSubscriptions() {
        const wallets = await this.db.getActiveWallets();
        this.subscriptions = new Set(wallets.map(w => w.address));
        console.log(`[${new Date().toISOString()}] ✅ Loaded ${this.subscriptions.size} wallet subscriptions`);
    }

    handleRedisMessage(channel, message) {
        try {
            const data = JSON.parse(message);
            if (channel === 'wallet:subscribe') {
                this.subscriptions.add(data.address);
                this.sendSubscriptionRequest(data.address);
                console.log(`[${new Date().toISOString()}] ✅ Subscribed to wallet ${data.address}`);
            } else if (channel === 'wallet:unsubscribe') {
                this.subscriptions.delete(data.address);
                this.sendUnsubscriptionRequest(data.address);
                console.log(`[${new Date().toISOString()}] ✅ Unsubscribed from wallet ${data.address}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing Redis message:`, error.message);
        }
    }

    sendSubscriptionRequest(address) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                action: 'subscribe',
                address
            }));
        }
    }

    sendUnsubscriptionRequest(address) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                action: 'unsubscribe',
                address
            }));
        }
    }

    connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ WebSocket connected to ${this.wsUrl}`);
            this.reconnectAttempts = 0;
            this.isConnecting = false;
            // Resubscribe to all wallets
            this.subscriptions.forEach(address => this.sendSubscriptionRequest(address));
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.signature && message.walletAddress) {
                    await this.processWebhookMessage(message);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket message:`, error.message);
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
        });

        this.ws.on('close', () => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket disconnected`);
            this.isConnecting = false;
            this.handleReconnect();
        });
    }

    async processWebhookMessage(message) {
        const { signature, walletAddress } = message;
        if (!walletAddress) {
            console.warn(`[${new Date().toISOString()}] ⚠️ No wallet address provided in webhook for signature ${signature}`);
            return;
        }
        try {
            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found in monitored wallets`);
                return;
            }
            await this.monitoringService.processWebhookMessage(message);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing webhook message for signature ${signature}:`, error.message);
        }
    }

    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached. Stopping WebSocket client.`);
            return;
        }
        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectInterval}ms...`);
        setTimeout(() => this.connect(), this.reconnectInterval);
    }

    async stop() {
        console.log(`[${new Date().toISOString()}] ⏹️ Stopping WebSocket client`);
        if (this.ws) {
            this.ws.close();
        }
        await this.redis.quit();
        await this.db.close();
    }
}

module.exports = WebhookService;