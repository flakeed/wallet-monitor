const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
require('dotenv').config();
const { redis } = require('./services/tokenService');
const WalletMonitoringService = require('./services/monitoringService');
const Database = require('./database/connection');
const SolanaWebSocketService = require('./services/solanaWebSocketService');
const AuthMiddleware = require('./middleware/authMiddleware');
const PriceService = require('./services/priceService');
const priceRoutes = require('./priceRoutes');
const priceService = new PriceService();
const app = express();
const port = process.env.PORT || 5001;

const https = require('https');
const fs = require('fs');

const monitoringService = new WalletMonitoringService();
const solanaWebSocketService = new SolanaWebSocketService();
const db = new Database();
const auth = new AuthMiddleware(db);

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

app.use((req, res, next) => {
  req.setTimeout(300000); 
  res.setTimeout(300000);
  next();
});

// Authentication routes - остаются прежними для входа пользователей
app.post('/api/auth/telegram-simple', async (req, res) => {
  try {
    const { id, first_name, last_name, username } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }
    
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid Telegram ID format' });
    }
    
    console.log(`[${new Date().toISOString()}] 🔐 Simple auth attempt for Telegram ID: ${id}`);
    
    const isWhitelisted = await auth.isUserWhitelisted(id);
    if (!isWhitelisted) {
      return res.status(403).json({ 
        error: 'Access denied. You are not in the whitelist. Please contact an administrator.' 
      });
    }
    
    const userData = {
      id,
      username: username || null,
      first_name: first_name || 'User',
      last_name: last_name || null
    };
    
    const user = await auth.createOrUpdateUser(userData);
    
    if (!user.is_active) {
      return res.status(403).json({ 
        error: 'Your account has been deactivated. Please contact an administrator.' 
      });
    }
    
    const session = await auth.createUserSession(user.id);
    
    console.log(`[${new Date().toISOString()}] ✅ User authenticated via simple auth: ${user.username || user.first_name} (${user.telegram_id})`);
    
    res.json({
      success: true,
      sessionToken: session.session_token,
      expiresAt: session.expires_at,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        isAdmin: user.is_admin,
        isActive: user.is_active
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Simple auth error:`, error.message);
    res.status(500).json({ error: 'Authentication failed. Please try again.' });
  }
});

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const telegramData = req.body;
    
    if (telegramData.hash !== 'simple_auth') {
      auth.verifyTelegramAuth(telegramData);
    }
    
    const isWhitelisted = await auth.isUserWhitelisted(telegramData.id);
    if (!isWhitelisted) {
      return res.status(403).json({ 
        error: 'Access denied. You are not in the whitelist. Please contact an administrator.' 
      });
    }
    
    const user = await auth.createOrUpdateUser(telegramData);
    
    if (!user.is_active) {
      return res.status(403).json({ 
        error: 'Your account has been deactivated. Please contact an administrator.' 
      });
    }
    
    const session = await auth.createUserSession(user.id);
    
    console.log(`[${new Date().toISOString()}] ✅ User authenticated: ${user.username || user.first_name} (${user.telegram_id})`);
    
    res.json({
      success: true,
      sessionToken: session.session_token,
      expiresAt: session.expires_at,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name,
        isAdmin: user.is_admin,
        isActive: user.is_active
      }
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Auth error:`, error.message);
    res.status(401).json({ error: error.message });
  }
});

app.get('/api/auth/validate', auth.authRequired, (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Validation error:`, error.message);
    res.status(401).json({ error: 'Session validation failed' });
  }
});

app.post('/api/auth/logout', auth.authRequired, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sessionToken = authHeader.substring(7);
      await auth.revokeSession(sessionToken);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Logout error:`, error.message);
    res.json({ success: true, message: 'Logout completed' });
  }
});

