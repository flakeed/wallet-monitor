const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
require('dotenv').config();
const { redis } = require('./services/tokenService');
const WalletMonitoringService = require('./services/monitoringService');
const Database = require('./database/connection');
const SolanaWebSocketService = require('./services/solanaWebSocketService');
const AuthMiddleware = require('./middleware/authMiddleware');

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

// Authentication routes
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const telegramData = req.body;
    
    // Verify Telegram auth data
    auth.verifyTelegramAuth(telegramData);
    
    // Check if user is whitelisted
    const isWhitelisted = await auth.isUserWhitelisted(telegramData.id);
    if (!isWhitelisted) {
      return res.status(403).json({ 
        error: 'Access denied. You are not in the whitelist. Please contact an administrator.' 
      });
    }
    
    // Create or update user
    const user = await auth.createOrUpdateUser(telegramData);
    
    if (!user.is_active) {
      return res.status(403).json({ 
        error: 'Your account has been deactivated. Please contact an administrator.' 
      });
    }
    
    // Create session
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
  res.json({
    success: true,
    user: req.user
  });
});

app.post('/api/auth/logout', auth.authRequired, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader.substring(7);
    await auth.revokeSession(sessionToken);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Logout error:`, error.message);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Admin routes
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
    
    // Prevent removing admin from yourself
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

// Protected routes - all existing routes now require authentication
app.get('/api/transactions/stream', async (req, res) => {
  try {
    // Get token from query parameter or Authorization header
    const token = req.query.token || (req.headers.authorization && req.headers.authorization.substring(7));
    
    if (!token) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    // Validate the session token
    const session = await auth.validateSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const groupId = req.query.groupId || null;
    const userId = session.user_id;
    
    console.log(`[${new Date().toISOString()}] ✅ SSE client authenticated for user ${userId}${groupId ? `, group ${groupId}` : ''}`);
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    res.flushHeaders();

    const subscriber = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');

    subscriber.subscribe('transactions', (err) => {
      if (err) {
        console.error(`[${new Date().toISOString()}] ❌ Redis subscription error:`, err.message);
        res.status(500).end();
        return;
      }
      console.log(`[${new Date().toISOString()}] ✅ New SSE client connected for user ${userId}${groupId ? `, group ${groupId}` : ''}`);
      sseClients.add(res);
    });

    subscriber.on('message', async (channel, message) => {
      if (channel === 'transactions' && res.writable) {
        try {
          const transaction = JSON.parse(message);
          
          // ВАЖНО: Проверяем принадлежность транзакции пользователю
          // Получаем информацию о кошельке из базы данных
          const wallet = await db.getWalletByAddress(transaction.walletAddress);
          
          if (!wallet) {
            console.log(`[${new Date().toISOString()}] ⏭️ Wallet ${transaction.walletAddress} not found, skipping transaction`);
            return;
          }
          
          // Фильтруем по пользователю
          if (wallet.user_id !== userId) {
            console.log(`[${new Date().toISOString()}] ⏭️ Transaction for wallet ${transaction.walletAddress} belongs to different user (${wallet.user_id} != ${userId}), skipping`);
            return;
          }
          
          // Фильтруем по группе если указана
          if (groupId !== null && wallet.group_id !== groupId) {
            console.log(`[${new Date().toISOString()}] ⏭️ Transaction for wallet ${transaction.walletAddress} belongs to different group (${wallet.group_id} != ${groupId}), skipping`);
            return;
          }
          
          console.log(`[${new Date().toISOString()}] 📡 Sending SSE message for user ${userId}: ${transaction.signature}`);
          res.write(`data: ${message}\n\n`);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ Error filtering SSE message:`, error.message);
        }
      }
    });

    req.on('close', () => {
      console.log(`[${new Date().toISOString()}] 🔌 SSE client disconnected for user ${userId}`);
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

app.get('/api/wallets', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const userId = req.user.id;
    const wallets = await db.getActiveWallets(groupId, userId);
    res.json(wallets); // Return wallets directly without stats
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching wallets:`, error);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

app.delete('/api/wallets/:address', auth.authRequired, async (req, res) => {
  try {
    const address = req.params.address.trim();
    const userId = req.user.id;

    if (!address || address.length < 32 || address.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
  }
    // Check if wallet belongs to user
    const wallet = await db.getWalletByAddress(address);
    if (!wallet || wallet.user_id !== userId) {
      return res.status(404).json({ error: 'Wallet not found or access denied' });
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
    const userId = req.user.id;
    
    console.log(`[${new Date().toISOString()}] 🗑️ User ${userId} requesting removal of all wallets${groupId ? ` for group ${groupId}` : ''}`);
    
    // Используем WebSocket сервис для корректной отписки
    await solanaWebSocketService.removeAllWallets(groupId, userId);
    
    res.json({
      success: true,
      message: `Successfully removed wallets and WebSocket subscriptions${groupId ? ` for group ${groupId}` : ''}`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
    res.status(500).json({ error: 'Failed to remove all wallets' });
  }
});

app.get('/api/transactions', auth.authRequired, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 400;
    const type = req.query.type;
    const groupId = req.query.groupId || null;
    const userId = req.user.id; // Используем ID текущего пользователя

    console.log(`[${new Date().toISOString()}] 📊 Fetching transactions for user ${userId}, group ${groupId}, hours ${hours}, type ${type}`);

    // Используем метод из database с пользовательским фильтром
    const transactions = await db.getRecentTransactions(hours, limit, type, groupId, userId);
    
    // Группируем транзакции по signature
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

      // Добавляем токены если они есть
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
    console.log(`[${new Date().toISOString()}] ✅ Returning ${result.length} transactions for user ${userId}`);
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching transactions:`, error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/monitoring/status', auth.authRequired, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const userId = req.user.id;
    const monitoringStatus = monitoringService.getStatus();
    const websocketStatus = solanaWebSocketService.getStatus();
    
    // Get user-specific stats
    const query = `
      SELECT 
        COUNT(w.id) as active_wallets,
        COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as buy_transactions_today,
        COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as sell_transactions_today,
        COALESCE(SUM(t.sol_spent), 0) as sol_spent_today,
        COALESCE(SUM(t.sol_received), 0) as sol_received_today,
        COUNT(DISTINCT to_.token_id) as unique_tokens_today
      FROM wallets w
      LEFT JOIN transactions t ON w.id = t.wallet_id 
        AND t.block_time >= CURRENT_DATE
      LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
      WHERE w.is_active = TRUE AND w.user_id = $1
      ${groupId ? 'AND w.group_id = $2' : ''}
    `;
    
    const params = groupId ? [userId, groupId] : [userId];
    const result = await db.pool.query(query, params);
    const dbStats = result.rows[0];
    
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

app.post('/api/monitoring/toggle', auth.authRequired, async (req, res) => {
  try {
    const { action, groupId } = req.body;
    const userId = req.user.id;

    if (action === 'start') {
      await solanaWebSocketService.start(groupId, userId);
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

app.post('/api/wallets/bulk', auth.authRequired, async (req, res) => {
  // Перенаправляем на оптимизированный эндпоинт
  req.body.optimized = false; // Флаг что это не оптимизированный запрос
  
  // Если chunk size больше 500, разбиваем на меньшие части
  const { wallets } = req.body;
  if (wallets && wallets.length > 500) {
    console.log(`[${new Date().toISOString()}] 🔄 Large non-optimized request (${wallets.length} wallets), redirecting to optimized endpoint`);
    req.body.optimized = true;
  }
  
  // Вызываем тот же обработчик
  return app._router.handle(req, res, (err) => {
    if (err) {
      console.error('Error in bulk handler redirect:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });
});

app.post('/api/wallets/bulk-optimized', auth.authRequired, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { wallets, groupId, optimized } = req.body;
    const userId = req.user.id;

    console.log(`[${new Date().toISOString()}] 🚀 Starting OPTIMIZED bulk import of ${wallets?.length || 0} wallets for user ${userId}`);

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

    if (wallets.length > 1000) {
      return res.status(400).json({ 
        success: false,
        error: 'Maximum 1,000 wallets allowed per optimized batch (send in multiple requests)' 
      });
    }

    const results = {
      total: wallets.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      successfulWallets: []
    };

    const validWallets = [];
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]+$/;

    // Быстрая валидация всех кошельков в одном проходе
    console.log(`[${new Date().toISOString()}] ⚡ Fast validation of ${wallets.length} wallets...`);
    const validationStart = Date.now();

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

      if (wallet.address.length < 32 || wallet.address.length > 44 || !solanaAddressRegex.test(wallet.address)) {
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
        name: wallet.name?.trim() || null,
        userId,
        groupId: groupId || null
      });
    }

    const validationTime = Date.now() - validationStart;
    console.log(`[${new Date().toISOString()}] ✅ Validation completed in ${validationTime}ms: ${validWallets.length}/${wallets.length} valid`);

    if (validWallets.length === 0) {
      return res.json({
        success: false,
        message: 'No valid wallets to import',
        results,
        duration: Date.now() - startTime
      });
    }

    // ОПТИМИЗИРОВАННАЯ BATCH ОБРАБОТКА В БАЗЕ ДАННЫХ
    console.log(`[${new Date().toISOString()}] 🗄️ Starting optimized database batch insert of ${validWallets.length} wallets...`);
    const dbStart = Date.now();

    try {
      // Используем оптимизированную batch функцию из базы данных
      const dbResults = await db.addWalletsBatchOptimized(validWallets);
      
      const dbTime = Date.now() - dbStart;
      console.log(`[${new Date().toISOString()}] ✅ Database batch completed in ${dbTime}ms: ${dbResults.length} wallets inserted`);

      results.successful = dbResults.length;
      results.successfulWallets = dbResults.map(wallet => ({
        address: wallet.address,
        name: wallet.name,
        id: wallet.id,
        groupId: wallet.group_id,
        userId: wallet.user_id
      }));

      // Подсчитываем дубликаты/неуспешные
      results.failed += (validWallets.length - dbResults.length);

    } catch (dbError) {
      console.error(`[${new Date().toISOString()}] ❌ Database batch error:`, dbError.message);
      
      // Fallback к индивидуальной обработке если batch не сработал
      console.log(`[${new Date().toISOString()}] 🔄 Falling back to individual processing...`);
      
      for (const wallet of validWallets) {
        try {
          const addedWallet = await solanaWebSocketService.addWallet(
            wallet.address, 
            wallet.name, 
            wallet.groupId,
            wallet.userId
          );
          
          results.successful++;
          results.successfulWallets.push({
            address: wallet.address,
            name: wallet.name,
            id: addedWallet.id,
            groupId: addedWallet.group_id,
            userId: addedWallet.user_id,
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
    }

    // ОПТИМИЗИРОВАННАЯ ПОДПИСКА НА WEBSOCKET (параллельно с БД)
    if (results.successful > 0) {
      console.log(`[${new Date().toISOString()}] 🔗 Starting optimized WebSocket subscriptions for ${results.successful} wallets...`);
      const wsStart = Date.now();

      try {
        // Параллельная подписка батчами по 100 кошельков
        const subscriptionBatchSize = 100;
        const subscriptionPromises = [];

        for (let i = 0; i < results.successfulWallets.length; i += subscriptionBatchSize) {
          const batch = results.successfulWallets.slice(i, i + subscriptionBatchSize);
          
          const batchPromise = Promise.all(
            batch.map(async (wallet) => {
              try {
                // Проверяем что кошелек подходит под текущую группу/пользователя в WebSocket сервисе
                if (solanaWebSocketService.activeUserId === userId && 
                    (!solanaWebSocketService.activeGroupId || solanaWebSocketService.activeGroupId === wallet.groupId)) {
                  await solanaWebSocketService.subscribeToWallet(wallet.address);
                }
                return { success: true, address: wallet.address };
              } catch (error) {
                console.warn(`[${new Date().toISOString()}] ⚠️ WebSocket subscription failed for ${wallet.address}: ${error.message}`);
                return { success: false, address: wallet.address, error: error.message };
              }
            })
          );

          subscriptionPromises.push(batchPromise);
        }

        // Ждем все батчи подписок
        const subscriptionResults = await Promise.all(subscriptionPromises);
        const flatResults = subscriptionResults.flat();
        
        const successfulSubscriptions = flatResults.filter(r => r.success).length;
        const failedSubscriptions = flatResults.filter(r => !r.success).length;

        const wsTime = Date.now() - wsStart;
        console.log(`[${new Date().toISOString()}] ✅ WebSocket subscriptions completed in ${wsTime}ms: ${successfulSubscriptions} successful, ${failedSubscriptions} failed`);

      } catch (wsError) {
        console.error(`[${new Date().toISOString()}] ❌ WebSocket subscription error:`, wsError.message);
        // Не прерываем процесс - кошельки уже добавлены в БД
      }
    }

    const duration = Date.now() - startTime;
    const walletsPerSecond = Math.round((results.successful / duration) * 1000);

    console.log(`[${new Date().toISOString()}] 🎉 OPTIMIZED bulk import completed in ${duration}ms: ${results.successful}/${results.total} successful (${walletsPerSecond} wallets/sec)`);

    res.json({
      success: results.successful > 0,
      message: `Optimized bulk import completed: ${results.successful} successful, ${results.failed} failed out of ${results.total} total (${walletsPerSecond} wallets/sec)`,
      results,
      duration,
      performance: {
        walletsPerSecond,
        totalTime: duration,
        averageTimePerWallet: Math.round(duration / results.total)
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] ❌ Optimized bulk import failed after ${duration}ms:`, error);
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error during optimized bulk import',
      details: error.message,
      duration
    });
  }
});

app.get('/api/solana/price', auth.authRequired, async (req, res) => {
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

app.get('/api/groups', auth.authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const groups = await db.getGroups(userId);
    res.json(groups);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching groups:`, error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.post('/api/groups', auth.authRequired, async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.user.id;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    const group = await db.addGroup(name.trim(), userId);
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

app.post('/api/groups/switch', auth.authRequired, async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user.id;
    
    // Verify group belongs to user if groupId is provided
    if (groupId) {
      const query = `SELECT id FROM groups WHERE id = $1 AND user_id = $2`;
      const result = await db.pool.query(query, [groupId, userId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Group not found or access denied' });
      }
    }
    
    await solanaWebSocketService.switchGroup(groupId, userId);
    res.json({
      success: true,
      message: `Switched to group ${groupId || 'all'}`,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error switching group:`, error);
    res.status(500).json({ error: 'Failed to switch group' });
  }
});

// Clean expired sessions periodically
setInterval(async () => {
  try {
    const cleaned = await auth.cleanExpiredSessions();
    if (cleaned > 0) {
      console.log(`[${new Date().toISOString()}] 🧹 Cleaned ${cleaned} expired sessions`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error cleaning sessions:`, error);
  }
}, 60 * 60 * 1000); // Every hour

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

https.createServer(sslOptions, app).listen(port, '0.0.0.0', () => {
    console.log(`[${new Date().toISOString()}] 🚀 Server running on https://0.0.0.0:${port}`);
});