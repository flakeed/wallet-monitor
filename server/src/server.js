const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
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

const JWT_SECRET = process.env.JWT_SECRET || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if user still exists and is active
    const user = await db.pool.query(
      'SELECT * FROM users WHERE id = $1 AND is_active = TRUE',
      [decoded.userId]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = user.rows[0];
    next();
  } catch (error) {
    console.error('JWT verification error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Administrator access required' });
  }
  next();
};

// Verify Telegram auth data
const verifyTelegramAuth = (authData, botToken) => {
  const { hash, ...data } = authData;
  
  // Create data check string
  const dataCheckArr = Object.keys(data)
    .filter(key => key !== 'hash')
    .sort()
    .map(key => `${key}=${data[key]}`);
  
  const dataCheckString = dataCheckArr.join('\n');
  
  // Create secret key
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  
  // Create hash
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  
  return calculatedHash === hash;
};

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
};

// Authentication routes
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const authData = req.body;
    
    // Development mode bypass
    if (authData.hash === 'development_mode_hash') {
      console.log('🔧 Development mode authentication for Telegram ID:', authData.id);
      
      // In development, skip hash verification but still check whitelist/admin
      const result = await db.pool.query(
        'SELECT * FROM authenticate_user($1, $2, $3, $4)',
        [
          parseInt(authData.id),
          authData.username || null,
          authData.first_name || null,
          authData.last_name || null
        ]
      );

      const authResult = result.rows[0];

      if (!authResult.success) {
        return res.status(403).json({
          success: false,
          message: authResult.message + ' (Make sure your Telegram ID is in the whitelist)'
        });
      }

      const userData = authResult.user_data;
      const token = generateToken(userData.id);

      // Create session
      await db.pool.query(
        `INSERT INTO user_sessions (user_id, session_token, expires_at, ip_address, user_agent) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userData.id,
          token,
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          req.ip,
          req.get('User-Agent')
        ]
      );

      return res.json({
        success: true,
        message: 'Development authentication successful',
        token,
        user: userData
      });
    }

    // Production mode - verify Telegram auth data
    if (!BOT_TOKEN) {
      return res.status(500).json({ 
        success: false, 
        message: 'Telegram bot token not configured' 
      });
    }

    // Verify Telegram auth data
    if (!verifyTelegramAuth(authData, BOT_TOKEN)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Telegram authentication data'
      });
    }

    // Check auth data age (should be less than 1 day old)
    const authDate = parseInt(authData.auth_date);
    const currentTime = Math.floor(Date.now() / 1000);
    if (currentTime - authDate > 86400) {
      return res.status(400).json({
        success: false,
        message: 'Authentication data is too old'
      });
    }

    // Authenticate user using database function
    const result = await db.pool.query(
      'SELECT * FROM authenticate_user($1, $2, $3, $4)',
      [
        parseInt(authData.id),
        authData.username || null,
        authData.first_name || null,
        authData.last_name || null
      ]
    );

    const authResult = result.rows[0];

    if (!authResult.success) {
      return res.status(403).json({
        success: false,
        message: authResult.message
      });
    }

    const userData = authResult.user_data;
    const token = generateToken(userData.id);

    // Create session
    await db.pool.query(
      `INSERT INTO user_sessions (user_id, session_token, expires_at, ip_address, user_agent) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userData.id,
        token,
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        req.ip,
        req.get('User-Agent')
      ]
    );

    res.json({
      success: true,
      message: 'Authentication successful',
      token,
      user: userData
    });

  } catch (error) {
    console.error('Telegram authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error during authentication'
    });
  }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      telegram_id: req.user.telegram_id,
      username: req.user.username,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      is_admin: req.user.is_admin,
      is_active: req.user.is_active,
      last_login: req.user.last_login
    }
  });
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Remove session
    await db.pool.query(
      'DELETE FROM user_sessions WHERE session_token = $1',
      [token]
    );

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin routes
app.get('/api/admin/whitelist', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await db.pool.query(
      'SELECT * FROM user_whitelist ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching whitelist:', error);
    res.status(500).json({ error: 'Failed to fetch whitelist' });
  }
});