// Admin routes - остаются прежними
app.get('/api/admin/whitelist', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const whitelist = await auth.getWhitelist();
    res.json(whitelist);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching whitelist:`, error);
    res.status(500).json({ error: 'Failed to fetch whitelist' });
  }
});

app.post('/api/admin/whitelist', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const { telegramId, notes } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }
    
    const result = await auth.addToWhitelist(telegramId, req.user.id, notes);
    res.json({ success: true, message: 'User added to whitelist', result });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error adding to whitelist:`, error);
    res.status(500).json({ error: 'Failed to add user to whitelist' });
  }
});

app.delete('/api/admin/whitelist/:telegramId', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const { telegramId } = req.params;
    await auth.removeFromWhitelist(telegramId);
    res.json({ success: true, message: 'User removed from whitelist' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing from whitelist:`, error);
    res.status(500).json({ error: 'Failed to remove user from whitelist' });
  }
});

app.get('/api/admin/users', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const query = `
      SELECT id, telegram_id, username, first_name, last_name, 
             is_active, is_admin, created_at, last_login
      FROM users 
      ORDER BY created_at DESC
    `;
    const result = await db.pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching users:`, error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.patch('/api/admin/users/:userId/status', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;
    
    const query = `
      UPDATE users 
      SET is_active = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *
    `;
    const result = await db.pool.query(query, [isActive, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, message: 'User status updated', user: result.rows[0] });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error updating user status:`, error);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

app.patch('/api/admin/users/:userId/admin', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isAdmin } = req.body;
    
    if (userId === req.user.id && !isAdmin) {
      return res.status(400).json({ error: 'You cannot remove admin privileges from yourself' });
    }
    
    const query = `
      UPDATE users 
      SET is_admin = $1, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $2 
      RETURNING *
    `;
    const result = await db.pool.query(query, [isAdmin, userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true, message: 'Admin status updated', user: result.rows[0] });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error updating admin status:`, error);
    res.status(500).json({ error: 'Failed to update admin status' });
  }
});

app.get('/api/admin/stats', auth.authRequired, auth.adminRequired, async (req, res) => {
  try {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_active = true) as active_users,
        (SELECT COUNT(*) FROM wallets) as total_wallets,
        (SELECT COUNT(*) FROM transactions) as total_transactions,
        (SELECT COUNT(*) FROM groups) as total_groups,
        (SELECT COUNT(*) FROM whitelist) as whitelist_size,
        (SELECT COALESCE(SUM(sol_spent), 0) FROM transactions) as total_sol_spent,
        (SELECT COALESCE(SUM(sol_received), 0) FROM transactions) as total_sol_received
    `;
    const result = await db.pool.query(query);
    res.json(result.rows[0]);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching admin stats:`, error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// ОБНОВЛЕНО: SSE без фильтрации по пользователям - все пользователи видят все транзакции
app.get('/api/transactions/stream', async (req, res) => {
  try {
    const token = req.query.token || (req.headers.authorization && req.headers.authorization.substring(7));
    
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const session = await auth.validateSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const groupId = req.query.groupId || null;
    
    console.log(`[${new Date().toISOString()}] ✅ SSE client authenticated: ${session.user_id}${groupId ? `, group ${groupId}` : ' (global)'}`);
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    res.flushHeaders();

    const subscriber = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');

    subscriber.subscribe('transactions', (err) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] ❌ Redis subscription error:`, err.message);
        res.status(500).end();
        return;
      }
      console.log(`[${new Date().toISOString()}] ✅ New SSE client connected globally${groupId ? ` for group ${groupId}` : ''}`);
      sseClients.add(res);
    });

    subscriber.on('message', async (channel, message) => {
      if (channel === 'transactions' && res.writable) {
        try {
          const transaction = JSON.parse(message);
          
          // Фильтруем только по группе если указана
          if (groupId && transaction.groupId !== groupId) {
            return;
          }
          
          console.log(`[${new Date().toISOString()}] 📡 Broadcasting SSE message globally: ${transaction.signature}`);
          res.write(`data: ${message}\n\n`);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ Error filtering SSE message:`, error.message);
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

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ SSE setup error:`, error.message);
    res.status(500).json({ error: 'Failed to setup SSE connection' });
  }
});

// ОБНОВЛЕНО: Глобальные эндпоинты кошельков - без фильтрации по пользователям
app.get('/api/wallets/count', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    
    console.log(`[${new Date().toISOString()}] ⚡ Global wallet count request${groupId ? ` for group ${groupId}` : ''}`);
    
    const countData = await db.getWalletCountFast(groupId);
    
    res.json({
      success: true,
      totalWallets: countData.totalWallets,
      groups: countData.groups,
      selectedGroup: countData.selectedGroup
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting wallet count:`, error);
    res.status(500).json({ error: 'Failed to get wallet count' });
  }
});

