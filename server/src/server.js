const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

const WalletMonitoringService = require('./services/monitoringService');
const Database = require('./database/connection');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://crypto-monitor-f21kndk9h-flakeeds-projects.vercel.app'],
    optionsSuccessStatus: 200,
}));
app.use(express.json());

const monitoringService = new WalletMonitoringService();
const db = new Database();

setTimeout(() => {
    monitoringService.startMonitoring();
}, 2000);

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

app.post('/api/wallets', async (req, res) => {
    try {
        const { address, name } = req.body;

        if (!address) {
            return res.status(400).json({ error: 'Wallet address is required' });
        }

        if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }

        const wallet = await monitoringService.addWallet(address, name);
        res.json({
            success: true,
            wallet,
            message: 'Wallet added for monitoring'
        });
    } catch (error) {
        console.error('Error adding wallet:', error);
        if (error.message.includes('already exists')) {
            res.status(409).json({ error: 'Wallet is already being monitored' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.delete('/api/wallets/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();

        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }

        await monitoringService.removeWallet(address);

        res.json({
            success: true,
            message: 'Wallet and all associated data removed successfully'
        });
    } catch (error) {
        console.error('Error removing wallet:', error);
        if (error.message.includes('Wallet not found')) {
            res.status(404).json({ error: 'Wallet not found in monitoring list' });
        } else {
            res.status(500).json({ error: 'Failed to remove wallet' });
        }
    }
});

app.get('/api/transactions', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const limit = parseInt(req.query.limit) || 50;
        const type = req.query.type; 

        const transactions = await db.getRecentTransactions(hours, limit, type);

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

        const result = Object.values(groupedTransactions);
        res.json(result);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.get('/api/monitoring/status', (req, res) => {
    const status = monitoringService.getStatus();
    res.json(status);
});

app.post('/api/monitoring/toggle', (req, res) => {
    try {
        const { action } = req.body;

        if (action === 'start') {
            monitoringService.startMonitoring();
            res.json({ success: true, message: 'Monitoring started' });
        } else if (action === 'stop') {
            monitoringService.stopMonitoring();
            res.json({ success: true, message: 'Monitoring stopped' });
        } else {
            res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
        }
    } catch (error) {
        console.error('Error toggling monitoring:', error);
        res.status(500).json({ error: error.message });
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
    console.log(`📊 Monitoring service status: ${monitoringService.getStatus().isMonitoring ? 'Active' : 'Inactive'}`);
});