app.post('/api/admin/whitelist', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { telegram_id, reason } = req.body;
    
    if (!telegram_id) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    const result = await db.pool.query(
      'SELECT * FROM add_user_to_whitelist($1, $2, $3)',
      [telegram_id, req.user.id, reason]
    );

    const addResult = result.rows[0];
    res.json({
      success: addResult.success,
      message: addResult.message,
      data: addResult.user_data
    });
  } catch (error) {
    console.error('Error adding to whitelist:', error);
    res.status(500).json({ error: 'Failed to add user to whitelist' });
  }
});

app.delete('/api/admin/whitelist/:telegramId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const telegramId = parseInt(req.params.telegramId);
    
    const result = await db.pool.query(
      'DELETE FROM user_whitelist WHERE telegram_id = $1 RETURNING *',
      [telegramId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found in whitelist' });
    }

    res.json({
      success: true,
      message: 'User removed from whitelist successfully'
    });
  } catch (error) {
    console.error('Error removing from whitelist:', error);
    res.status(500).json({ error: 'Failed to remove user from whitelist' });
  }
});

app.get('/api/admin/admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await db.pool.query(
      'SELECT * FROM admin_list ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching admin list:', error);
    res.status(500).json({ error: 'Failed to fetch admin list' });
  }
});

app.post('/api/admin/admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { telegram_id } = req.body;
    
    if (!telegram_id) {
      return res.status(400).json({ error: 'Telegram ID is required' });
    }

    const result = await db.pool.query(
      'SELECT * FROM add_admin($1, $2)',
      [telegram_id, req.user.id]
    );

    const addResult = result.rows[0];
    res.json({
      success: addResult.success,
      message: addResult.message
    });
  } catch (error) {
    console.error('Error adding admin:', error);
    res.status(500).json({ error: 'Failed to add admin' });
  }
});

app.delete('/api/admin/admins/:telegramId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const telegramId = parseInt(req.params.telegramId);
    
    // Prevent self-removal
    if (telegramId === req.user.telegram_id) {
      return res.status(400).json({ error: 'Cannot remove yourself as admin' });
    }

    const result = await db.pool.query(
      'DELETE FROM admin_list WHERE telegram_id = $1 RETURNING *',
      [telegramId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    // Update user's admin status
    await db.pool.query(
      'UPDATE users SET is_admin = FALSE WHERE telegram_id = $1',
      [telegramId]
    );

    res.json({
      success: true,
      message: 'Admin removed successfully'
    });
  } catch (error) {
    console.error('Error removing admin:', error);
    res.status(500).json({ error: 'Failed to remove admin' });
  }
});

app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_active = TRUE) as active_users,
        (SELECT COUNT(*) FROM user_whitelist) as whitelisted_users,
        (SELECT COUNT(*) FROM wallets WHERE is_active = TRUE) as active_wallets,
        (SELECT COUNT(*) FROM wallets) as total_wallets,
        (SELECT COUNT(*) FROM groups) as total_groups,
        (SELECT COUNT(*) FROM transactions WHERE block_time >= CURRENT_DATE) as transactions_today,
        (SELECT COUNT(*) FROM transactions WHERE block_time >= CURRENT_DATE - INTERVAL '7 days') as transactions_week,
        (SELECT COUNT(*) FROM transactions) as total_transactions
    `;

    const result = await db.pool.query(statsQuery);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Updated SSE endpoint with authentication
app.get('/api/transactions/stream', authenticateToken, (req, res) => {
  const groupId = req.query.groupId || null;
  const userId = req.user.id;
  
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
    console.log(`[${new Date().toISOString()}] ✅ New SSE client connected for user ${userId}${groupId ? ` for group ${groupId}` : ''}`);
    sseClients.add(res);
  });

  subscriber.on('message', (channel, message) => {
    if (channel === 'transactions' && res.writable) {
      try {
        const transaction = JSON.parse(message);
        
        // Filter by user ID - only send transactions for the authenticated user
        if (transaction.userId !== userId) {
          return;
        }
        
        if (groupId !== null && transaction.groupId !== groupId) {
          console.log(`[${new Date().toISOString()}] 🔍 Filtering out transaction for group ${transaction.groupId} (client wants ${groupId})`);
          return;
        }
        
        console.log(`[${new Date().toISOString()}] 📡 Sending SSE message for user ${userId}, group ${transaction.groupId}:`, message.substring(0, 100) + '...');
        res.write(`data: ${message}\n\n`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error parsing SSE message:`, error.message);
        res.write(`data: ${message}\n\n`);
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
});

