const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
require('dotenv').config();

const OptimizedSolanaWebSocketService = require('./services/optimizedSolanaWebSocketService');
const Database = require('./database/connection');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://wallet-monitor-client.vercel.app'],
    optionsSuccessStatus: 200,
}));
app.use(express.json());

// Инициализация сервисов
const solanaService = new OptimizedSolanaWebSocketService();
const db = new Database();
const redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');

// Подключения SSE клиентов
const sseClients = new Set();

// Запуск оптимизированного сервиса
(async () => {
    try {
        await solanaService.start();
        console.log('🚀 Optimized Solana WebSocket service started');
    } catch (error) {
        console.error('❌ Failed to start Solana service:', error.message);
        // Retry after 5 seconds
        setTimeout(async () => {
            try {
                await solanaService.start();
            } catch (e) {
                console.error('❌ Retry failed:', e.message);
            }
        }, 5000);
    }
})();

// ============ REAL-TIME ENDPOINTS ============

// Server-Sent Events для real-time обновлений
app.get('/api/transactions/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
    
    res.flushHeaders();
    
    // Создаем отдельного подписчика для этого клиента
    const subscriber = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
    
    subscriber.subscribe('transactions', (err, count) => {
        if (err) {
            console.error('❌ Redis subscription error:', err.message);
            res.status(500).end();
            return;
        }
        console.log(`✅ New SSE client connected (${count} total subscriptions)`);
        sseClients.add(res);
    });
    
    // Обработка сообщений
    subscriber.on('message', (channel, message) => {
        if (channel === 'transactions' && res.writable) {
            try {
                const data = JSON.parse(message);
                
                // Отправляем структурированные данные
                res.write(`event: transaction\n`);
                res.write(`data: ${JSON.stringify({
                    type: 'new_transaction',
                    transaction: data,
                    timestamp: new Date().toISOString()
                })}\n\n`);
                
                console.log(`📡 SSE: Sent transaction ${data.signature} to client`);
            } catch (error) {
                console.error('❌ Error sending SSE message:', error.message);
            }
        }
    });
    
    // Keep-alive пинг каждые 30 секунд
    const keepAlive = setInterval(() => {
        if (res.writable) {
            res.write(`: keep-alive ${Date.now()}\n\n`);
        } else {
            clearInterval(keepAlive);
        }
    }, 30000);
    
    // Отправляем начальные данные
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({
        type: 'connection_established',
        timestamp: new Date().toISOString(),
        server_time: Date.now()
    })}\n\n`);
    
    // Обработка отключения клиента
    req.on('close', () => {
        console.log('🔌 SSE client disconnected');
        clearInterval(keepAlive);
        subscriber.unsubscribe();
        subscriber.quit();
        sseClients.delete(res);
        res.end();
    });
    
    req.on('error', (error) => {
        console.error('❌ SSE client error:', error.message);
        clearInterval(keepAlive);
        subscriber.quit();
        sseClients.delete(res);
    });
});

// WebSocket статус в реальном времени
app.get('/api/status/realtime', (req, res) => {
    const status = solanaService.getStatus();
    const serverStats = {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeSSEClients: sseClients.size,
        serverTime: Date.now()
    };
    
    res.json({
        solana: status,
        server: serverStats,
        redis: {
            connected: redis.status === 'ready'
        }
    });
});

// ============ WALLET MANAGEMENT ============

// Получить все кошельки с оптимизированной статистикой
app.get('/api/wallets', async (req, res) => {
    try {
        const wallets = await db.getActiveWallets();
        
        // Быстрое получение статистики из кеша если возможно
        const walletsWithStats = await Promise.all(
            wallets.map(async (wallet) => {
                try {
                    // Пробуем получить из кеша
                    const cachedStats = await redis.get(`wallet_stats:${wallet.address}`);
                    if (cachedStats) {
                        return {
                            ...wallet,
                            stats: JSON.parse(cachedStats)
                        };
                    }
                    
                    // Если нет в кеше, получаем из БД
                    const stats = await db.getWalletStats(wallet.id);
                    const formattedStats = {
                        totalBuyTransactions: stats.total_buy_transactions || 0,
                        totalSellTransactions: stats.total_sell_transactions || 0,
                        totalTransactions: (stats.total_buy_transactions || 0) + (stats.total_sell_transactions || 0),
                        totalSpentSOL: Number(stats.total_sol_spent || 0).toFixed(6),
                        totalReceivedSOL: Number(stats.total_sol_received || 0).toFixed(6),
                        totalSpentUSD: Number(stats.total_usd_spent || 0).toFixed(2),
                        totalReceivedUSD: Number(stats.total_usd_received || 0).toFixed(2),
                        netSOL: (Number(stats.total_sol_received || 0) - Number(stats.total_sol_spent || 0)).toFixed(6),
                        netUSD: (Number(stats.total_usd_received || 0) - Number(stats.total_usd_spent || 0)).toFixed(2),
                        lastTransactionAt: stats.last_transaction_at,
                    };
                    
                    // Кешируем на 30 секунд
                    await redis.setex(`wallet_stats:${wallet.address}`, 30, JSON.stringify(formattedStats));
                    
                    return {
                        ...wallet,
                        stats: formattedStats
                    };
                } catch (error) {
                    console.error(`❌ Error getting stats for wallet ${wallet.address}:`, error.message);
                    return {
                        ...wallet,
                        stats: {
                            totalBuyTransactions: 0,
                            totalSellTransactions: 0,
                            totalTransactions: 0,
                            totalSpentSOL: '0.000000',
                            totalReceivedSOL: '0.000000',
                            totalSpentUSD: '0.00',
                            totalReceivedUSD: '0.00',
                            netSOL: '0.000000',
                            netUSD: '0.00',
                            lastTransactionAt: null,
                        }
                    };
                }
            })
        );
        
        res.json(walletsWithStats);
    } catch (error) {
        console.error('❌ Error fetching wallets:', error.message);
        res.status(500).json({ error: 'Failed to fetch wallets' });
    }
});

// Добавить кошелек (оптимизированно)
app.post('/api/wallets', async (req, res) => {
    try {
        const { address, name } = req.body;
        
        if (!address) {
            return res.status(400).json({ error: 'Wallet address is required' });
        }
        
        // Быстрая валидация адреса
        if (address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }
        
        const wallet = await solanaService.addWallet(address, name);
        
        // Уведомляем SSE клиентов о новом кошельке
        const notification = {
            type: 'wallet_added',
            wallet: {
                ...wallet,
                stats: {
                    totalBuyTransactions: 0,
                    totalSellTransactions: 0,
                    totalTransactions: 0,
                    totalSpentSOL: '0.000000',
                    totalReceivedSOL: '0.000000',
                    totalSpentUSD: '0.00',
                    totalReceivedUSD: '0.00',
                    netSOL: '0.000000',
                    netUSD: '0.00',
                    lastTransactionAt: null,
                }
            },
            timestamp: new Date().toISOString()
        };
        
        await redis.publish('wallets', JSON.stringify(notification));
        
        res.json({
            success: true,
            wallet,
            message: 'Wallet added and monitoring started'
        });
    } catch (error) {
        console.error('❌ Error adding wallet:', error.message);
        if (error.message.includes('already exists')) {
            res.status(409).json({ error: 'Wallet is already being monitored' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Удалить кошелек (оптимизированно)
app.delete('/api/wallets/:address', async (req, res) => {
    try {
        const address = req.params.address.trim();
        
        if (!address || address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }
        
        await solanaService.removeWallet(address);
        
        // Очищаем кеш статистики
        await redis.del(`wallet_stats:${address}`);
        
        // Уведомляем SSE клиентов об удалении
        const notification = {
            type: 'wallet_removed',
            address,
            timestamp: new Date().toISOString()
        };
        
        await redis.publish('wallets', JSON.stringify(notification));
        
        res.json({
            success: true,
            message: 'Wallet removed and monitoring stopped'
        });
    } catch (error) {
        console.error('❌ Error removing wallet:', error.message);
        if (error.message.includes('not found')) {
            res.status(404).json({ error: 'Wallet not found in monitoring list' });
        } else {
            res.status(500).json({ error: 'Failed to remove wallet' });
        }
    }
});

// ============ TRANSACTION DATA ============

// Получить транзакции (оптимизированно с кешированием)
app.get('/api/transactions', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const limit = parseInt(req.query.limit) || 50;
        const type = req.query.type;
        
        // Пробуем получить из кеша
        const cacheKey = `transactions:${hours}:${limit}:${type || 'all'}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            console.log(`⚡ Cache hit for transactions: ${cacheKey}`);
            return res.json(JSON.parse(cached));
        }
        
        // Получаем из БД
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
                    usdSpent: row.usd_spent ? Number(row.usd_spent).toFixed(2) : null,
                    usdReceived: row.usd_received ? Number(row.usd_received).toFixed(2) : null,
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
                    logoURI: row.logo_uri,
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
        
        // Кешируем на 10 секунд
        await redis.setex(cacheKey, 10, JSON.stringify(result));
        
        res.json(result);
    } catch (error) {
        console.error('❌ Error fetching transactions:', error.message);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// ============ STATISTICS ============

// Получить статистику транзакций (с кешированием)
app.get('/api/stats/transactions', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const cacheKey = `transaction_stats:${hours}`;
        
        // Проверяем кеш
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`⚡ Cache hit for transaction stats: ${cacheKey}`);
            return res.json(JSON.parse(cached));
        }
        
        const stats = await db.getMonitoringStats();
        
        const result = {
            buyTransactions: stats.buy_transactions_today || 0,
            sellTransactions: stats.sell_transactions_today || 0,
            totalTransactions: (stats.buy_transactions_today || 0) + (stats.sell_transactions_today || 0),
            solSpent: Number(stats.sol_spent_today || 0).toFixed(6),
            solReceived: Number(stats.sol_received_today || 0).toFixed(6),
            usdSpent: Number(stats.usd_spent_today || 0).toFixed(2),
            usdReceived: Number(stats.usd_received_today || 0).toFixed(2),
            netSOL: (Number(stats.sol_received_today || 0) - Number(stats.sol_spent_today || 0)).toFixed(6),
            netUSD: (Number(stats.usd_received_today || 0) - Number(stats.usd_spent_today || 0)).toFixed(2),
        };
        
        // Кешируем на 15 секунд
        await redis.setex(cacheKey, 15, JSON.stringify(result));
        
        res.json(result);
    } catch (error) {
        console.error('❌ Error fetching transaction stats:', error.message);
        res.status(500).json({ error: 'Failed to fetch transaction stats' });
    }
});

