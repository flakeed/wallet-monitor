const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
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

setTimeout(() => {
    monitoringService.startMonitoring();
}, 2000);

// Existing endpoints (unchanged)
app.get('/api/wallets', async (req, res) => {
    try {
        const wallets = await db.getActiveWallets();
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
        res.json(walletsWithStats);
    } catch (error) {
        console.error('Error fetching wallets:', error);
        res.status(500).json({ error: 'Failed to fetch wallets' });
    }
});

// ... (other existing endpoints unchanged)

// SSE endpoint for real-time transaction updates
app.get('/api/transactions/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const interval = setInterval(async () => {
        try {
            const hours = 1;
            const limit = 10;
            const transactions = await db.getRecentTransactions(hours, limit);
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
                        wallet: {
                            address: row.wallet_address,
                            name: row.wallet_name
                        },
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

            sendEvent(Object.values(groupedTransactions));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error in SSE stream:`, error.message);
        }
    }, 5000);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

app.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
    console.log(`📊 Monitoring service status: ${monitoringService.getStatus().isMonitoring ? 'Active' : 'Inactive'}`);
});

process.on('SIGINT', async () => {
    console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
    await monitoringService.close();
    await redis.quit();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
    await monitoringService.close();
    await redis.quit();
    process.exit(0);
});