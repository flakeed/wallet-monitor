const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws'); 
require('dotenv').config();
const { redis } = require('./services/tokenService'); 

const WalletMonitoringService = require('./services/monitoringService');
const Database = require('./database/connection');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://wallet-monitor-client.vercel.app'],
    optionsSuccessStatus: 200,
}));
app.use(express.json());

const monitoringService = new WalletMonitoringService();
const db = new Database();

setTimeout(async () => {
    try {
        await monitoringService.startMonitoring();
        console.log('✅ Monitoring service started successfully');
    } catch (error) {
        console.error('❌ Failed to start monitoring service:', error.message);
    }
}, 2000);
const NODE_WEBSOCKET_URL = 'ws://45.134.108.167:5006/ws';
let ws;

function connectWebSocket() {
    ws = new WebSocket(NODE_WEBSOCKET_URL);

    ws.on('open', () => {
        console.log(`[${new Date().toISOString()}] Connected to node WebSocket: ${NODE_WEBSOCKET_URL}`);
    });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data); 
            console.log(`[${new Date().toISOString()}] Received from node WebSocket:`, JSON.stringify(message, null, 2));

            const normalizedData = Array.isArray(message) ? message : [message];

            await monitoringService.processWebhook(normalizedData);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error processing node WebSocket message:`, error.message);
        }
    });

    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error:`, error.message);
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] WebSocket closed, reconnecting in 5 seconds...`);
        setTimeout(connectWebSocket, 5000); 
    });
}

connectWebSocket();

app.post('/api/webhook', async (req, res) => {
    try {
        const data = req.body;
        console.log(`[${new Date().toISOString()}] Received webhook (Helius):`, JSON.stringify(data, null, 2));

        // if (process.env.WEBHOOK_AUTH_HEADER && req.headers['authorization'] !== process.env.WEBHOOK_AUTH_HEADER) {
        //     return res.status(401).json({ error: 'Unauthorized' });
        // }

        await monitoringService.processWebhook(data);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error processing webhook:`, error);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});

app.get('/api/wallets', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const wallets = await db.getActiveWallets({ limit, offset });
        const total = await db.getWalletCount();

        const walletsWithStats = await Promise.all(
            wallets.map(async (wallet) => {
                const stats = await db.getWalletStats(wallet.id);
                return {
                    ...wallet,
                    stats: {
                        totalBuyTransactions: stats.total_buy_transactions || 0,
                        totalSellTransactions: stats.total_sell_transactions || 0,
                        totalTransactions: (stats.total_buy_transactions || 0) + (stats.total_sell_transactions || 0),
                        totalSpentSOL: Number(stats.total_sol_spent || 0).toFixed(6),
                        totalReceivedSOL: Number(stats.total_sol_received || 0).toFixed(6),
                        totalSpentUSD: Number(stats.total_usd_spent || 0).toFixed(2),
                        totalReceivedUSD: Number(stats.total_usd_received || 0).toFixed(2),
                        netSOL: (Number(stats.total_sol_received || 0) - Number(stats.total_sol_spent || 0)).toFixed(6),
                        netUSD: (Number(stats.total_usd_received || 0) - Number(stats.total_usd_spent || 0)).toFixed(2),
                        lastTransactionAt: stats.last_transaction_at
                    }
                };
            })
        );

        res.json({
            wallets: walletsWithStats,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('Error fetching wallets:', error);
        res.status(500).json({ error: 'Failed to fetch wallets' });
    }
});

app.post('/api/wallets', async (req, res) => {
    try {
        const { address, name } = req.body;
        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }

        const wallet = await monitoringService.addWallet(address, name);
        res.json({
            success: true,
            wallet,
            message: 'Wallet added for webhook monitoring'
        });
        res.json({ success: true, wallet, message: 'Wallet added' });
    } catch (error) {
        console.error('Error adding wallet:', error);
        res.status(error.message.includes('already exists') ? 409 : 500).json({ error: error.message });
    }
});

app.delete('/api/wallets/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address' });
        }

        await monitoringService.removeWallet(address);

        res.json({
            success: true,
            message: 'Wallet removed from webhook monitoring'
        });
        res.json({ success: true, message: 'Wallet removed' });
    } catch (error) {
        console.error('Error removing wallet:', error);
        res.status(error.message.includes('not found') ? 404 : 500).json({ error: error.message });
    }
});