app.post('/api/wallets/validate', auth.authRequired, async (req, res) => {
  try {
    const { addresses } = req.body;

    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: 'Addresses array is required' });
    }

    if (addresses.length > 100000) {
      return res.status(400).json({ error: 'Maximum 100,000 addresses allowed for validation' });
    }

    console.log(`[${new Date().toISOString()}] ⚡ Validating ${addresses.length} wallet addresses globally`);

    // ОБНОВЛЕНО: Валидация без пользователя - проверяем глобальные дубликаты
    const existingQuery = `
      SELECT address 
      FROM wallets 
      WHERE address = ANY($1) AND is_active = true
    `;
    
    const result = await db.pool.query(existingQuery, [addresses]);
    const existingAddresses = new Set(result.rows.map(row => row.address));

    const valid = [];
    const duplicates = [];
    const invalid = [];

    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]+$/;

    addresses.forEach(address => {
      if (!address || address.length < 32 || address.length > 44 || !solanaAddressRegex.test(address)) {
        invalid.push(address);
      } else if (existingAddresses.has(address)) {
        duplicates.push(address);
      } else {
        valid.push(address);
      }
    });

    const validation = {
      valid,
      duplicates,
      invalid,
      summary: {
        total: addresses.length,
        validCount: valid.length,
        duplicateCount: duplicates.length,
        invalidCount: invalid.length
      }
    };
    
    res.json({
      success: true,
      validation,
      canProceed: validation.valid.length > 0,
      message: `Global validation complete: ${validation.valid.length} valid, ${validation.duplicates.length} duplicates, ${validation.invalid.length} invalid`
    });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error validating wallets:`, error);
    res.status(500).json({ error: 'Failed to validate wallets' });
  }
});

app.get('/api/wallets', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const includeStats = req.query.includeStats === 'true';
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    console.log(`[${new Date().toISOString()}] 📋 Global wallets request${groupId ? ` for group ${groupId}` : ''}, stats: ${includeStats}, limit: ${limit}`);
    
    if (includeStats) {
      const wallets = await db.getActiveWallets(groupId);
      const walletsWithStats = await Promise.all(
        wallets.slice(offset, offset + limit).map(async (wallet) => {
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
    } else {
      let query = `
        SELECT w.id, w.address, w.name, w.group_id, w.created_at,
               g.name as group_name, u.username as added_by_username,
               COUNT(*) OVER() as total_count
        FROM wallets w
        LEFT JOIN groups g ON w.group_id = g.id
        LEFT JOIN users u ON w.added_by = u.id
        WHERE w.is_active = TRUE
      `;
      const params = [];
      
      if (groupId) {
        query += ` AND w.group_id = $1`;
        params.push(groupId);
        query += ` ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`;
        params.push(limit, offset);
      } else {
        query += ` ORDER BY w.created_at DESC LIMIT $1 OFFSET $2`;
        params.push(limit, offset);
      }
      
      const result = await db.pool.query(query, params);
      
      const wallets = result.rows.map(row => ({
        id: row.id,
        address: row.address,
        name: row.name,
        group_id: row.group_id,
        group_name: row.group_name,
        added_by_username: row.added_by_username,
        created_at: row.created_at,
        stats: {
          totalTransactions: 0,
          totalSpentSOL: "0.000000",
          totalReceivedSOL: "0.000000", 
          netSOL: "0.000000"
        }
      }));
      
      res.json({
        wallets,
        totalCount: result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
        hasMore: result.rows.length === limit,
        limit,
        offset
      });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching wallets:`, error);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

