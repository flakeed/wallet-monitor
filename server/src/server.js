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
  // ИСПРАВЛЕНО: НЕ парсим groupId как число, оставляем как строку (UUID)
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
        
        // ИСПРАВЛЕНО: сравнение UUID строк
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
    const groupId = req.query.groupId || null; // Оставляем как строку
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
    const { address, name, groupId } = req.body;

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
    const groupId = req.query.groupId || null; // Оставляем как строку

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
    const groupId = req.query.groupId || null; // Оставляем как строку
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
      groupId: wallet.group_id,
      groupName: wallet.group_name,
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
    const groupId = req.query.groupId || null; // Оставляем как строку
    const stats = await db.getMonitoringStats(groupId);

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
    const { wallets: inputWallets, groupId } = req.body;

    if (!inputWallets || !Array.isArray(inputWallets)) {
      return res.status(400).json({ error: 'Wallets array is required' });
    }

    if (inputWallets.length === 0) {
      return res.status(400).json({ error: 'At least one wallet is required' });
    }

    if (inputWallets.length > 10000) {
      return res.status(400).json({ error: 'Maximum 10000 wallets allowed per bulk import' });
    }

    const results = {
      total: inputWallets.length,
      successful: 0,
      failed: 0,
      errors: [],
      successfulWallets: [],
    };

    const processedWallets = [];
    for (const wallet of inputWallets) {
      let { address, name } = wallet;
      let originalAddress = address;

      // Detect and handle extra characters
      if (address && address.length > 44) {
        const extraChars = address.slice(44);
        address = address.slice(0, 44); // Trim to 44 characters
        if (!/^[1-9A-HJ-NP-Za-km-z]{44}$/.test(address)) {
          results.failed++;
          results.errors.push({
            original: originalAddress,
            address,
            name,
            error: `Invalid address format with extra characters: "${extraChars}"`,
          });
          continue;
        } else {
          results.errors.push({
            original: originalAddress,
            address,
            name,
            error: `Extra characters detected and trimmed: "${extraChars}"`,
          });
        }
      } else if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
        results.failed++;
        results.errors.push({
          original: originalAddress,
          address,
          name,
          error: 'Invalid Solana wallet address format',
        });
        continue;
      }

      processedWallets.push({ address, name });
    }

    const batchSize = 400;
    for (let i = 0; i < processedWallets.length; i += batchSize) {
      const batch = processedWallets.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (wallet) => {
          try {
            const addedWallet = await solanaWebSocketService.addWallet(wallet.address, wallet.name || null, groupId);
            results.successful++;
            results.successfulWallets.push({
              address: wallet.address,
              name: wallet.name || null,
              id: addedWallet.id,
              groupId: addedWallet.group_id,
            });
          } catch (error) {
            results.failed++;
            results.errors.push({
              original: wallet.address,
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
# Maximum 10000 wallets
# Extra characters will be detected and trimmed if possible

# Example wallets (replace with real addresses):
9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd,Wallet 1
53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucCxxx,Important Trader  # Extra 'xxx' will be trimmed
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
    const groupId = req.query.groupId || null; // Оставляем как строку

    const topTokens = await db.getTopTokens(limit, type, groupId);
    res.json(topTokens);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching top tokens:`, error);
    res.status(500).json({ error: 'Failed to fetch top tokens' });
  }
});

// Token-centric tracker with wallets and per-wallet PnL-like SOL net
// Исправленный endpoint в вашем основном файле сервера
app.get('/api/tokens/tracker', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    // ИСПРАВЛЕНО: НЕ парсим как число, оставляем как строку UUID
    const groupId = req.query.groupId || null;
    
    console.log(`[${new Date().toISOString()}] 🔍 Token tracker request: hours=${hours}, groupId=${groupId}`);
    
    const rows = await db.getTokenWalletAggregates(hours, groupId);
    
    console.log(`[${new Date().toISOString()}] 📊 Token tracker found ${rows.length} wallet-token combinations`);

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
        groupId: row.group_id,
        groupName: row.group_name,
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

    result.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));

    console.log(`[${new Date().toISOString()}] 📈 Returning ${result.length} tokens for tracker`);
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
    const { groupId } = req.body;
    await solanaWebSocketService.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await solanaWebSocketService.start(groupId);
    res.json({
      success: true,
      message: `WebSocket reconnected successfully${groupId ? ` for group ${groupId}` : ''}`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error reconnecting WebSocket:`, error);
    res.status(500).json({ error: 'Failed to reconnect WebSocket' });
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

process.on('SIGINT', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.shutdown(); // Используем shutdown вместо stop
  await redis.quit();
  sseClients.forEach((client) => client.end());
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(`[${new Date().toISOString()}] 🛑 Shutting down server...`);
  await monitoringService.close();
  await solanaWebSocketService.shutdown(); // Используем shutdown вместо stop
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