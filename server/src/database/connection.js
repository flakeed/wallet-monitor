const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const { Histogram, Gauge } = require('prom-client');

class Database {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 30, 
            idleTimeoutMillis: 10000, 
            connectionTimeoutMillis: 5000, 
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        });

        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.queryDuration = new Histogram({
            name: 'database_query_duration_seconds',
            help: 'Duration of database queries in seconds',
            buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0],
        });
        this.poolConnections = new Gauge({
            name: 'database_pool_connections',
            help: 'Current database pool connections',
            labelNames: ['status'],
        });

        this.pool.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Unexpected error on idle PostgreSQL client`, err.message);
        });

        this.pool.on('connect', () => {
            this.poolConnections.set({ status: 'total' }, this.pool.totalCount);
            this.poolConnections.set({ status: 'idle' }, this.pool.idleCount);
            this.poolConnections.set({ status: 'waiting' }, this.pool.waitingCount);
        });

        this.initDatabase();
    }

    async initDatabase() {
        try {
            const client = await this.pool.connect();
            console.log(`[${new Date().toISOString()}] ✅ Connected to PostgreSQL database`);
            client.release();
            await this.createSchema();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Database connection error:`, error.message);
            throw error;
        }
    }

    async createSchema() {
        try {
            const schemaPath = path.join(__dirname, 'schema.sql');
            const schema = fs.readFileSync(schemaPath, 'utf8');
            const statements = schema.split(';').map(stmt => stmt.trim()).filter(stmt => stmt.length > 0);
            const client = await this.pool.connect();
            try {
                for (const statement of statements) {
                    try {
                        await client.query(statement);
                    } catch (err) {
                        console.warn(`[${new Date().toISOString()}] ⚠️ Error executing schema statement:`, err.message);
                    }
                }
                console.log(`[${new Date().toISOString()}] ✅ Database schema initialized`);
            } finally {
                client.release();
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error creating schema:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null) {
        const query = `
            INSERT INTO wallets (address, name) 
            VALUES ($1, $2) 
            ON CONFLICT (address) DO UPDATE SET
                name = EXCLUDED.name,
                is_active = TRUE,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, address, name, created_at
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [address, name]);
            await this.redis.set(`wallet:${address}`, JSON.stringify(result.rows[0]), 'EX', 3600);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            if (error.code === '23505') {
                throw new Error('Wallet already exists');
            }
            throw error;
        }
    }

    async removeWallet(address) {
        const query = `
            DELETE FROM wallets 
            WHERE address = $1
            RETURNING id
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [address]);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found');
            }
            await this.redis.del(`wallet:${address}`);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async getActiveWallets() {
        const query = `
            SELECT id, address, name, created_at 
            FROM wallets 
            WHERE is_active = TRUE 
            ORDER BY created_at DESC
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query);
            const pipeline = this.redis.pipeline();
            result.rows.forEach((wallet) => {
                pipeline.set(`wallet:${wallet.address}`, JSON.stringify(wallet), 'EX', 3600);
            });
            await pipeline.exec();
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async removeAllWallets() {
        const query = `DELETE FROM wallets`;
        const start = Date.now();
        try {
            const result = await this.pool.query(query);
            const pipeline = this.redis.pipeline();
            pipeline.flushdb(); 
            await pipeline.exec();
            console.log(`[${new Date().toISOString()}] 🗑️ Removed ${result.rowCount} wallets and associated data`);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return { deletedCount: result.rowCount };
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error.message);
            throw new Error(`Failed to remove all wallets: ${error.message}`);
        }
    }

    async upsertToken(tokenData) {
        const { mint, symbol, name, decimals } = tokenData;
        const query = `
            INSERT INTO tokens (mint, symbol, name, decimals) 
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (mint) DO UPDATE SET
                symbol = EXCLUDED.symbol,
                name = EXCLUDED.name,
                decimals = EXCLUDED.decimals,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, mint
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [mint, symbol, name, decimals]);
            await this.redis.set(`token:${mint}`, JSON.stringify({
                id: result.rows[0].id,
                mint,
                symbol,
                name,
                decimals,
            }), 'EX', 7 * 24 * 60 * 60);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async upsertTokensBulk(tokens) {
        if (!tokens || tokens.length === 0) return [];
        const start = Date.now();
        try {
            const query = `
                INSERT INTO tokens (mint, symbol, name, decimals)
                VALUES ${tokens.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ')}
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id, mint
            `;
            const flatValues = tokens.flatMap(({ mint, symbol, name, decimals }) => [mint, symbol, name, decimals]);
            const result = await this.pool.query(query, flatValues);
            const pipeline = this.redis.pipeline();
            result.rows.forEach(({ id, mint }, index) => {
                pipeline.set(`token:${mint}`, JSON.stringify({
                    id,
                    mint,
                    symbol: tokens[index].symbol,
                    name: tokens[index].name,
                    decimals: tokens[index].decimals,
                }), 'EX', 7 * 24 * 60 * 60);
            });
            await pipeline.exec();
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async getTokenByMint(mint) {
        const cacheKey = `token:${mint}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] ⚡ Cache hit for token ${mint}`);
            return JSON.parse(cached);
        }

        const query = `SELECT id, mint, symbol, name, decimals FROM tokens WHERE mint = $1`;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [mint]);
            if (result.rows[0]) {
                await this.redis.set(cacheKey, JSON.stringify(result.rows[0]), 'EX', 7 * 24 * 60 * 60);
            }
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async addTransaction(walletId, signature, blockTime, transactionType, solAmount) {
        const query = `
            INSERT INTO transactions (
                wallet_id, signature, block_time, transaction_type,
                sol_spent, sol_received
            ) 
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (signature) DO NOTHING
            RETURNING id, signature, transaction_type
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [
                walletId,
                signature,
                blockTime,
                transactionType,
                transactionType === 'buy' ? solAmount : 0,
                transactionType === 'sell' ? solAmount : 0,
            ]);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0] || null;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async addTransactionsBulk(transactions) {
        if (!transactions || transactions.length === 0) return [];
        const start = Date.now();
        try {
            const query = `
                INSERT INTO transactions (
                    wallet_id, signature, block_time, transaction_type,
                    sol_spent, sol_received
                )
                VALUES ${transactions.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ')}
                ON CONFLICT (signature) DO NOTHING
                RETURNING id, signature, transaction_type
            `;
            const flatValues = transactions.flatMap(({ walletId, signature, blockTime, transactionType, solAmount }) => [
                walletId,
                signature,
                blockTime,
                transactionType,
                transactionType === 'buy' ? solAmount : 0,
                transactionType === 'sell' ? solAmount : 0,
            ]);
            const result = await this.pool.query(query, flatValues);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async addTokenOperation(transactionId, tokenId, amount, operationType) {
        const query = `
            INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [transactionId, tokenId, amount, operationType]);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async addTokenOperationsBulk(operations) {
        if (!operations || operations.length === 0) return [];
        const start = Date.now();
        try {
            const query = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type)
                VALUES ${operations.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ')}
                RETURNING id
            `;
            const flatValues = operations.flatMap(({ transactionId, tokenId, amount, operationType }) => [
                transactionId,
                tokenId,
                amount,
                operationType,
            ]);
            const result = await this.pool.query(query, flatValues);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async getWalletByAddress(address) {
        const cacheKey = `wallet:${address}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] ⚡ Cache hit for wallet ${address}`);
            return JSON.parse(cached);
        }

        const query = `SELECT id, address, name, created_at FROM wallets WHERE address = $1`;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [address]);
            if (result.rows[0]) {
                await this.redis.set(cacheKey, JSON.stringify(result.rows[0]), 'EX', 3600);
            }
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        }
    }

    async getRecentTransactions(hours = 24, limit = 200, transactionType = null) {
        const start = Date.now();
        try {
            let typeFilter = '';
            let queryParams = [limit];

            if (transactionType) {
                typeFilter = 'AND t.transaction_type = $2';
                queryParams = [limit, transactionType];
            }

            const uniqueTransactionsQuery = `
                SELECT 
                    t.signature,
                    t.block_time,
                    t.transaction_type,
                    t.sol_spent,
                    t.sol_received,
                    w.address as wallet_address,
                    w.name as wallet_name
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
                ${typeFilter}
                ORDER BY t.block_time DESC
                LIMIT $1
            `;

            const uniqueTransactions = await this.pool.query(uniqueTransactionsQuery, queryParams);

            if (uniqueTransactions.rows.length === 0) {
                this.queryDuration.observe((Date.now() - start) / 1000);
                return [];
            }

            const signatures = uniqueTransactions.rows.map(row => row.signature);
            const placeholders = signatures.map((_, index) => `$${index + 1}`).join(',');

            const fullDataQuery = `
                SELECT 
                    t.signature,
                    t.block_time,
                    t.transaction_type,
                    t.sol_spent,
                    t.sol_received,
                    w.address as wallet_address,
                    w.name as wallet_name,
                    tk.mint,
                    tk.symbol,
                    tk.name as token_name,
                    to_.amount as token_amount,
                    to_.operation_type,
                    tk.decimals
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                LEFT JOIN tokens tk ON to_.token_id = tk.id
                WHERE t.signature IN (${placeholders})
                ORDER BY t.block_time DESC, t.signature, to_.id
            `;

            const result = await this.pool.query(fullDataQuery, signatures);

            console.log(`[${new Date().toISOString()}] 📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens`);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in getRecentTransactions:`, error.message);
            throw error;
        }
    }

    async getWalletStats(walletId) {
        const cacheKey = `wallet_stats:${walletId}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] ⚡ Cache hit for wallet stats ${walletId}`);
            return JSON.parse(cached);
        }

        const query = `
            SELECT 
                COUNT(CASE WHEN transaction_type = 'buy' THEN 1 END) as total_buy_transactions,
                COUNT(CASE WHEN transaction_type = 'sell' THEN 1 END) as total_sell_transactions,
                COALESCE(SUM(sol_spent), 0) as total_sol_spent,
                COALESCE(SUM(sol_received), 0) as total_sol_received,
                MAX(block_time) as last_transaction_at,
                COUNT(DISTINCT CASE WHEN to_.operation_type = 'buy' THEN to_.token_id END) as unique_tokens_bought,
                COUNT(DISTINCT CASE WHEN to_.operation_type = 'sell' THEN to_.token_id END) as unique_tokens_sold
            FROM transactions t
            LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
            WHERE t.wallet_id = $1
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [walletId]);
            await this.redis.set(cacheKey, JSON.stringify(result.rows[0]), 'EX', 3600);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in getWalletStats:`, error.message);
            throw error;
        }
    }

    async updateWalletStats(walletId) {
        const stats = await this.getWalletStats(walletId);
        const query = `
            INSERT INTO wallet_stats (
                wallet_id, total_spent_sol, total_received_sol,
                total_buy_transactions, total_sell_transactions,
                unique_tokens_bought, unique_tokens_sold, last_transaction_at
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (wallet_id) DO UPDATE SET
                total_spent_sol = EXCLUDED.total_spent_sol,
                total_received_sol = EXCLUDED.total_received_sol,
                total_buy_transactions = EXCLUDED.total_buy_transactions,
                total_sell_transactions = EXCLUDED.total_sell_transactions,
                unique_tokens_bought = EXCLUDED.unique_tokens_bought,
                unique_tokens_sold = EXCLUDED.unique_tokens_sold,
                last_transaction_at = EXCLUDED.last_transaction_at,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [
                walletId,
                stats.total_sol_spent || 0,
                stats.total_sol_received || 0,
                stats.total_buy_transactions || 0,
                stats.total_sell_transactions || 0,
                stats.unique_tokens_bought || 0,
                stats.unique_tokens_sold || 0,
                stats.last_transaction_at,
            ]);
            await this.redis.set(`wallet_stats:${walletId}`, JSON.stringify(result.rows[0]), 'EX', 3600);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in updateWalletStats:`, error.message);
            throw error;
        }
    }

    async getTopTokens(limit = 10, operationType = null) {
        const cacheKey = `top_tokens:${limit}:${operationType || 'all'}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] ⚡ Cache hit for top tokens`);
            return JSON.parse(cached);
        }

        let typeFilter = '';
        let queryParams = [limit];

        if (operationType) {
            typeFilter = 'AND to_.operation_type = $2';
            queryParams = [limit, operationType];
        }

        const query = `
            SELECT 
                tk.mint,
                tk.symbol,
                tk.name,
                COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as buy_count,
                COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as sell_count,
                COUNT(DISTINCT t.wallet_id) as unique_wallets,
                SUM(CASE WHEN to_.operation_type = 'buy' THEN to_.amount ELSE 0 END) as total_bought,
                SUM(CASE WHEN to_.operation_type = 'sell' THEN ABS(to_.amount) ELSE 0 END) as total_sold,
                AVG(CASE WHEN t.transaction_type = 'buy' THEN t.sol_spent ELSE t.sol_received END) as avg_sol_amount
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            WHERE t.block_time >= NOW() - INTERVAL '24 hours'
            ${typeFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, queryParams);
            await this.redis.set(cacheKey, JSON.stringify(result.rows), 'EX', 3600);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows;
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in getTopTokens:`, error.message);
            throw error;
        }
    }

    async getMonitoringStats() {
        const cacheKey = 'monitoring_stats';
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            console.log(`[${new Date().toISOString()}] ⚡ Cache hit for monitoring stats`);
            return JSON.parse(cached);
        }

        const query = `
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
            WHERE w.is_active = TRUE
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query);
            await this.redis.set(cacheKey, JSON.stringify(result.rows[0]), 'EX', 3600);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in getMonitoringStats:`, error.message);
            throw error;
        }
    }

    async addMonitoringStats(processedSignatures, totalWallets, scanDuration, errorsCount = 0) {
        const query = `
            INSERT INTO monitoring_stats (
                processed_signatures, total_wallets_monitored, 
                last_scan_duration, errors_count
            ) 
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        const start = Date.now();
        try {
            const result = await this.pool.query(query, [
                processedSignatures,
                totalWallets,
                scanDuration,
                errorsCount,
            ]);
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result.rows[0];
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            console.error(`[${new Date().toISOString()}] ❌ Error in addMonitoringStats:`, error.message);
            throw error;
        }
    }

    async withTransaction(callback) {
        const client = await this.pool.connect();
        const start = Date.now();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            this.queryDuration.observe((Date.now() - start) / 1000);
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            this.queryDuration.observe((Date.now() - start) / 1000);
            throw error;
        } finally {
            client.release();
        }
    }

    async close() {
        try {
            await this.redis.quit();
            await this.pool.end();
            console.log(`[${new Date().toISOString()}] ✅ Database connection pool closed`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error closing database pool:`, error.message);
        }
    }

    async healthCheck() {
        const start = Date.now();
        try {
            const result = await this.pool.query('SELECT NOW() as current_time');
            this.queryDuration.observe((Date.now() - start) / 1000);
            return {
                status: 'healthy',
                timestamp: result.rows[0].current_time,
                connections: {
                    total: this.pool.totalCount,
                    idle: this.pool.idleCount,
                    waiting: this.pool.waitingCount,
                },
            };
        } catch (error) {
            this.queryDuration.observe((Date.now() - start) / 1000);
            return {
                status: 'unhealthy',
                error: error.message,
            };
        }
    }
}

module.exports = Database;