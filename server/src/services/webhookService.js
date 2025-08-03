const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const WalletMonitoringService = require('./monitoringService');
const Database = require('../database/connection');

class WebhookService {
    constructor() {
        this.wsUrl = 'ws://45.134.108.167:5006/ws';
        this.connection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
        this.monitoringService = new WalletMonitoringService();
        this.db = new Database();
        this.ws = null;
        this.reconnectInterval = 5000; 
        this.maxReconnectAttempts = 10;
        this.reconnectAttempts = 0;
        this.isConnecting = false;
    }

    async start() {
        console.log(`[${new Date().toISOString()}] 🚀 Starting WebSocket client for ${this.wsUrl}`);
        this.connect();
    }

    connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ WebSocket connected to ${this.wsUrl}`);
            this.reconnectAttempts = 0;
            this.isConnecting = false;
        });

this.ws.on('message', (data) => {
        try {
    messageCount++;
    console.log(`message #${messageCount} received:`);
    console.log('raw data:', data.toString());

        const parsed = JSON.parse(data.toString());
        console.log('Parsed JSON:', JSON.stringify(parsed, null, 2));
    } catch (e) {
        console.log('Not valid JSON');
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

            const sigStatus = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
            if (!sigStatus.value || sigStatus.value.err) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid or failed transaction ${signature}`);
                return;
            }

            const blockTime = sigStatus.value.blockTime;
            if (!blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No blockTime for signature ${signature}`);
                return;
            }

            const sigObject = { signature, blockTime };
            const txData = await this.monitoringService.processTransaction(sigObject, wallet);
            if (txData) {
                console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature} for wallet ${walletAddress}`);
            } else {
                console.warn(`[${new Date().toISOString()}] ⚠️ No valid data processed for transaction ${signature}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${signature}:`, error.message);
        }
    }

    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[${new Date().toISOString()}] ❌ Max reconnect attempts reached. Stopping WebSocket client.`);
            return;
        }

        this.reconnectAttempts++;
        console.log(`[${new Date().toISOString()}] 🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectInterval}ms...`);

        setTimeout(() => {
            this.connect();
        }, this.reconnectInterval);
    }

    async stop() {
        console.log(`[${new Date().toISOString()}] ⏹️ Stopping WebSocket client`);
        if (this.ws) {
            this.ws.close();
        }
        await this.db.close();
    }
}

module.exports = WebhookService;