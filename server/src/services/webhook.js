const WebSocket = require('ws');

const WEBHOOK_URL = 'ws://45.134.108.167:5006/ws';

function connectToWebhook() {
    const ws = new WebSocket(WEBHOOK_URL);

    ws.on('open', () => {
        console.log(`[${new Date().toISOString()}] ✅ Connected to Solana WebSocket at ${WEBHOOK_URL}`);
    });

    ws.on('message', (data) => {
        console.log(`[${new Date().toISOString()}] 📬 WebSocket message received:`);
        try {
            const message = JSON.parse(data);
            console.log(`[${new Date().toISOString()}] Received WebSocket message:`, JSON.stringify(message, null, 2));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error parsing WebSocket message:`, error.message);
            console.log(`[${new Date().toISOString()}] Raw message:`, data.toString());
        }
    });

    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
    });

    ws.on('close', (code, reason) => {
        console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
        setTimeout(() => {
            console.log(`[${new Date().toISOString()}] 🔄 Attempting to reconnect to WebSocket...`);
            connectToWebhook();
        }, 5000);
    });
}

connectToWebhook();