app.delete('/api/wallets/:address', auth.authRequired, async (req, res) => {
  try {
    const address = req.params.address.trim();

    if (!address || address.length < 32 || address.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
    }

    // ОБНОВЛЕНО: Проверяем существование кошелька глобально (без пользователя)
    const wallet = await db.getWalletByAddress(address);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
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

app.delete('/api/wallets', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    
    console.log(`[${new Date().toISOString()}] 🗑️ Global removal request${groupId ? ` for group ${groupId}` : ''}`);
    
    // ОБНОВЛЕНО: Удаляем кошельки глобально (без фильтрации по пользователю)
    await solanaWebSocketService.removeAllWallets(groupId);
    
    const newCounts = await db.getWalletCountFast(groupId);
    
    res.json({
      success: true,
      message: `Successfully removed wallets and WebSocket subscriptions${groupId ? ` for group ${groupId}` : ' globally'}`,
      newCounts: {
        totalWallets: newCounts.totalWallets,
        groups: newCounts.groups,
        selectedGroup: newCounts.selectedGroup
      }
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in global wallet removal:`, error);
    res.status(500).json({ error: 'Failed to remove wallets' });
  }
});

// ОБНОВЛЕНО: Глобальный эндпоинт инициализации
app.get('/api/init', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const hours = parseInt(req.query.hours) || 24;
    const transactionType = req.query.type;
    
    console.log(`[${new Date().toISOString()}] 🚀 Global app initialization${groupId ? ` for group ${groupId}` : ''}`);
    const startTime = Date.now();
    
    // ОБНОВЛЕНО: Загрузка данных глобально (без userId)
    const [walletCounts, transactions, monitoringStatus, groups] = await Promise.all([
      db.getWalletCountFast(groupId),
      db.getRecentTransactionsOptimized(hours, 400, transactionType, groupId),
      db.getMonitoringStatusFast(groupId),
      db.getGroups()
    ]);
    
    const websocketStatus = solanaWebSocketService.getStatus();
    
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ⚡ Global initialization completed in ${duration}ms`);
    
    res.json({
      success: true,
      duration,
      data: {
        wallets: {
          totalCount: walletCounts.totalWallets,
          groups: walletCounts.groups,
          selectedGroup: walletCounts.selectedGroup
        },
        transactions,
        monitoring: {
          isMonitoring: websocketStatus.isConnected,
          processedSignatures: websocketStatus.messageCount,
          activeWallets: parseInt(monitoringStatus.active_wallets) || 0,
          activeGroupId: websocketStatus.activeGroupId,
          todayStats: {
            buyTransactions: parseInt(monitoringStatus.buy_transactions_today) || 0,
            sellTransactions: parseInt(monitoringStatus.sell_transactions_today) || 0,
            solSpent: Number(monitoringStatus.sol_spent_today || 0).toFixed(6),
            solReceived: Number(monitoringStatus.sol_received_today || 0).toFixed(6),
            uniqueTokens: parseInt(monitoringStatus.unique_tokens_today) || 0
          }
        },
        groups,
        performance: {
          loadTime: duration,
          optimizationLevel: 'GLOBAL'
        }
      }
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in global initialization:`, error);
    res.status(500).json({ error: 'Failed to initialize application data' });
  }
});

app.get('/api/transactions', auth.authRequired, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 400;
    const type = req.query.type;
    const groupId = req.query.groupId || null;

    console.log(`[${new Date().toISOString()}] ⚡ Global transactions request${groupId ? ` for group ${groupId}` : ''}, hours ${hours}, type ${type}`);

    // ОБНОВЛЕНО: Получаем транзакции глобально (без userId)
    const transactions = await db.getRecentTransactionsOptimized(hours, limit, type, groupId);
    
    console.log(`[${new Date().toISOString()}] ✅ Returning ${transactions.length} global transactions${groupId ? ` for group ${groupId}` : ''}`);
    res.json(transactions);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching global transactions:`, error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/monitoring/status', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    
    console.log(`[${new Date().toISOString()}] ⚡ Global monitoring status${groupId ? ` for group ${groupId}` : ''}`);
    
    // ОБНОВЛЕНО: Статус мониторинга глобально (без userId)
    const [websocketStatus, dbStats] = await Promise.all([
      Promise.resolve(solanaWebSocketService.getStatus()),
      db.getMonitoringStatusFast(groupId)
    ]);
    
    res.json({
      isMonitoring: websocketStatus.isConnected,
      processedSignatures: websocketStatus.messageCount,
      activeWallets: parseInt(dbStats.active_wallets) || 0,
      activeGroupId: websocketStatus.activeGroupId,
      todayStats: {
        buyTransactions: parseInt(dbStats.buy_transactions_today) || 0,
        sellTransactions: parseInt(dbStats.sell_transactions_today) || 0,
        solSpent: Number(dbStats.sol_spent_today || 0).toFixed(6),
        solReceived: Number(dbStats.sol_received_today || 0).toFixed(6),
        uniqueTokens: parseInt(dbStats.unique_tokens_today) || 0
      }
    });
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting global monitoring status:`, error);
    res.status(500).json({ error: 'Failed to get monitoring status' });
  }
});

// ОБНОВЛЕНО: Глобальное переключение мониторинга - без ограничения пользователя
app.post('/api/monitoring/toggle', auth.authRequired, async (req, res) => {
  try {
    const { action, groupId } = req.body;

    if (action === 'start') {
      await solanaWebSocketService.start(groupId); // Убрали параметр userId
      res.json({ success: true, message: `Global WebSocket monitoring started${groupId ? ` for group ${groupId}` : ''}` });
    } else if (action === 'stop') {
      await solanaWebSocketService.stop();
      res.json({ success: true, message: 'Global WebSocket monitoring stopped' });
    } else {
      res.status(400).json({ error: 'Invalid action. Use "start" or "stop"' });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error toggling global monitoring:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ОБНОВЛЕНО: Глобальный массовый импорт кошельков
app.post('/api/wallets/bulk-optimized', auth.authRequired, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { wallets, groupId } = req.body;
    const addedBy = req.user.id; // Отслеживаем кто добавил

    console.log(`[${new Date().toISOString()}] 🚀 Global bulk import: ${wallets?.length || 0} wallets by user ${req.user.username || req.user.id}`);

    if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Non-empty wallets array is required' 
      });
    }

    if (wallets.length > 1000) {
      return res.status(400).json({ 
        success: false,
        error: 'Maximum 1,000 wallets allowed per batch' 
      });
    }

    const results = {
      total: wallets.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      successfulWallets: [],
      newCounts: null
    };

    // Быстрая локальная валидация
    console.log(`[${new Date().toISOString()}] ⚡ Global validation...`);
    const validationStart = Date.now();

    const validWallets = [];
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const seenAddresses = new Set();

    for (const wallet of wallets) {
      if (!wallet || !wallet.address) {
        results.failed++;
        results.errors.push({
          address: 'unknown',
          name: wallet?.name || null,
          error: 'Missing wallet address'
        });
        continue;
      }

      const address = wallet.address.trim();

      if (address.length < 32 || address.length > 44 || !solanaAddressRegex.test(address)) {
        results.failed++;
        results.errors.push({
          address: address,
          name: wallet.name || null,
          error: 'Invalid Solana address format'
        });
        continue;
      }

      if (seenAddresses.has(address)) {
        results.failed++;
        results.errors.push({
          address: address,
          name: wallet.name || null,
          error: 'Duplicate address in current batch'
        });
        continue;
      }

      seenAddresses.add(address);
      validWallets.push({
        address: address,
        name: wallet.name?.trim() || null,
        addedBy,
        groupId: groupId || null
      });
    }

    const validationTime = Date.now() - validationStart;
    console.log(`[${new Date().toISOString()}] ⚡ Global validation completed in ${validationTime}ms: ${validWallets.length}/${wallets.length} valid`);

    if (validWallets.length === 0) {
      return res.json({
        success: false,
        message: 'No valid wallets to import after validation',
        results,
        duration: Date.now() - startTime
      });
    }

    // Глобальная база данных batch insert
    console.log(`[${new Date().toISOString()}] 🗄️ Global database operation...`);
    const dbStart = Date.now();

    try {
      const insertedWallets = await db.addWalletsBatchOptimized(validWallets);
      
      const dbTime = Date.now() - dbStart;
      console.log(`[${new Date().toISOString()}] ⚡ Global DB completed in ${dbTime}ms: ${insertedWallets.length} wallets`);

      results.successful = insertedWallets.length;
      results.failed += (validWallets.length - insertedWallets.length);
      results.successfulWallets = insertedWallets.map(wallet => ({
        address: wallet.address,
        name: wallet.name,
        id: wallet.id,
        groupId: wallet.group_id,
        addedBy: wallet.added_by
      }));

      // Обновляем счетчики
      const newCounts = await db.getWalletCountFast(groupId);
      results.newCounts = newCounts;

    } catch (dbError) {
      console.error(`[${new Date().toISOString()}] ❌ Global DB error:`, dbError.message);
      throw new Error(`Database operation failed: ${dbError.message}`);
    }

    // Неблокирующая подписка WebSocket
    if (results.successful > 0) {
      console.log(`[${new Date().toISOString()}] 🔗 Starting global WebSocket subscriptions...`);
      
      setImmediate(async () => {
        try {
          const addressesToSubscribe = results.successfulWallets.map(w => w.address);
          
          // Подписываемся если релевантно для активного мониторинга
          const relevantAddresses = results.successfulWallets
            .filter(wallet => !solanaWebSocketService.activeGroupId || wallet.groupId === solanaWebSocketService.activeGroupId)
            .map(w => w.address);

          if (relevantAddresses.length > 0 && solanaWebSocketService.ws && solanaWebSocketService.ws.readyState === 1) {
            await solanaWebSocketService.subscribeToWalletsBatch(relevantAddresses, 200);
            console.log(`[${new Date().toISOString()}] ✅ Global WebSocket subscriptions completed: ${relevantAddresses.length} wallets`);
          } else {
            console.log(`[${new Date().toISOString()}] ⏭️ Skipping WebSocket subscriptions: ${relevantAddresses.length} relevant, WS ready: ${solanaWebSocketService.ws?.readyState === 1}`);
          }
        } catch (wsError) {
          console.warn(`[${new Date().toISOString()}] ⚠️ Global WebSocket subscription failed:`, wsError.message);
        }
      });
    }

    const duration = Date.now() - startTime;
    const walletsPerSecond = Math.round((results.successful / duration) * 1000);

    console.log(`[${new Date().toISOString()}] 🎉 Global bulk import completed in ${duration}ms: ${results.successful}/${results.total} successful (${walletsPerSecond} wallets/sec)`);

    res.json({
      success: results.successful > 0,
      message: `Global import: ${results.successful} successful, ${results.failed} failed out of ${results.total} total`,
      results,
      duration,
      performance: {
        walletsPerSecond,
        totalTime: duration,
        averageTimePerWallet: Math.round(duration / results.total),
        optimizationLevel: 'GLOBAL'
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] ❌ Global bulk import failed after ${duration}ms:`, error);
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error during global bulk import',
      details: error.message,
      duration
    });
  }
});

// Эндпоинты цен остаются прежними
app.get('/api/solana/price', auth.authRequired, async (req, res) => {
  try {
    const priceData = await priceService.getSolPrice();
    res.json(priceData);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in price endpoint:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch SOL price',
      price: 150
    });
  }
});

