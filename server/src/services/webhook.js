const WebSocket = require('ws');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const WEBHOOK_URL = 'ws://45.134.108.167:5006/ws';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=758fd668-8d79-4538-9ae4-3741a4c877e8';
const WALLET_ADDRESS = '9JebwPTGwP4YCgNWimZL3yHnk6gEXR8M7RMrPA2pSBBD'; 

class WalletSubscription {
    constructor() {
        this.connection = new Connection(RPC_URL, 'confirmed');
        this.ws = null;
        this.messageCount = 0;
    }

    connectToWebhook() {
        this.ws = new WebSocket(WEBHOOK_URL);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] ✅ Connected to Solana WebSocket at ${WEBHOOK_URL}`);
            const subscriptionMessage = {
                method: 'subscribe',
                params: {
                    account: WALLET_ADDRESS,
                    type: 'transactions' 
                }
            };
            this.ws.send(JSON.stringify(subscriptionMessage));
            console.log(`[${new Date().toISOString()}] 📡 Subscribed to wallet: ${WALLET_ADDRESS}`);
        });

        this.ws.on('message', (data) => {
            this.messageCount++;
            console.log(`[${new Date().toISOString()}] 📬 WebSocket message #${this.messageCount} received:`);
            try {
                const message = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] Parsed message:`, JSON.stringify(message, null, 2));
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error parsing WebSocket message:`, error.message);
                console.log(`[${new Date().toISOString()}] Raw message:`, data.toString());
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            setTimeout(() => {
                console.log(`[${new Date().toISOString()}] 🔄 Attempting to reconnect to WebSocket...`);
                this.connectToWebhook();
            }, 5000);
        });
    }

    async testTransaction() {
        try {
            const walletPublicKey = new PublicKey(WALLET_ADDRESS);
            console.log(`[${new Date().toISOString()}] 🚀 Requesting airdrop for ${WALLET_ADDRESS}`);
            const signature = await this.connection.requestAirdrop(walletPublicKey, LAMPORTS_PER_SOL);
            console.log(`[${new Date().toISOString()}] 📤 Airdrop requested. Signature: ${signature}`);
            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
            await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            console.log(`[${new Date().toISOString()}] ✅ Airdrop confirmed for ${WALLET_ADDRESS}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error performing airdrop:`, error.message);
        }
    }

    async start() {
        console.log(`[${new Date().toISOString()}] 🚀 Starting wallet subscription test`);
        this.connectToWebhook();
        setTimeout(() => this.testTransaction(), 2000);
    }
}

const subscription = new WalletSubscription();
subscription.start();