// Топ токены (с кешированием)
app.get('/api/stats/tokens', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const type = req.query.type;
        const cacheKey = `top_tokens:${limit}:${type || 'all'}`;
        
        // Проверяем кеш
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log(`⚡ Cache hit for top tokens: ${cacheKey}`);
            return res.json(JSON.parse(cached));
        }
        
        const topTokens = await db.getTopTokens(limit, type);
        
        // Кешируем на 30 секунд
        await redis.setex(cacheKey, 30, JSON.stringify(topTokens));
        
        res.json(topTokens);
    } catch (error) {
        console.error('❌ Error fetching top tokens:', error.message);
        res.status(500).json({ error: 'Failed to fetch top tokens' });
    }
});

// ============ SERVICE CONTROL ============

// Статус мониторинга
app.get('/api/monitoring/status', (req, res) => {
    try {
        const status = solanaService.getStatus();
        res.json({
            isMonitoring: status.isConnected && status.isStarted,
            subscriptions: status.subscriptions,
            messageCount: status.stats.messagesReceived,
            transactionsProcessed: status.stats.transactionsProcessed,
            uptime: status.stats.uptime,
            queueLength: status.stats.queueLength || 0,
            lastTransaction: status.stats.lastTransaction
        });
    } catch (error) {
        console.error('❌ Error getting monitoring status:', error.message);
        res.status(500).json({ error: 'Failed to get monitoring status' });
    }
});