app.get('/api/transactions', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const limit = parseInt(req.query.limit) || 50;
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;
        const type = req.query.type;

        const transactions = await db.getRecentTransactions(hours, limit, offset, type);
        const total = await db.getTransactionCount(hours, type);

        const groupedTransactions = {};
        transactions.forEach(row => {
            if (!groupedTransactions[row.signature]) {
                groupedTransactions[row.signature] = {
                    signature: row.signature,
                    time: row.block_time,
                    transactionType: row.transaction_type,
                    solSpent: row.sol_spent ? Number(row.sol_spent).toFixed(6) : null,
                    solReceived: row.sol_received ? Number(row.sol_received).toFixed(6) : null,
                    usdSpent: row.usd_spent ? Number(row.usd_spent).toFixed(2) : null,
                    usdReceived: row.usd_received ? Number(row.usd_received).toFixed(2) : null,
                    wallet: { address: row.wallet_address, name: row.wallet_name },
                    tokensBought: [],
                    tokensSold: []
                };
            }

            if (row.mint) {
                const tokenData = {
                    mint: row.mint,
                    symbol: row.symbol,
                    name: row.token_name,
                    logoURI: row.logo_uri,
                    amount: Number(row.token_amount),
                    decimals: row.decimals
                };
                if (row.operation_type === 'buy') {
                    groupedTransactions[row.signature].tokensBought.push(tokenData);
                } else if (row.operation_type === 'sell') {
                    groupedTransactions[row.signature].tokensSold.push(tokenData);
                }
            }
        });

        res.json({
            transactions: Object.values(groupedTransactions),
            pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.get('/api/monitoring/status', (req, res) => {
    res.json(monitoringService.getStatus());
});

app.post('/api/monitoring/toggle', async (req, res) => {
    try {
        const { action } = req.body;
        if (action === 'start') {
            await monitoringService.startMonitoring();
            res.json({ success: true, message: 'Webhook monitoring started' });
        } else if (action === 'stop') {
            monitoringService.stopMonitoring();
            res.json({ success: true, message: 'Webhook monitoring stopped' });
        } else {
            res.status(400).json({ error: 'Invalid action' });
        }
    } catch (error) {
        console.error('Error toggling monitoring:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/monitoring/detailed-status', async (req, res) => {
    try {
        const detailedStats = await monitoringService.getDetailedStats();
        res.json(detailedStats);
    } catch (error) {
        console.error('Error fetching detailed status:', error);
        res.status(500).json({ error: 'Failed to fetch detailed status' });
    }
});

app.post('/api/wallets/:address/sync', async (req, res) => {
    try {
        const address = req.params.address.trim();
        const limit = parseInt(req.body.limit) || 10;

        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }

        const result = await monitoringService.manualSyncWallet(address, limit);
        res.json({
            success: true,
            message: `Manual sync completed for ${address.slice(0, 8)}...`,
            result
        });
    } catch (error) {
        console.error('Error in manual sync:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/node/wallet/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();

        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }

        const walletInfo = await monitoringService.getWalletInfoFromNode(address);
        res.json(walletInfo);
    } catch (error) {
        console.error('Error fetching wallet info from node:', error);
        res.status(500).json({ error: 'Failed to fetch wallet info from node' });
    }
});

app.get('/api/node/stats', async (req, res) => {
    try {
        const nodeStats = await monitoringService.getNodeStats();
        res.json(nodeStats);
    } catch (error) {
        console.error('Error fetching node stats:', error);
        res.status(500).json({ error: 'Failed to fetch node stats' });
    }
});

app.get('/api/wallet/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();

        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana public key format' });
        }

        const wallet = await db.getWalletByAddress(address);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found in monitoring list' });
        }

        const connection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
        const publicKey = new PublicKey(address);
        const balanceLamports = await connection.getBalance(publicKey);
        const balanceSol = balanceLamports / 1e9;

        const transactions = await db.getRecentTransactions(24 * 7, 100);
        const walletTransactions = transactions.filter(tx => tx.wallet_address === address);

        const groupedTransactions = {};
        walletTransactions.forEach(row => {
            if (!groupedTransactions[row.signature]) {
                groupedTransactions[row.signature] = {
                    signature: row.signature,
                    time: row.block_time,
                    transactionType: row.transaction_type,
                    spentSOL: row.sol_spent ? Number(row.sol_spent) : null,
                    receivedSOL: row.sol_received ? Number(row.sol_received) : null,
                    spentUSD: row.usd_spent ? Number(row.usd_spent) : null,
                    receivedUSD: row.usd_received ? Number(row.usd_received) : null,
                    tokensBought: [],
                    tokensSold: []
                };
            }

            if (row.mint) {
                const tokenData = {
                    mint: row.mint,
                    symbol: row.symbol,
                    name: row.token_name,
                    logoURI: row.logo_uri,
                    amount: Number(row.token_amount),
                    decimals: row.decimals || 6
                };

                if (row.operation_type === 'buy') {
                    groupedTransactions[row.signature].tokensBought.push(tokenData);
                } else if (row.operation_type === 'sell') {
                    groupedTransactions[row.signature].tokensSold.push(tokenData);
                }
            }
        });

        const operations = Object.values(groupedTransactions);

        res.json({
            address,
            balance: Number(balanceSol).toLocaleString(undefined, { maximumFractionDigits: 6 }),
            operations
        });
    } catch (error) {
        console.error('Error in /api/wallet:', error);
        res.status(500).json({
            error: error.message || 'Failed to fetch wallet data',
        });
    }
});

app.get('/api/stats/transactions', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const stats = await db.getMonitoringStats();
        
        res.json({
            buyTransactions: stats.buy_transactions_today || 0,
            sellTransactions: stats.sell_transactions_today || 0,
            totalTransactions: (stats.buy_transactions_today || 0) + (stats.sell_transactions_today || 0),
            solSpent: Number(stats.sol_spent_today || 0).toFixed(6),
            solReceived: Number(stats.sol_received_today || 0).toFixed(6),
            usdSpent: Number(stats.usd_spent_today || 0).toFixed(2),
            usdReceived: Number(stats.usd_received_today || 0).toFixed(2),
            netSOL: (Number(stats.sol_received_today || 0) - Number(stats.sol_spent_today || 0)).toFixed(6),
            netUSD: (Number(stats.usd_received_today || 0) - Number(stats.usd_spent_today || 0)).toFixed(2)
        });
    } catch (error) {
        console.error('Error fetching transaction stats:', error);
        res.status(500).json({ error: 'Failed to fetch transaction stats' });
    }
});

