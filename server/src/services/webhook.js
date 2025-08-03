const WebSocket = require('ws');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const WEBHOOK_URL = 'ws://45.134.108.167:5006/ws';
const RPC_URL = 'https://api.devnet.solana.com'; 
const WALLET_ADDRESS = 'GXnhhZsFxhA8uoEc8n2kARyDCnMrRRQ8gpQMQfv1v53L';
const RECIPIENT_ADDRESS = '7S3P4HxJpyyigGzodYwHtCxZyUQe9JiBMHyRWXArAaKv'; 

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
                jsonrpc: '2.0',
                id: 1,
                method: 'accountSubscribe',
                params: [WALLET_ADDRESS, { commitment: 'confirmed' }]
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

    async sendTestTransaction() {
        try {
            const provider = window.phantom?.solana;
            if (!provider?.isPhantom) {
                throw new Error('Phantom Wallet is not installed');
            }

            const resp = await provider.connect();
            const publicKey = resp.publicKey;
            console.log(`[${new Date().toISOString()}] 🔗 Connected to Phantom wallet: ${publicKey.toString()}`);

            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: new PublicKey(RECIPIENT_ADDRESS),
                    lamports: 0.1 * LAMPORTS_PER_SOL // 0.1 SOL
                })
            );

            const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = publicKey;

            const signedTransaction = await provider.signTransaction(transaction);
            const signature = await this.connection.sendRawTransaction(signedTransaction.serialize());
            console.log(`[${new Date().toISOString()}] 📤 Transaction sent. Signature: ${signature}`);

            const { lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
            await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            console.log(`[${new Date().toISOString()}] ✅ Transaction confirmed: ${signature}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error sending transaction:`, error.message);
        }
    }

    async start() {
        console.log(`[${new Date().toISOString()}] 🚀 Starting wallet subscription test`);
        this.connectToWebhook();
        setTimeout(() => this.sendTestTransaction(), 2000);
    }
}

const subscription = new WalletSubscription();
subscription.start();