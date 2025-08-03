const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class Database {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 50, // Увеличено для поддержки 500 кошельков
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000, // Увеличен таймаут для надежности
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        });

        this.pool.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Unexpected error on idle PostgreSQL client:`, err.message);
        });

        this.pool.on('connect', () => {
            console.log(`[${new Date().toISOString()}] ✅ PostgreSQL client connected`);
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
                await client.query('BEGIN');
                for (const statement of statements) {
                    try {
                        await client.query(statement);
                    } catch (err) {
                        console.warn(`[${new Date().toISOString()}] ⚠️ Skipping statement due to error:`, err.message);
                    }
                }
                await client.query('COMMIT');
                console.log(`[${new Date().toISOString()}] ✅ Database schema initialized`);
            } catch (error) {
                await client.query('ROLLBACK');
                console.error(`[${new Date().toISOString()}] ❌ Error executing schema statements:`, error.message);
                throw error;
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
            ON CONFLICT (address) DO NOTHING 
            RETURNING id, address, name, created_at
        `;
        try {
            const result = await this.pool.query(query, [address, name]);
            if (result.rowCount === 0) {
                throw new Error('Wallet already exists');
            }
            console.log(`[${new Date().toISOString()}] ✅ Added wallet: ${address.slice(0, 8)}...`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet:`, error.message);
            throw error;
        }
    }

    async removeWallet(address) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const query = `
                DELETE FROM wallets 
                WHERE address = $1
                RETURNING id
            `;
            const result = await client.query(query, [address]);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found');
            }
            await client.query('COMMIT');
            console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet: ${address.slice(0, 8)}...`);
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallet:`, error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async getActiveWallets() {
        const query = `
            SELECT id, address, name, created_at 
            FROM wallets 
            WHERE is_active = TRUE 
            ORDER BY created_at DESC
        `;
        try {
            const result = await this.pool.query(query);
            console.log(`[${new Date().toISOString()}] 📋 Retrieved ${result.rows.length} active wallets`);
            return result.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching active wallets:`, error.message);
            throw error;
        }
    }

    async upsertToken(tokenData) {
        const { mint, symbol, name, logoURI, decimals, marketCap, priceUsd } = tokenData;
        const query = `
            INSERT INTO tokens (mint, symbol, name, logo_uri, decimals, market_cap, price_usd) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (mint) DO UPDATE SET
                symbol = EXCLUDED.symbol,
                name = EXCLUDED.name,
                logo_uri = EXCLUDED.logo_uri,
                decimals = EXCLUDED.decimals,
                market_cap = EXCLUDED.market_cap,
                price_usd = EXCLUDED.price_usd,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id, mint
        `;
        try {
            const result = await this.pool.query(query, [
                mint, symbol, name, logoURI, decimals, marketCap || null, priceUsd || null
            ]);
            console.log(`[${new Date().toISOString()}] ✅ Upserted token: ${mint.slice(0, 8)}...`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error upserting token:`, error.message);
            throw error;
        }
    }

    async getTokenByMint(mint) {
        const query = `
            SELECT id, mint, symbol, name, logo_uri, decimals 
            FROM tokens 
            WHERE mint = $1
        `;
        try {
            const result = await this.pool.query(query, [mint]);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching token by mint:`, error.message);
            throw error;
        }
    }

    async addTransaction(walletId, signature, blockTime, transactionType, solAmount, usdAmount) {
        const query = `
            INSERT INTO transactions (
                wallet_id, signature, block_time, transaction_type,
                sol_spent, usd_spent, sol_received, usd_received
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (signature) DO NOTHING
            RETURNING id, signature, transaction_type
        `;
        try {
            const result = await this.pool.query(query, [
                walletId, 
                signature, 
                blockTime, 
                transactionType,
                transactionType === 'buy' ? solAmount : 0,
                transactionType === 'buy' ? usdAmount : 0,
                transactionType === 'sell' ? solAmount : 0,
                transactionType === 'sell' ? usdAmount : 0
            ]);
            if (result.rowCount === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${signature.slice(0, 8)}... already exists`);
                return null;
            }
            console.log(`[${new Date().toISOString()}] ✅ Added transaction: ${signature.slice(0, 8)}...`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding transaction:`, error.message);
            throw error;
        }
    }

    async addTokenOperation(transactionId, tokenId, amount, operationType) {
        const query = `
            INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            RETURNING id
        `;
        try {
            const result = await this.pool.query(query, [transactionId, tokenId, amount, operationType]);
            if (result.rowCount === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Token operation already exists for transaction ${transactionId}`);
                return null;
            }
            console.log(`[${new Date().toISOString()}] ✅ Added token operation for transaction ${transactionId}`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding token operation:`, error.message);
            throw error;
        }
    }

    async getWalletByAddress(address) {
        const query = `
            SELECT id, address, name, created_at 
            FROM wallets 
            WHERE address = $1
        `;
        try {
            const result = await this.pool.query(query, [address]);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching wallet by address:`, error.message);
            throw error;
        }
    }

    async getRecentTransactions(hours = 24, limit = 50, transactionType = null) {
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
                    t.usd_spent,
                    t.usd_received,
                    w.address as wallet_address,
                    w.name as wallet_name
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                WHERE t.block_time >= NOW() - INTERVAL $1
                ${typeFilter}
                ORDER BY t.block_time DESC
                LIMIT $2
            `;
            const result = await this.pool.query(uniqueTransactionsQuery, [`${hours} hours`, ...queryParams.slice(0, -1)]);
            
            if (result.rows.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ No recent transactions found for last ${hours} hours`);
                return [];
            }

            const signatures = result.rows.map(row => row.signature);
            const placeholders = signatures.map((_, index) => `$${index + 1}`).join(',');

            const fullDataQuery = `
                SELECT 
                    t.signature,
                    t.block_time,
                    t.transaction_type,
                    t.sol_spent,
                    t.sol_received,
                    t.usd_spent,
                    t.usd_received,
                    w.address as wallet_address,
                    w.name as wallet_name,
                    tk.mint,
                    tk.symbol,
                    tk.name as token_name,
                    tk.logo_uri,
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
            const fullResult = await this.pool.query(fullDataQuery, signatures);
            
            console.log(`[${new Date().toISOString()}] 📊 getRecentTransactions: Found ${result.rows.length} unique transactions, ${fullResult.rows.length} total rows with tokens`);
            return fullResult.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in getRecentTransactions:`, error.message);
            throw error;
        }
    }

    async getWalletStats(walletId) {
        try {
            const query = `
                SELECT 
                    COUNT(CASE WHEN transaction_type = 'buy' THEN 1 END) as total_buy_transactions,
                    COUNT(CASE WHEN transaction_type = 'sell' THEN 1 END) as total_sell_transactions,
                    COALESCE(SUM(sol_spent), 0) as total_sol_spent,
                    COALESCE(SUM(sol_received), 0) as total_sol_received,
                    COALESCE(SUM(usd_spent), 0) as total_usd_spent,
                    COALESCE(SUM(usd_received), 0) as total_usd_received,
                    MAX(block_time) as last_transaction_at,
                    COUNT(DISTINCT CASE WHEN to_.operation_type = 'buy' THEN to_.token_id END) as unique_tokens_bought,
                    COUNT(DISTINCT CASE WHEN to_.operation_type = 'sell' THEN to_.token_id END) as unique_tokens_sold
                FROM transactions t
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                WHERE t.wallet_id = $1
            `;
            const result = await this.pool.query(query, [walletId]);
            console.log(`[${new Date().toISOString()}] 📊 Retrieved stats for wallet ${walletId}`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in getWalletStats:`, error.message);
            throw error;
        }
    }

    async updateWalletStats(walletId) {
        try {
            const stats = await this.getWalletStats(walletId);
            const query = `
                INSERT INTO wallet_stats (
                    wallet_id, total_spent_sol, total_received_sol, 
                    total_spent_usd, total_received_usd,
                    total_buy_transactions, total_sell_transactions,
                    unique_tokens_bought, unique_tokens_sold, last_transaction_at
                ) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (wallet_id) DO UPDATE SET
                    total_spent_sol = EXCLUDED.total_spent_sol,
                    total_received_sol = EXCLUDED.total_received_sol,
                    total_spent_usd = EXCLUDED.total_spent_usd,
                    total_received_usd = EXCLUDED.total_received_usd,
                    total_buy_transactions = EXCLUDED.total_buy_transactions,
                    total_sell_transactions = EXCLUDED.total_sell_transactions,
                    unique_tokens_bought = EXCLUDED.unique_tokens_bought,
                    unique_tokens_sold = EXCLUDED.unique_tokens_sold,
                    last_transaction_at = EXCLUDED.last_transaction_at,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING *
            `;
            const result = await this.pool.query(query, [
                walletId,
                stats.total_sol_spent || 0,
                stats.total_sol_received || 0,
                stats.total_usd_spent || 0,
                stats.total_usd_received || 0,
                stats.total_buy_transactions || 0,
                stats.total_sell_transactions || 0,
                stats.unique_tokens_bought || 0,
                stats.unique_tokens_sold || 0,
                stats.last_transaction_at
            ]);
            console.log(`[${new Date().toISOString()}] ✅ Updated stats for wallet ${walletId}`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating wallet stats:`, error.message);
            throw error;
        }
    }

    async getTopTokens(limit = 10, operationType = null) {
        try {
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
                    tk.logo_uri,
                    tk.decimals,
                    tk.market_cap,
                    tk.price_usd,
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
                GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.logo_uri, tk.decimals, tk.market_cap, tk.price_usd
                ORDER BY (buy_count + sell_count) DESC
                LIMIT $1
            `;
            const result = await this.pool.query(query, queryParams);
            console.log(`[${new Date().toISOString()}] 📊 Retrieved ${result.rows.length} top tokens`);
            return result.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching top tokens:`, error.message);
            throw error;
        }
    }

    async getMonitoringStats() {
        try {
            const query = `
                SELECT 
                    COUNT(DISTINCT w.id) as active_wallets,
                    COUNT(CASE WHEN t.transaction_type = 'buy' AND t.block_time >= CURRENT_DATE THEN 1 END) as buy_transactions_today,
                    COUNT(CASE WHEN t.transaction_type = 'sell' AND t.block_time >= CURRENT_DATE THEN 1 END) as sell_transactions_today,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'buy' AND t.block_time >= CURRENT_DATE THEN t.sol_spent ELSE 0 END), 0) as sol_spent_today,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'sell' AND t.block_time >= CURRENT_DATE THEN t.sol_received ELSE 0 END), 0) as sol_received_today,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'buy' AND t.block_time >= CURRENT_DATE THEN t.usd_spent ELSE 0 END), 0) as usd_spent_today,
                    COALESCE(SUM(CASE WHEN t.transaction_type = 'sell' AND t.block_time >= CURRENT_DATE THEN t.usd_received ELSE 0 END), 0) as usd_received_today,
                    COUNT(DISTINCT CASE WHEN t.block_time >= CURRENT_DATE THEN to_.token_id END) as unique_tokens_today
                FROM wallets w
                LEFT JOIN transactions t ON w.id = t.wallet_id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                WHERE w.is_active = TRUE
            `;
            const result = await this.pool.query(query);
            console.log(`[${new Date().toISOString()}] 📊 Retrieved monitoring stats`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching monitoring stats:`, error.message);
            throw error;
        }
    }

    async addMonitoringStats(processedSignatures, totalWallets, scanDuration, errorsCount = 0) {
        try {
            const query = `
                INSERT INTO monitoring_stats (
                    processed_signatures, total_wallets_monitored, 
                    last_scan_duration, errors_count
                ) 
                VALUES ($1, $2, $3, $4)
                RETURNING id
            `;
            const result = await this.pool.query(query, [
                processedSignatures, totalWallets, scanDuration, errorsCount
            ]);
            console.log(`[${new Date().toISOString()}] ✅ Added monitoring stats`);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding monitoring stats:`, error.message);
            throw error;
        }
    }

    async withTransaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[${new Date().toISOString()}] ❌ Transaction failed:`, error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    async close() {
        try {
            await this.pool.end();
            console.log(`[${new Date().toISOString()}] ✅ Database connection pool closed`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error closing database pool:`, error.message);
            throw error;
        }
    }

    async healthCheck() {
        try {
            const result = await this.pool.query('SELECT NOW() as current_time');
            return {
                status: 'healthy',
                timestamp: result.rows[0].current_time,
                connections: {
                    total: this.pool.totalCount,
                    idle: this.pool.idleCount,
                    waiting: this.pool.waitingCount
                }
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Health check failed:`, error.message);
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }
}

module.exports = Database;