// Updated wallet routes with user authentication
app.get('/api/wallets', authenticateToken, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const userId = req.user.id;
    
    let query = `
      SELECT w.*, g.name as group_name
      FROM wallets w
      LEFT JOIN groups g ON w.group_id = g.id
      WHERE w.is_active = TRUE AND w.user_id = $1
    `;
    const params = [userId];
    
    if (groupId) {
      query += ` AND w.group_id = $2`;
      params.push(groupId);
    }
    
    query += ` ORDER BY w.created_at DESC`;
    
    const wallets = await db.pool.query(query, params);
    
    const walletsWithStats = await Promise.all(
      wallets.rows.map(async (wallet) => {
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

app.delete('/api/wallets/:address', authenticateToken, async (req, res) => {
  try {
    const address = req.params.address.trim();
    const userId = req.user.id;

    if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana wallet address format' });
    }

    // Check if wallet belongs to user
    const walletCheck = await db.pool.query(
      'SELECT id FROM wallets WHERE address = $1 AND user_id = $2',
      [address, userId]
    );

    if (walletCheck.rows.length === 0) {
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

app.delete('/api/wallets', authenticateToken, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const userId = req.user.id;
    
    // Remove only user's wallets
    let query = 'DELETE FROM wallets WHERE user_id = $1';
    const params = [userId];
    
    if (groupId) {
      query += ' AND group_id = $2';
      params.push(groupId);
    }
    
    const result = await db.pool.query(query + ' RETURNING *', params);
    
    await solanaWebSocketService.removeAllWallets(groupId, userId);
    
    res.json({
      success: true,
      message: `Successfully removed wallets and associated data${groupId ? ` for group ${groupId}` : ''}`,
      deletedCount: result.rowCount,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
    res.status(500).json({ error: 'Failed to remove all wallets' });
  }
});

// Updated transactions route with user filtering
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const limit = parseInt(req.query.limit) || 400;
    const type = req.query.type;
    const groupId = req.query.groupId || null;
    const userId = req.user.id;

    // Modified query to include user_id filter
    let query = `
      SELECT 
        t.signature,
        t.block_time,
        t.transaction_type,
        t.sol_spent,
        t.sol_received,
        w.address as wallet_address,
        w.name as wallet_name,
        w.group_id,
        g.name as group_name,
        tk.mint,
        tk.symbol,
        tk.name as token_name,
        to_.amount as token_amount,
        to_.operation_type,
        tk.decimals
      FROM transactions t
      JOIN wallets w ON t.wallet_id = w.id
      LEFT JOIN groups g ON w.group_id = g.id
      LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
      LEFT JOIN tokens tk ON to_.token_id = tk.id
      WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
        AND w.user_id = $1
    `;
    
    const params = [userId];
    let paramIndex = 2;
    
    if (type && type !== 'all') {
      query += ` AND t.transaction_type = ${paramIndex++}`;
      params.push(type);
    }
    
    if (groupId) {
      query += ` AND w.group_id = ${paramIndex++}`;
      params.push(groupId);
    }
    
    query += ` ORDER BY t.block_time DESC, t.signature, to_.id LIMIT ${paramIndex}`;
    params.push(limit);

    const transactions = await db.pool.query(query, params);
    const groupedTransactions = {};

    transactions.rows.forEach((row) => {
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

// Updated monitoring status with user context
app.get('/api/monitoring/status', authenticateToken, async (req, res) => {
  try {
    const groupId = req.query.groupId || null;
    const userId = req.user.id;
    
    const monitoringStatus = monitoringService.getStatus();
    const websocketStatus = solanaWebSocketService.getStatus();
    
    // Get user-specific stats
    let statsQuery = `
      SELECT 
        COUNT(DISTINCT w.id) as active_wallets,
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
    `;
    
    const params = [userId];
    if (groupId) {
      statsQuery += ' AND w.group_id = $2';
      params.push(groupId);
    }
    
    const dbStats = await db.pool.query(statsQuery, params);
    
    res.json({
      isMonitoring: websocketStatus.isConnected,
      processedSignatures: websocketStatus.messageCount,
      activeWallets: dbStats.rows[0].active_wallets || 0,
      activeGroupId: websocketStatus.activeGroupId,
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error getting monitoring status:`, error);
    res.status(500).json({ error: 'Failed to get monitoring status' });
  }
});

// Updated groups routes with user ownership
app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = `
      SELECT g.id, g.name, COUNT(w.id) as wallet_count, g.created_at
      FROM groups g
      LEFT JOIN wallets w ON g.id = w.group_id AND w.is_active = TRUE
      WHERE g.user_id = $1 OR g.is_shared = TRUE
      GROUP BY g.id, g.name, g.created_at
      ORDER BY g.created_at DESC
    `;
    
    const result = await db.pool.query(query, [userId]);
    res.json(result.rows);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error fetching groups:`, error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.post('/api/groups', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;
    const userId = req.user.id;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    
    const query = `
      INSERT INTO groups (name, user_id)
      VALUES ($1, $2)
      RETURNING id, name, created_at
    `;
    
    const result = await db.pool.query(query, [name.trim(), userId]);
    const group = result.rows[0];
    
    res.json({
      success: true,
      group,
      message: 'Group created successfully',
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Error creating group:`, error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Group name already exists' });
    } else {
      res.status(500).json({ error: 'Failed to create group' });
    }
  }
});

// Updated bulk wallet import with user association
app.post('/api/wallets/bulk', authenticateToken, async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { wallets, groupId } = req.body;
    const userId = req.user.id;

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

    // Verify group ownership if groupId is provided
    if (groupId) {
      const groupCheck = await db.pool.query(
        'SELECT id FROM groups WHERE id = $1 AND (user_id = $2 OR is_shared = TRUE)',
        [groupId, userId]
      );
      
      if (groupCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Group not found or access denied'
        });
      }
    }

    console.log(`[${new Date().toISOString()}] 📥 Starting bulk import of ${wallets.length} wallets for user ${userId}`);

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
        name: wallet.name?.trim() || null,
        userId: userId
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
            groupId,
            userId
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

      if (i + BATCH_SIZE < validWallets.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      console.log(`[${new Date().toISOString()}] ✅ Batch ${currentBatch}/${totalBatches} complete. Total: ${results.successful} successful, ${results.failed} failed`);
    }

    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] 🎉 Bulk import completed in ${duration}ms: ${results.successful}/${results.total} successful for user ${userId}`);

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

// Other existing routes remain the same but add authentication middleware...
app.post('/api/monitoring/toggle', authenticateToken, async (req, res) => {
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

app.post('/api/groups/switch', authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.body;
    const userId = req.user.id;
    
    // Verify group ownership if switching to a specific group
    if (groupId) {
      const groupCheck = await db.pool.query(
        'SELECT id FROM groups WHERE id = $1 AND (user_id = $2 OR is_shared = TRUE)',
        [groupId, userId]
      );
      
      if (groupCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Group not found or access denied' });
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

// Error handling middleware
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