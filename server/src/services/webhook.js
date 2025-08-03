const WebSocket = require('ws');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const WEBHOOK_URL = 'ws://45.134.108.167:5006/ws';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=758fd668-8d79-4538-9ae4-3741a4c877e8'; 
const WALLET_ADDRESS = 'ep3XjfiJrRpmiSqh6fTd14YwNBSHuSj6UA732c3Dw1k';
const RECIPIENT_ADDRESS = 'ep3XjfiJrRpmiSqh6fTd14YwNBSHuSj6UA732c3Dw1k'; 

const PRIVATE_KEY = '5pLo8f4T1HE2oMPC9RNCCrRpMyR97CCttvCgFy72G9BKetpnwU25pQt8WmzmQZ2Ycbx8yvnvYEPr6C9p1T1kysz2'; 

class WalletSubscription {
    constructor() {
        this.connection = new Connection(RPC_URL, 'confirmed');
        this.ws = null;
        this.messageCount = 0;
        this.wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
    }

    connectToWebhook() {
        this.ws = new WebSocket(WEBHOOK_URL);

        this.ws.on('open', () => {
            console.log(`[${new Date().toISOString()}] Connected to Solana WebSocket at ${WEBHOOK_URL}`);
            const subscriptionMessage = {
                jsonrpc: '2.0',
                id: 1,
                method: 'accountSubscribe',
                params: [WALLET_ADDRESS, { commitment: 'confirmed' }]
            };
            this.ws.send(JSON.stringify(subscriptionMessage));
            console.log(`[${new Date().toISOString()}] Subscribed to wallet: ${WALLET_ADDRESS}`);
        });

        this.ws.on('message', (data) => {
            this.messageCount++;
            console.log(`[${new Date().toISOString()}] WebSocket message #${this.messageCount} received:`);
            try {
                const message = JSON.parse(data.toString());
                console.log(`[${new Date().toISOString()}] Parsed message:`, JSON.stringify(message, null, 2));
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error parsing WebSocket message:`, error.message);
                console.log(`[${new Date().toISOString()}] Raw message:`, data.toString());
            }
        });

        this.ws.on('error', (error) => {
            console.error(`[${new Date().toISOString()}] WebSocket error:`, error.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[${new Date().toISOString()}]  WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            setTimeout(() => {
                console.log(`[${new Date().toISOString()}]  Attempting to reconnect to WebSocket...`);
                this.connectToWebhook();
            }, 5000);
        });
    }

    async sendTestTransaction() {
        try {
            console.log(`[${new Date().toISOString()}] 🚀 Creating transaction from ${WALLET_ADDRESS} to ${RECIPIENT_ADDRESS}`);
            
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            console.log(`[${new Date().toISOString()}] 💰 Wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
            const transferAmount = 0.0001 * LAMPORTS_PER_SOL; 
            if (balance < transferAmount + 5000) { 
                throw new Error(`Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL, need at least ${(transferAmount + 5000) / LAMPORTS_PER_SOL} SOL`);
            }

            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: new PublicKey(RECIPIENT_ADDRESS),
                    lamports: transferAmount 
                })
            );

            const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.wallet.publicKey;

            transaction.sign(this.wallet);
            const signature = await this.connection.sendRawTransaction(transaction.serialize());
            console.log(`[${new Date().toISOString()}] 📤 Transaction sent. Signature: ${signature}`);

            await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
            console.log(`[${new Date().toISOString()}] ✅ Transaction confirmed: ${signature}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error sending transaction:`, error.message);
        }
    }

    async start() {
        console.log(`[${new Date().toISOString()}]  Starting wallet subscription test`);
        this.connectToWebhook();
        setTimeout(() => this.sendTestTransaction(), 2000);
    }
}

const subscription = new WalletSubscription();
subscription.start();