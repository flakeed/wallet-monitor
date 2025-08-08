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

const startWebSocketService = async (groupId = null) => {
  let retries = 0;
  const maxRetries = 5;
  const retryDelay = 5000;

  while (retries < maxRetries) {
    try {
      await solanaWebSocketService.start(groupId);
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

setTimeout(() => startWebSocketService(), 2000);

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
    const groupId = req.query.groupId || null;
    const wallets = await db.getActiveWallets(groupId);
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
    const { address, name, groupIds } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
    }

    const wallet = await solanaWebSocketService.addWallet(address, name, groupIds);
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
    const groupId = req.query.groupId || null;

    const transactions = await db.getRecentTransactions(hours, limit, type, groupId);
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
    const { action, groupId } = req.body;

    if (action === 'start') {
      await solanaWebSocketService.start(groupId);
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

    const connection = new Connection(process.env.HELIUS_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=4fb4d8cd-7b1b-4b62-ac63-8b409e762b62', 'confirmed');
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
          solReceived: Number(row.sol_received).toFixed(6),
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
    const groupId = req.query.groupId || null;
    const stats = await db.getMonitoringStats(groupId);

    res.json({
      buyTransactions: stats.buy_transactions_today || 0,
      sellTransactions: stats.sell_transactions_today || 0,
      totalSolSpent: Number(stats.sol_spent_today || 0).toFixed(6),
      totalSolReceived: Number(stats.sol_received_today || 0).toFixed(6),
      uniqueTokens: stats.unique_tokens_today || 0,
      activeWallets: stats.active_wallets || 0,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching transaction stats:`, error);
    res.status(500).json({ error: 'Failed to fetch transaction stats' });
  }
});

app.get('/api/stats/tokens/top', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const operationType = req.query.operationType || null;
    const groupId = req.query.groupId || null;
    const topTokens = await db.getTopTokens(limit, operationType, groupId);

    res.json(
      topTokens.map((token) => ({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        buyCount: Number(token.buy_count || 0),
        sellCount: Number(token.sell_count || 0),
        uniqueWallets: Number(token.unique_wallets || 0),
        totalBought: Number(token.total_bought || 0).toFixed(6),
        totalSold: Number(token.total_sold || 0).toFixed(6),
        avgSolAmount: Number(token.avg_sol_amount || 0).toFixed(6),
      }))
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching top tokens:`, error);
    res.status(500).json({ error: 'Failed to fetch top tokens' });
  }
});

app.get('/api/tokens/aggregates', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const groupId = req.query.groupId || null;
    const aggregates = await db.getTokenWalletAggregates(hours, groupId);

    res.json(
      aggregates.map((agg) => ({
        mint: agg.mint,
        symbol: agg.symbol,
        name: agg.name,
        decimals: agg.decimals,
        wallet: {
          id: agg.wallet_id,
          address: agg.wallet_address,
          name: agg.wallet_name,
        },
        txBuys: Number(agg.tx_buys),
        txSells: Number(agg.tx_sells),
        solSpent: Number(agg.sol_spent).toFixed(6),
        solReceived: Number(agg.sol_received).toFixed(6),
        tokensBought: Number(agg.tokens_bought).toFixed(6),
        tokensSold: Number(agg.tokens_sold).toFixed(6),
        lastActivity: agg.last_activity,
      }))
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching token aggregates:`, error);
    res.status(500).json({ error: 'Failed to fetch token aggregates' });
  }
});

app.get('/api/tokens/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    const groupId = req.query.groupId || null;

    const [tokenInfo, operations, series] = await Promise.all([
      db.getTokenByMint(mint),
      db.getTokenOperations(mint, hours, groupId),
      db.getTokenInflowSeries(mint, hours, groupId),
    ]);

    if (!tokenInfo) {
      return res.status(404).json({ error: 'Token not found' });
    }

    res.json({
      token: {
        mint: tokenInfo.mint,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
      },
      operations: operations.map((op) => ({
        time: op.time,
        type: op.type,
        sol: Number(op.sol).toFixed(6),
        tokenAmount: Number(op.tokenAmount).toFixed(6),
        wallet: op.wallet,
      })),
      series: series.map((s) => ({
        time: s.bucket,
        buySol: Number(s.buy_sol).toFixed(6),
        sellSol: Number(s.sell_sol).toFixed(6),
        netSol: Number(s.net_sol).toFixed(6),
      })),
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching token data:`, error);
    res.status(500).json({ error: 'Failed to fetch token data' });
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const group = await db.addGroup(name);
    res.json({
      success: true,
      group,
      message: 'Group created successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error creating group:`, error);
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: 'Group name already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create group' });
    }
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await db.getGroups();
    res.json(groups);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching groups:`, error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.post('/api/wallets/:walletId/groups/:groupId', async (req, res) => {
  try {
    const { walletId, groupId } = req.params;
    await db.addWalletToGroup(walletId, groupId);
    res.json({
      success: true,
      message: 'Wallet added to group successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error adding wallet to group:`, error);
    res.status(500).json({ error: 'Failed to add wallet to group' });
  }
});

app.delete('/api/wallets/:walletId/groups/:groupId', async (req, res) => {
  try {
    const { walletId, groupId } = req.params;
    await db.removeWalletFromGroup(walletId, groupId);
    res.json({
      success: true,
      message: 'Wallet removed from group successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing wallet from group:`, error);
    if (error.message.includes('Wallet not found in group')) {
      res.status(404).json({ error: 'Wallet not found in group' });
    } else {
      res.status(500).json({ error: 'Failed to remove wallet from group' });
    }
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const dbHealth = await db.healthCheck();
    const monitoringStatus = monitoringService.getStatus();
    const websocketStatus = solanaWebSocketService.getStatus();
    res.json({
      status: 'healthy',
      database: dbHealth,
      monitoring: monitoringStatus,
      websocket: websocketStatus,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Health check failed:`, error);
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

const server = https.createServer(sslOptions, app);

server.listen(port, () => {
  console.log(`[${new Date().toISOString()}] 🌐 Server is running on https://localhost:${port}`);
});

process.on('SIGTERM', async () => {
  console.log(`[${new Date().toISOString()}] ⏹️ Received SIGTERM. Closing server...`);
  await solanaWebSocketService.stop();
  await monitoringService.close();
  server.close(() => {
    console.log(`[${new Date().toISOString()}] 🛑 Server closed`);
    process.exit(0);
  });
});