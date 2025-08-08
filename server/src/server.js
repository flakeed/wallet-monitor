const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
require('dotenv').config();
const { redis } = require('./services/tokenService');
const WalletMonitoringService = require('./services/monitoringService');
const Database = require('./database/connection');
const SolanaWebSocketService = require('./services/solanaWebSocketService');

const app = express();
const port = process.env.PORT || 5001;

const https = require('https');
const fs = require('fs');

// Load SSL certificates
const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/api-wallet-monitor.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/api-wallet-monitor.duckdns.org/fullchain.pem'),
};

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://wallet-monitor-client.vercel.app',
      'http://api-wallet-monitor.duckdns.org',
      'https://api-wallet-monitor.duckdns.org',
    ],
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

const monitoringService = new WalletMonitoringService();
const solanaWebSocketService = new SolanaWebSocketService();
const db = new Database();

const sseClients = new Set();

const startWebSocketService = async () => {
  let retries = 0;
  const maxRetries = 5;
  const retryDelay = 5000;

  while (retries < maxRetries) {
    try {
      await solanaWebSocketService.start();
      console.log(`[${new Date().toISOString()}] 🚀 Solana WebSocket service started successfully`);
      return;
    } catch (error) {
      retries++;
      console.error(
        `[${new Date().toISOString()}] ❌ Failed to start Solana WebSocket service (attempt ${retries}/${maxRetries}):`,
        error.message
      );
      if (retries < maxRetries) {
        console.log(`[${new Date().toISOString()}] ⏳ Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  console.error(`[${new Date().toISOString()}] 🛑 Max retries reached. WebSocket service failed to start.`);
};

setTimeout(startWebSocketService, 2000);

app.get('/api/transactions/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const subscriber = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');

  subscriber.subscribe('transactions', (err) => {
    if (err) {
      console.error(`[${new Date().toISOString()}] ❌ Redis subscription error:`, err.message);
      res.status(500).end();
      return;
    }
    console.log(`[${new Date().toISOString()}] ✅ New SSE client connected`);
    sseClients.add(res);
  });

  subscriber.on('message', (channel, message) => {
    if (channel === 'transactions' && res.writable) {
      console.log(`[${new Date().toISOString()}] 📡 Sending SSE message:`, message);
      res.write(`data: ${message}\n\n`);
    }
  });

  req.on('close', () => {
    console.log(`[${new Date().toISOString()}] 🔌 SSE client disconnected`);
    subscriber.unsubscribe();
    subscriber.quit();
    sseClients.delete(res);
    res.end();
  });

  const keepAlive = setInterval(() => {
    if (res.writable) {
      res.write(': keep-alive\n\n');
    } else {
      clearInterval(keepAlive);
    }
  }, 30000);
});

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
            netSOL: (Number(stats.total_sol_received || 0) - Number(stats.total_sol_spent || 0)).toFixed(6),
            lastTransactionAt: stats.last_transaction_at,
          },
        };
      })
    );
    res.json(walletsWithStats);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching wallets:`, error);
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

    const wallet = await solanaWebSocketService.addWallet(address, name);
    res.json({
      success: true,
      wallet,
      message: 'Wallet added for monitoring',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error adding wallet:`, error);
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

    await solanaWebSocketService.removeWallet(address);
    res.json({
      success: true,
      message: 'Wallet and all associated data removed successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing wallet:`, error);
    if (error.message.includes('Wallet not found')) {
      res.status(404).json({ error: 'Wallet not found in monitoring list' });
    } else {
      res.status(500).json({ error: 'Failed to remove wallet' });
    }
  }
});

app.delete('/api/wallets', async (req, res) => {
  try {
    await solanaWebSocketService.removeAllWallets();
    const result = await db.removeAllWallets();
    res.json({
      success: true,
      message: `Successfully removed wallets and associated data`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
    res.status(500).json({ error: 'Failed to remove all wallets' });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 400;
    const type = req.query.type;

    const transactions = await db.getRecentTransactions(hours, limit, type);
    const groupedTransactions = {};

    transactions.forEach((row) => {
      if (!groupedTransactions[row.signature]) {
        groupedTransactions[row.signature] = {
          signature: row.signature,
          time: row.block_time,
          transactionType: row.transaction_type,
          solSpent: row.sol_spent ? Number(row.sol_spent).toFixed(6) : null,
          solReceived: row.sol_received ? Number(row.sol_received).toFixed(6) : null,
          wallet: {
            address: row.wallet_address,
            name: row.wallet_name,
          },
          tokensBought: [],
          tokensSold: [],
        };
      }

      if (row.mint) {
        const tokenData = {
          mint: row.mint,
          symbol: row.symbol,
          name: row.token_name,
          amount: Number(row.token_amount),
          decimals: row.decimals || 6,
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
    console.error(`[${new Date().toISOString()}] ❌ Error fetching transactions:`, error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/monitoring/status', (req, res) => {
  try {
    const monitoringStatus = monitoringService.getStatus();
    const websocketStatus = solanaWebSocketService.getStatus();
    res.json({
      isMonitoring: websocketStatus.isConnected,
      processedSignatures: websocketStatus.messageCount,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting monitoring status:`, error);
    res.status(500).json({ error: 'Failed to get monitoring status' });
  }
});

app.post('/api/monitoring/toggle', async (req, res) => {
  try {
    const { action } = req.body;

    if (action === 'start') {
      await solanaWebSocketService.start();
      res.json({ success: true, message: 'WebSocket monitoring started' });
    } else if (action === 'stop') {
      await solanaWebSocketService.stop();
      res.json({ success: true, message: 'WebSocket monitoring stopped' });
    } else {
      res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error toggling monitoring:`, error);
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
    const walletTransactions = transactions.filter((tx) => tx.wallet_address === address);

    const groupedTransactions = {};
    walletTransactions.forEach((row) => {
      if (!groupedTransactions[row.signature]) {
        groupedTransactions[row.signature] = {
          signature: row.signature,
          time: row.block_time,
          transactionType: row.transaction_type,
          solSpent: row.sol_spent ? Number(row.sol_spent).toFixed(6) : null,
          solReceived: row.sol_received ? Number(row.sol_received).toFixed(6) : null,
          tokensBought: [],
          tokensSold: [],
        };
      }

      if (row.mint) {
        const tokenData = {
          mint: row.mint,
          symbol: row.token_name,
          name: row.token_name,
          amount: Number(row.token_amount),
          decimals: row.decimals || 6,
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
      operations,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in /api/wallet:`, error);
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
      netSOL: (Number(stats.sol_received_today || 0) - Number(stats.sol_spent_today || 0)).toFixed(6),
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching transaction stats:`, error);
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

    if (wallets.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 wallets allowed per bulk import' });
    }

    const results = {
      total: wallets.length,
      successful: 0,
      failed: 0,
      errors: [],
      successfulWallets: [],
    };

    for (const wallet of wallets) {
      if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
        results.failed++;
        results.errors.push({
          address: wallet.address || 'invalid',
          name: wallet.name || null,
          error: 'Invalid Solana wallet address format',
        });
        continue;
      }
    }

    const batchSize = 400;
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (wallet) => {
          const hasError = results.errors.some((error) => error.address === wallet.address);
          if (hasError) return;

          try {
            const addedWallet = await solanaWebSocketService.addWallet(wallet.address, wallet.name || null);
            results.successful++;
            results.successfulWallets.push({
              address: wallet.address,
              name: wallet.name || null,
              id: addedWallet.id,
            });
          } catch (error) {
            results.failed++;
            results.errors.push({
              address: wallet.address,
              name: wallet.name || null,
              error: error.message,
            });
          }
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    res.json({
      success: true,
      message: `Bulk import completed: ${results.successful} successful, ${results.failed} failed`,
      results,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in bulk wallet import:`, error);
    res.status(500).json({ error: 'Failed to import wallets' });
  }
});

app.get('/api/wallets/bulk-template', (req, res) => {
  const template = `# Bulk Wallet Import Template
# Format: address,name (name is optional)
# One wallet per line
# Lines starting with # are ignored
# Maximum 1000 wallets

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
      errors: [],
    };

    for (const wallet of wallets) {
      if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
        validation.invalid++;
        validation.errors.push({
          address: wallet.address || 'missing',
          name: wallet.name || null,
          error: 'Invalid Solana wallet address format',
        });
      } else {
        validation.valid++;
      }
    }

    res.json({
      success: true,
      validation,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error validating wallets:`, error);
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
    console.error(`[${new Date().toISOString()}] ❌ Error fetching top tokens:`, error);
    res.status(500).json({ error: 'Failed to fetch top tokens' });
  }
});

// Token-centric tracker with wallets and per-wallet PnL-like SOL net
app.get('/api/tokens/tracker', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const rows = await db.getTokenWalletAggregates(hours);

    const byToken = new Map();
    for (const row of rows) {
      if (!byToken.has(row.mint)) {
        byToken.set(row.mint, {
          mint: row.mint,
          symbol: row.symbol,
          name: row.name,
          decimals: row.decimals,
          wallets: [],
          summary: {
            uniqueWallets: 0,
            totalBuys: 0,
            totalSells: 0,
            totalSpentSOL: 0,
            totalReceivedSOL: 0,
          },
        });
      }
      const token = byToken.get(row.mint);
      const pnlSol = Number(row.sol_received) - Number(row.sol_spent);
      token.wallets.push({
        address: row.wallet_address,
        name: row.wallet_name,
        txBuys: Number(row.tx_buys) || 0,
        txSells: Number(row.tx_sells) || 0,
        solSpent: Number(row.sol_spent) || 0,
        solReceived: Number(row.sol_received) || 0,
        tokensBought: Number(row.tokens_bought) || 0,
        tokensSold: Number(row.tokens_sold) || 0,
        pnlSol: +pnlSol.toFixed(6),
        lastActivity: row.last_activity,
      });
      token.summary.uniqueWallets += 1;
      token.summary.totalBuys += Number(row.tx_buys) || 0;
      token.summary.totalSells += Number(row.tx_sells) || 0;
      token.summary.totalSpentSOL += Number(row.sol_spent) || 0;
      token.summary.totalReceivedSOL += Number(row.sol_received) || 0;
    }

    const result = Array.from(byToken.values()).map((t) => ({
      ...t,
      summary: {
        ...t.summary,
        netSOL: +(t.summary.totalReceivedSOL - t.summary.totalSpentSOL).toFixed(6),
      },
    }));

    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error building token tracker:`, error);
    res.status(500).json({ error: 'Failed to build token tracker' });
  }
});

app.get('/api/websocket/status', (req, res) => {
  try {
    const status = solanaWebSocketService.getStatus();
    res.json(status);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting WebSocket status:`, error);
    res.status(500).json({ error: 'Failed to get WebSocket status' });
  }
});

app.post('/api/websocket/reconnect', async (req, res) => {
  try {
    await solanaWebSocketService.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await solanaWebSocketService.start();
    res.json({
      success: true,
      message: 'WebSocket reconnected successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error reconnecting WebSocket:`, error);
    res.status(500).json({ error: 'Failed to reconnect WebSocket' });
  }
});

// ======= WALLET GROUP ENDPOINTS =======

// Get all wallet groups
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await db.getAllWalletGroups();
    res.json(groups);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching wallet groups:`, error);
    res.status(500).json({ error: 'Failed to fetch wallet groups' });
  }
});

// Get active wallet group
app.get('/api/groups/active', async (req, res) => {
  try {
    const activeGroup = await db.getActiveWalletGroup();
    if (!activeGroup) {
      return res.status(404).json({ error: 'No active group found' });
    }
    res.json(activeGroup);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching active group:`, error);
    res.status(500).json({ error: 'Failed to fetch active group' });
  }
});

// Create new wallet group
app.post('/api/groups', async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    if (name.length > 255) {
      return res.status(400).json({ error: 'Group name too long (max 255 characters)' });
    }

    const group = await solanaWebSocketService.createWalletGroup(name.trim(), description?.trim() || null);
    res.json({
      success: true,
      group,
      message: 'Wallet group created successfully'
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error creating wallet group:`, error);
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: 'Group with this name already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create wallet group' });
    }
  }
});

// Switch active group
app.post('/api/groups/:groupId/activate', async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    await solanaWebSocketService.switchToGroup(groupId);
    res.json({
      success: true,
      message: 'Successfully switched to new active group'
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error switching active group:`, error);
    res.status(500).json({ error: 'Failed to switch active group' });
  }
});

// Delete wallet group
app.delete('/api/groups/:groupId', async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    const deletedGroup = await db.deleteWalletGroup(groupId);
    res.json({
      success: true,
      group: deletedGroup,
      message: 'Wallet group deleted successfully'
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error deleting wallet group:`, error);
    if (error.message.includes('Cannot delete active group')) {
      res.status(400).json({ error: 'Cannot delete active group. Switch to another group first.' });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Group not found' });
    } else {
      res.status(500).json({ error: 'Failed to delete wallet group' });
    }
  }
});

// Get wallets in specific group
app.get('/api/groups/:groupId/wallets', async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    const wallets = await db.getWalletsInGroup(groupId);
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
            netSOL: (Number(stats.total_sol_received || 0) - Number(stats.total_sol_spent || 0)).toFixed(6),
            lastTransactionAt: stats.last_transaction_at,
          },
        };
      })
    );
    res.json(walletsWithStats);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching group wallets:`, error);
    res.status(500).json({ error: 'Failed to fetch group wallets' });
  }
});

// Add wallet to specific group
app.post('/api/groups/:groupId/wallets', async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const { address, name } = req.body;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    if (!address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
    }

    const wallet = await solanaWebSocketService.addWallet(address, name, groupId);
    res.json({
      success: true,
      wallet,
      message: 'Wallet added to group successfully'
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error adding wallet to group:`, error);
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: 'Wallet is already being monitored' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Add multiple wallets to specific group
app.post('/api/groups/:groupId/wallets/bulk', async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const { wallets } = req.body;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    if (!wallets || !Array.isArray(wallets)) {
      return res.status(400).json({ error: 'Wallets array is required' });
    }

    if (wallets.length === 0) {
      return res.status(400).json({ error: 'At least one wallet is required' });
    }

    if (wallets.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 wallets allowed per bulk import' });
    }

    // Validate wallet addresses
    const invalidWallets = [];
    const validWallets = [];

    for (const wallet of wallets) {
      if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
        invalidWallets.push({
          address: wallet.address || 'invalid',
          name: wallet.name || null,
          error: 'Invalid Solana wallet address format',
        });
      } else {
        validWallets.push(wallet);
      }
    }

    if (invalidWallets.length > 0) {
      return res.status(400).json({
        error: 'Invalid wallet addresses found',
        invalidWallets,
        validCount: validWallets.length
      });
    }

    const results = await solanaWebSocketService.addWalletsToGroup(validWallets, groupId);

    res.json({
      success: true,
      message: `Bulk import completed: ${results.successful} successful, ${results.failed} failed`,
      results
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in bulk wallet import to group:`, error);
    res.status(500).json({ error: 'Failed to import wallets to group' });
  }
});

// Remove wallet from specific group
app.delete('/api/groups/:groupId/wallets/:address', async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const address = req.params.address.trim();

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
    }

    const wallet = await db.getWalletByAddress(address);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    await db.removeWalletFromGroup(wallet.id, groupId);

    // If this was in the active group, refresh subscriptions
    const activeGroup = await db.getActiveWalletGroup();
    if (activeGroup && activeGroup.id === groupId) {
      await solanaWebSocketService.refreshSubscriptions();
    }

    res.json({
      success: true,
      message: 'Wallet removed from group successfully'
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing wallet from group:`, error);
    res.status(500).json({ error: 'Failed to remove wallet from group' });
  }
});

// Move wallets between groups
app.post('/api/groups/move-wallets', async (req, res) => {
  try {
    const { walletIds, fromGroupId, toGroupId } = req.body;

    if (!toGroupId) {
      return res.status(400).json({ error: 'Target group ID is required' });
    }

    if (!walletIds || !Array.isArray(walletIds) || walletIds.length === 0) {
      return res.status(400).json({ error: 'Wallet IDs array is required' });
    }

    const result = await db.moveWalletsBetweenGroups(walletIds, fromGroupId, toGroupId);

    // If we're moving from or to the active group, refresh subscriptions
    const activeGroup = await db.getActiveWalletGroup();
    if (activeGroup && (activeGroup.id === fromGroupId || activeGroup.id === toGroupId)) {
      await solanaWebSocketService.refreshSubscriptions();
    }

    res.json({
      success: true,
      message: `Successfully moved ${result.moved} wallets`,
      result
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error moving wallets between groups:`, error);
    res.status(500).json({ error: 'Failed to move wallets between groups' });
  }
});

// Refresh WebSocket subscriptions for active group
app.post('/api/groups/refresh-subscriptions', async (req, res) => {
  try {
    const result = await solanaWebSocketService.refreshSubscriptions();
    res.json({
      success: true,
      message: 'Subscriptions refreshed successfully',
      result
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error refreshing subscriptions:`, error);
    res.status(500).json({ error: 'Failed to refresh subscriptions' });
  }
});

// Get group statistics
app.get('/api/groups/:groupId/stats', async (req, res) => {
  try {
    const groupId = req.params.groupId;

    if (!groupId || groupId.trim().length === 0) {
      return res.status(400).json({ error: 'Group ID is required' });
    }

    const wallets = await db.getWalletsInGroup(groupId);
    const stats = {
      totalWallets: wallets.length,
      totalBuyTransactions: 0,
      totalSellTransactions: 0,
      totalSpentSOL: 0,
      totalReceivedSOL: 0,
      uniqueTokensBought: 0,
      uniqueTokensSold: 0,
      lastTransactionAt: null
    };

    for (const wallet of wallets) {
      const walletStats = await db.getWalletStats(wallet.id);
      stats.totalBuyTransactions += walletStats.total_buy_transactions || 0;
      stats.totalSellTransactions += walletStats.total_sell_transactions || 0;
      stats.totalSpentSOL += Number(walletStats.total_sol_spent || 0);
      stats.totalReceivedSOL += Number(walletStats.total_sol_received || 0);
      stats.uniqueTokensBought += walletStats.unique_tokens_bought || 0;
      stats.uniqueTokensSold += walletStats.unique_tokens_sold || 0;
      
      if (walletStats.last_transaction_at) {
        if (!stats.lastTransactionAt || walletStats.last_transaction_at > stats.lastTransactionAt) {
          stats.lastTransactionAt = walletStats.last_transaction_at;
        }
      }
    }

    // Format numbers
    stats.totalSpentSOL = Number(stats.totalSpentSOL).toFixed(6);
    stats.totalReceivedSOL = Number(stats.totalReceivedSOL).toFixed(6);
    stats.netSOL = (Number(stats.totalReceivedSOL) - Number(stats.totalSpentSOL)).toFixed(6);

    res.json(stats);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching group stats:`, error);
    res.status(500).json({ error: 'Failed to fetch group statistics' });
  }
});

// ======= UPDATED EXISTING ENDPOINTS =======

// Updated wallets endpoint to show active group wallets
app.get('/api/wallets', async (req, res) => {
  try {
    const wallets = await db.getActiveGroupWallets(); // Now returns active group wallets
    const walletsWithStats = await Promise.all(
      wallets.map(async (wallet) => {
        const stats = await db.getWalletStats(wallet.id);
        return {
          ...wallet,
          groupName: wallet.group_name, // Include group info
          stats: {
            totalBuyTransactions: stats.total_buy_transactions || 0,
            totalSellTransactions: stats.total_sell_transactions || 0,
            totalTransactions: (stats.total_buy_transactions || 0) + (stats.total_sell_transactions || 0),
            totalSpentSOL: Number(stats.total_sol_spent || 0).toFixed(6),
            totalReceivedSOL: Number(stats.total_sol_received || 0).toFixed(6),
            netSOL: (Number(stats.total_sol_received || 0) - Number(stats.total_sol_spent || 0)).toFixed(6),
            lastTransactionAt: stats.last_transaction_at,
          },
        };
      })
    );
    res.json(walletsWithStats);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching wallets:`, error);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

// Template for bulk group import
app.get('/api/groups/bulk-template', (req, res) => {
  const template = `# Bulk Wallet Group Import Template
# Format: address,name (name is optional)
# One wallet per line
# Lines starting with # are ignored
# Maximum 1000 wallets per group

# Example wallets (replace with real addresses):
9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Wallet 1
53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC,Important Trader
Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y
7dHbWXmci3dT1DHaV2R7uHWdwKz7V8L2MvX9Gt8kVeHN,Test Wallet`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="group-wallet-import-template.txt"');
  res.send(template);
});

process.on('SIGINT', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.stop();
  await redis.quit();
  sseClients.forEach((client) => client.end());
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.stop();
  await redis.quit();
  sseClients.forEach((client) => client.end());
  process.exit(0);
});

https.createServer(sslOptions, app).listen(port, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] 🚀 Server running on https://127.0.0.1:${port}`);
  console.log(`[${new Date().toISOString()}] 📡 Solana WebSocket monitoring: Starting...`);
  console.log(
    `[${new Date().toISOString()}] 📊 Legacy monitoring service status: ${
      monitoringService.getStatus().isMonitoring ? 'Active' : 'Inactive'
    }`
  );
});

// app.listen(port, '158.220.125.26', () => {
//   console.log(`[${new Date().toISOString()}] 🚀 Server running on http://158.220.125.26:${port}`);
//   console.log(`[${new Date().toISOString()}] 📡 Solana WebSocket monitoring: Starting...`);
//   console.log(
//     `[${new Date().toISOString()}] 📊 Legacy monitoring service status: ${
//       monitoringService.getStatus().isMonitoring ? 'Active' : 'Inactive'
//     }`
//   );
// });