app.post('/api/wallets/bulk', async (req, res) => {
    try {
        const { wallets } = req.body;

        if (!wallets || !Array.isArray(wallets)) {
            return res.status(400).json({ error: 'Wallets array is required' });
        }

        if (wallets.length === 0) {
            return res.status(400).json({ error: 'At least one wallet is required' });
        }

        if (wallets.length > 500) {
            return res.status(400).json({ error: 'Maximum 100 wallets allowed per bulk import' });
        }

        const results = {
            total: wallets.length,
            successful: 0,
            failed: 0,
            errors: [],
            successfulWallets: []
        };

        for (const wallet of wallets) {
            if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
                results.failed++;
                results.errors.push({
                    address: wallet.address || 'invalid',
                    name: wallet.name || null,
                    error: 'Invalid Solana wallet address format'
                });
                continue;
            }
        }

        for (const wallet of wallets) {
            const hasError = results.errors.some(error => error.address === wallet.address);
            if (hasError) continue;

            try {
                const addedWallet = await monitoringService.addWallet(wallet.address, wallet.name || null);
                results.successful++;
                results.successfulWallets.push({
                    address: wallet.address,
                    name: wallet.name || null,
                    id: addedWallet.id
                });
            } catch (error) {
                results.failed++;
                results.errors.push({
                    address: wallet.address,
                    name: wallet.name || null,
                    error: error.message
                });
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        res.json({
            success: true,
            message: `Bulk import completed: ${results.successful} successful, ${results.failed} failed. Wallets will be monitored in the next cycle.`,
            results
        });

    } catch (error) {
        console.error('Error in bulk wallet import:', error);
        res.status(500).json({ error: 'Failed to import wallets' });
    }
});

app.get('/api/wallets/bulk-template', (req, res) => {
    const template = `# Bulk Wallet Import Template
# Format: address,name (name is optional)
# One wallet per line
# Lines starting with # are ignored

# Example wallets (replace with real addresses):
9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Wallet 1
53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC,Important Trader
Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y
7dHbWXmci3dT1DHaV2R7uHWdwKz7V8L2MvX9Gt8kVeHN,Test Wallet`;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="wallet-import-template.txt"');
    res.send(template);
});

app.post('/api/wallets/validate', (req, res) => {
    try {
        const { wallets } = req.body;

        if (!wallets || !Array.isArray(wallets)) {
            return res.status(400).json({ error: 'Wallets array is required' });
        }

        const validation = {
            total: wallets.length,
            valid: 0,
            invalid: 0,
            errors: []
        };

        for (const wallet of wallets) {
            if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
                validation.invalid++;
                validation.errors.push({
                    address: wallet.address || 'missing',
                    name: wallet.name || null,
                    error: 'Invalid Solana wallet address format'
                });
            } else {
                validation.valid++;
            }
        }

        res.json({
            success: true,
            validation
        });

    } catch (error) {
        console.error('Error validating wallets:', error);
        res.status(500).json({ error: 'Failed to validate wallets' });
    }
});

app.get('/api/stats/tokens', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const type = req.query.type;
        
        const topTokens = await db.getTopTokens(limit, type);
        res.json(topTokens);
    } catch (error) {
        console.error('Error fetching top tokens:', error);
        res.status(500).json({ error: 'Failed to fetch top tokens' });
    }
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    await monitoringService.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down server...');
    await monitoringService.close();
    process.exit(0);
});

app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log(`📡 Webhook monitoring will be initialized shortly...`);
    console.log(`📊 Monitoring service status: ${monitoringService.getStatus().isMonitoring ? 'Active' : 'Inactive'}`);
});