app.use('/api/tokens', priceRoutes);

app.post('/api/tokens/prices', auth.authRequired, async (req, res) => {
  try {
    const { mints } = req.body;
    if (!mints || !Array.isArray(mints)) {
      return res.status(400).json({ error: 'Mints array is required' });
    }
    if (mints.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 mints allowed per request' });
    }
    console.log(`[${new Date().toISOString()}] 📊 Batch price request for ${mints.length} tokens`);
    const startTime = Date.now();
    const prices = await priceService.getTokenPrices(mints);
    const duration = Date.now() - startTime;
    const result = {};
    prices.forEach((data, mint) => {
      result[mint] = {
        price: data?.price || 0,
        liquidity: data?.liquidity || 0,
        marketCap: data?.marketCap || 0,
        deployTime: data?.deployTime || null,
        timeSinceDeployMs: data?.timeSinceDeployMs || 0,
        error: data?.error || null
      };
    });
    console.log(`[${new Date().toISOString()}] ✅ Batch price request completed in ${duration}ms`);
    res.json({
      success: true,
      prices: result,
      count: prices.size,
      duration
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error in batch price endpoint:`, error.message);
    res.status(500).json({ error: 'Failed to fetch token prices' });
  }
});

app.get('/api/prices/stats', auth.authRequired, auth.adminRequired, (req, res) => {
  try {
    const stats = priceService.getStats();
    res.json(stats);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting price stats:`, error.message);
    res.status(500).json({ error: 'Failed to get price service stats' });
  }
});

// ОБНОВЛЕНО: Глобальные группы - без владения пользователями
app.get('/api/groups', auth.authRequired, async (req, res) => {
  try {
    const groups = await db.getGroups();
    res.json(groups);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching groups:`, error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.post('/api/groups', auth.authRequired, async (req, res) => {
  try {
    const { name } = req.body;
    const createdBy = req.user.id;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    const group = await db.addGroup(name.trim(), createdBy);
    res.json({
      success: true,
      group,
      message: 'Global group created successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error creating group:`, error);
    if (error.message.includes('already exists')) {
      res.status(409).json({ error: 'Group name already exists globally' });
    } else {
      res.status(500).json({ error: 'Failed to create group' });
    }
  }
});

