const express = require('express');
const cors = require('cors');
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

const monitoringService = new WalletMonitoringService();
const solanaWebSocketService = new SolanaWebSocketService();
const db = new Database();

const sseClients = new Set();

app.use(express.json({ 
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ 
  limit: '50mb', 
  extended: true,
  parameterLimit: 50000
}));

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

app.use((req, res, next) => {
  req.setTimeout(300000); 
  res.setTimeout(300000);
  next();
});

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

app.use('/api/wallets/bulk', (req, res, next) => {
  console.log(`[${new Date().toISOString()}] 📥 Bulk import request received`);
  console.log(`- Content-Length: ${req.get('Content-Length')}`);
  console.log(`- Content-Type: ${req.get('Content-Type')}`);
  
  req.setTimeout(1200000); 
  res.setTimeout(1200000); 
  
  next();
});

app.get('/api/transactions/stream', (req, res) => {
  const groupId = req.query.groupId || null;
  
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
    console.log(`[${new Date().toISOString()}] ✅ New SSE client connected${groupId ? ` for group ${groupId}` : ''}`);
    sseClients.add(res);
  });

  subscriber.on('message', (channel, message) => {
    if (channel === 'transactions' && res.writable) {
      try {
        const transaction = JSON.parse(message);
        
        if (groupId !== null && transaction.groupId !== groupId) {
          console.log(`[${new Date().toISOString()}] 🔍 Filtering out transaction for group ${transaction.groupId} (client wants ${groupId})`);
          return;
        }
        
        console.log(`[${new Date().toISOString()}] 📡 Sending SSE message for group ${transaction.groupId}:`, message.substring(0, 100) + '...');
        res.write(`data: ${message}\n\n`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error parsing SSE message:`, error.message);
        res.write(`data: ${message}\n\n`);
      }
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
    const groupId = req.query.groupId || null;
    await solanaWebSocketService.removeAllWallets(groupId);
    const result = await db.removeAllWallets(groupId);
    res.json({
      success: true,
      message: `Successfully removed wallets and associated data${groupId ? ` for group ${groupId}` : ''}`,
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
            group_id: row.group_id,
            group_name: row.group_name,
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

app.get('/api/monitoring/status', async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const monitoringStatus = monitoringService.getStatus();
    const websocketStatus = solanaWebSocketService.getStatus();
    const dbStats = await db.getMonitoringStats(groupId);
    res.json({
      isMonitoring: websocketStatus.isConnected,
      processedSignatures: websocketStatus.messageCount,
      activeWallets: dbStats.active_wallets || 0,
      activeGroupId: websocketStatus.activeGroupId,
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
      res.json({ success: true, message: `WebSocket monitoring started${groupId ? ` for group ${groupId}` : ''}` });
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

app.post('/api/wallets/bulk', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { wallets, groupId } = req.body;

    if (!wallets || !Array.isArray(wallets)) {
      return res.status(400).json({ 
        success: false,
        error: 'Wallets array is required' 
      });
    }

    if (wallets.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'At least one wallet is required' 
      });
    }

    if (wallets.length > 10000) {
      return res.status(400).json({ 
        success: false,
        error: 'Maximum 10,000 wallets allowed per bulk import' 
      });
    }

    console.log(`[${new Date().toISOString()}] 📥 Starting bulk import of ${wallets.length} wallets`);

    const results = {
      total: wallets.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      successfulWallets: []
    };

    const validWallets = [];
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      
      if (!wallet || !wallet.address) {
        results.failed++;
        results.errors.push({
          address: 'unknown',
          name: wallet?.name || null,
          error: 'Missing wallet address'
        });
        continue;
      }

      if (!solanaAddressRegex.test(wallet.address)) {
        results.failed++;
        results.errors.push({
          address: wallet.address,
          name: wallet.name || null,
          error: 'Invalid Solana address format'
        });
        continue;
      }

      validWallets.push({
        address: wallet.address.trim(),
        name: wallet.name?.trim() || null
      });
    }

    if (validWallets.length === 0) {
      return res.json({
        success: false,
        message: 'No valid wallets to import',
        results
      });
    }

    console.log(`[${new Date().toISOString()}] ✅ ${validWallets.length} wallets passed validation`);

    const BATCH_SIZE = 100; 
    const totalBatches = Math.ceil(validWallets.length / BATCH_SIZE);
    
    console.log(`[${new Date().toISOString()}] 🔄 Processing ${totalBatches} batches of ${BATCH_SIZE} wallets each`);

    for (let i = 0; i < validWallets.length; i += BATCH_SIZE) {
      const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
      const batch = validWallets.slice(i, i + BATCH_SIZE);
      
      console.log(`[${new Date().toISOString()}] 📦 Processing batch ${currentBatch}/${totalBatches} (${batch.length} wallets)`);

      for (const wallet of batch) {
        try {
          const addedWallet = await solanaWebSocketService.addWallet(
            wallet.address, 
            wallet.name, 
            groupId
          );
          
          results.successful++;
          results.successfulWallets.push({
            address: wallet.address,
            name: wallet.name,
            id: addedWallet.id,
            groupId: addedWallet.group_id,
          });

        } catch (error) {
          results.failed++;
          results.errors.push({
            address: wallet.address,
            name: wallet.name,
            error: error.message || 'Unknown error'
          });
        }
      }

      if (i + BATCH_SIZE < validWallets.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      console.log(`[${new Date().toISOString()}] ✅ Batch ${currentBatch}/${totalBatches} complete. Total: ${results.successful} successful, ${results.failed} failed`);
    }

    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] 🎉 Bulk import completed in ${duration}ms: ${results.successful}/${results.total} successful`);

    res.json({
      success: results.successful > 0,
      message: `Bulk import completed: ${results.successful} successful, ${results.failed} failed out of ${results.total} total`,
      results,
      duration: duration
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] ❌ Bulk import failed after ${duration}ms:`, error);
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error during bulk import',
      details: error.message,
      duration: duration
    });
  }
});

app.get('/api/solana/price', async (req, res) => {
  try {
    const solPrice = await monitoringService.fetchSolPrice();
    res.json({
      success: true,
      price: solPrice,
      currency: 'USD',
      lastUpdated: monitoringService.solPriceCache.lastUpdated
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
    res.status(500).json({ error: 'Failed to fetch SOL price' });
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

app.post('/api/groups', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const group = await db.addGroup(name.trim());
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

app.post('/api/groups/switch', async (req, res) => {
  try {
    const { groupId } = req.body;
    await solanaWebSocketService.switchGroup(groupId);
    res.json({
      success: true,
      message: `Switched to group ${groupId || 'all'}`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error switching group:`, error);
    res.status(500).json({ error: 'Failed to switch group' });
  }
});

app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ❌ Server Error:`, error);
  
  if (res.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Request too large. Maximum 50MB allowed.',
      code: 'REQUEST_TOO_LARGE'
    });
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON format in request body.',
      code: 'JSON_PARSE_ERROR'
    });
  }

  if (error.code === 'TIMEOUT') {
    return res.status(408).json({
      success: false,
      error: 'Request timeout. Try with smaller batches.',
      code: 'TIMEOUT'
    });
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message,
    code: 'INTERNAL_ERROR'
  });
});

process.on('SIGINT', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.shutdown(); 
  await redis.quit();
  sseClients.forEach((client) => client.end());
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.shutdown(); 
  await redis.quit();
  sseClients.forEach((client) => client.end());
  process.exit(0);
});

https.createServer(sslOptions, app).listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] 🚀 Server running on https://0.0.0.0:${port}`);
});