// Управление мониторингом
app.post('/api/monitoring/toggle', async (req, res) => {
    try {
        const { action } = req.body;
        
        if (action === 'start') {
            await solanaService.start();
            res.json({ success: true, message: 'Monitoring started' });
        } else if (action === 'stop') {
            await solanaService.stop();
            res.json({ success: true, message: 'Monitoring stopped' });
        } else if (action === 'restart') {
            await solanaService.stop();
            await new Promise(resolve => setTimeout(resolve, 1000));
            await solanaService.start();
            res.json({ success: true, message: 'Monitoring restarted' });
        } else {
            res.status(400).json({ error: 'Invalid action. Use "start", "stop", or "restart"' });
        }
    } catch (error) {
        console.error('❌ Error toggling monitoring:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Очистка кешей
app.post('/api/cache/clear', async (req, res) => {
    try {
        const { type } = req.body;
        
        if (type === 'all') {
            await redis.flushdb();
            res.json({ success: true, message: 'All caches cleared' });
        } else if (type === 'transactions') {
            const keys = await redis.keys('transactions:*');
            if (keys.length > 0) {
                await redis.del(...keys);
            }
            res.json({ success: true, message: 'Transaction caches cleared' });
        } else if (type === 'wallets') {
            const keys = await redis.keys('wallet_stats:*');
            if (keys.length > 0) {
                await redis.del(...keys);
            }
            res.json({ success: true, message: 'Wallet caches cleared' });
        } else if (type === 'tokens') {
            const keys = await redis.keys('token:*');
            if (keys.length > 0) {
                await redis.del(...keys);
            }
            res.json({ success: true, message: 'Token caches cleared' });
        } else {
            res.status(400).json({ error: 'Invalid cache type' });
        }
    } catch (error) {
        console.error('❌ Error clearing cache:', error.message);
        res.status(500).json({ error: 'Failed to clear cache' });
    }
});

// ============ BULK OPERATIONS ============

// Массовое добавление кошельков (оптимизированно)
app.post('/api/wallets/bulk', async (req, res) => {
    try {
        const { wallets } = req.body;
        
        if (!wallets || !Array.isArray(wallets)) {
            return res.status(400).json({ error: 'Wallets array is required' });
        }
        
        if (wallets.length === 0) {
            return res.status(400).json({ error: 'At least one wallet is required' });
        }
        
        if (wallets.length > 50) {
            return res.status(400).json({ error: 'Maximum 50 wallets allowed per bulk import' });
        }
        
        const results = {
            total: wallets.length,
            successful: 0,
            failed: 0,
            errors: [],
            successfulWallets: [],
        };
        
        // Валидация всех адресов сначала
        for (const wallet of wallets) {
            if (!wallet.address || wallet.address.length !== 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(wallet.address)) {
                results.failed++;
                results.errors.push({
                    address: wallet.address || 'invalid',
                    name: wallet.name || null,
                    error: 'Invalid Solana wallet address format',
                });
            }
        }
        
        // Добавляем валидные кошельки
        for (const wallet of wallets) {
            const hasError = results.errors.some((error) => error.address === wallet.address);
            if (hasError) continue;
            
            try {
                const addedWallet = await solanaService.addWallet(wallet.address, wallet.name || null);
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
            
            // Небольшая задержка между добавлениями
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        
        // Уведомляем SSE клиентов о массовом добавлении
        if (results.successful > 0) {
            const notification = {
                type: 'bulk_wallets_added',
                count: results.successful,
                timestamp: new Date().toISOString()
            };
            
            await redis.publish('wallets', JSON.stringify(notification));
        }
        
        res.json({
            success: true,
            message: `Bulk import completed: ${results.successful} successful, ${results.failed} failed`,
            results,
        });
    } catch (error) {
        console.error('❌ Error in bulk wallet import:', error.message);
        res.status(500).json({ error: 'Failed to import wallets' });
    }
});

// ============ HEALTH CHECK ============

app.get('/api/health', async (req, res) => {
    try {
        const dbHealth = await db.healthCheck();
        const solanaStatus = solanaService.getStatus();
        const redisStatus = redis.status === 'ready';
        
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbHealth.status === 'healthy',
                solana: solanaStatus.isConnected && solanaStatus.isStarted,
                redis: redisStatus,
                server: true
            },
            stats: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                sseClients: sseClients.size,
                monitoredWallets: solanaStatus.subscriptions,
                processedTransactions: solanaStatus.stats.transactionsProcessed
            }
        };
        
        const allHealthy = Object.values(health.services).every(status => status === true);
        if (!allHealthy) {
            health.status = 'degraded';
        }
        
        res.json(health);
    } catch (error) {
        console.error('❌ Health check error:', error.message);
        res.status(500).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ============ GRACEFUL SHUTDOWN ============

process.on('SIGINT', async () => {
    console.log('🛑 Shutting down server gracefully...');
    
    // Закрываем SSE соединения
    sseClients.forEach((client) => {
        try {
            client.write('event: shutdown\ndata: {"type": "server_shutdown"}\n\n');
            client.end();
        } catch (error) {
            console.error('❌ Error closing SSE client:', error.message);
        }
    });
    
    // Останавливаем сервисы
    try {
        await solanaService.stop();
        await redis.quit();
        await db.close();
        console.log('✅ All services stopped gracefully');
    } catch (error) {
        console.error('❌ Error during shutdown:', error.message);
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM, shutting down...');
    
    sseClients.forEach((client) => client.end());
    
    try {
        await solanaService.stop();
        await redis.quit();
        await db.close();
    } catch (error) {
        console.error('❌ Error during shutdown:', error.message);
    }
    
    process.exit(0);
});

// Запуск сервера
app.listen(port, '158.220.125.26', () => {
    console.log(`🚀 Optimized server running on http://158.220.125.26:${port}`);
    console.log(`📡 Real-time transaction monitoring: Active`);
    console.log(`⚡ SSE endpoint: /api/transactions/stream`);
    console.log(`📊 Health check: /api/health`);
});