// ОБНОВЛЕНО: Глобальное переключение групп - без ограничения пользователя
app.post('/api/groups/switch', auth.authRequired, async (req, res) => {
  try {
    const { groupId } = req.body;
    
    // Проверяем существование группы если указан groupId
    if (groupId) {
      const query = `SELECT id FROM groups WHERE id = $1`;
      const result = await db.pool.query(query, [groupId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Group not found' });
      }
    }
    
    await solanaWebSocketService.switchGroup(groupId); // Убрали параметр userId
    res.json({
      success: true,
      message: `Switched to global group ${groupId || 'all'}`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error switching group:`, error);
    res.status(500).json({ error: 'Failed to switch group' });
  }
});

// Периодическая очистка истекших сессий
setInterval(async () => {
  try {
    const cleaned = await auth.cleanExpiredSessions();
    if (cleaned > 0) {
      console.log(`[${new Date().toISOString()}] 🧹 Cleaned ${cleaned} expired sessions`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error cleaning sessions:`, error);
  }
}, 60 * 60 * 1000);

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

const startWebSocketService = async () => {
  let retries = 0;
  const maxRetries = 5;
  const retryDelay = 5000;

  while (retries < maxRetries) {
    try {
      await solanaWebSocketService.start(); // Убрали параметр userId
      console.log(`[${new Date().toISOString()}] 🚀 Global Solana WebSocket service started successfully`);
      return;
    } catch (error) {
      retries++;
      console.error(
        `[${new Date().toISOString()}] ❌ Failed to start global WebSocket service (attempt ${retries}/${maxRetries}):`,
        error.message
      );
      if (retries < maxRetries) {
        console.log(`[${new Date().toISOString()}] ⏳ Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }
  console.error(`[${new Date().toISOString()}] 🛑 Max retries reached. Global WebSocket service failed to start.`);
};

setTimeout(startWebSocketService, 2000);

https.createServer(sslOptions, app).listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] 🚀 Global wallet monitoring server running on https://0.0.0.0:${port}`);
    console.log(`[${new Date().toISOString()}] 🌍 System mode: GLOBAL - All users share wallets, groups, and monitoring`);
});