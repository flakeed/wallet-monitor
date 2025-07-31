const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class Database {
    constructor() {
        this.pool = new Pool({
            // user: process.env.DB_USER || 'walletpulse',
            // host: process.env.DB_HOST || 'localhost',
            // database: process.env.DB_NAME || 'walletpulse',
            // password: process.env.DB_PASSWORD,
            // port: process.env.DB_PORT || 5432,
            // ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
            // max: 20,
            // idleTimeoutMillis: 30000,
            // connectionTimeoutMillis: 2000,

            connectionString: process.env.DATABASE_URL,
        });

        this.pool.on('error', (err) => {
            console.error('❌ Unexpected error on idle PostgreSQL client', err);
        });

        this.initDatabase();
    }

    async initDatabase() {
        try {
            const client = await this.pool.connect();
            console.log('✅ Connected to PostgreSQL database');
            client.release();
            await this.createSchema();
        } catch (error) {
            console.error('❌ Database connection error:', error.message);
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
                    }
                }
                console.log('✅ Database schema initialized');
            } finally {
                client.release();
            }
        } catch (error) {
            console.error('❌ Error creating schema:', error.message);
            throw error;
        }
    }

    async addWallet(address, name = null) {
        const query = `
            INSERT INTO wallets (address, name) 
            VALUES ($1, $2) 
            RETURNING id, address, name, created_at
        `;
        try {
            const result = await this.pool.query(query, [address, name]);
            return result.rows[0];
        } catch (error) {
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
        try {
            const result = await this.pool.query(query, [address]);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found');
            }
            return result.rows[0];
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async getActiveWallets() {
        const query = `
            SELECT * FROM wallets 
            WHERE is_active = TRUE 
            ORDER BY created_at DESC
        `;
        const result = await this.pool.query(query);
        return result.rows;
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
        const result = await this.pool.query(query, [
            mint, symbol, name, logoURI, decimals, marketCap, priceUsd
        ]);
        return result.rows[0];
    }

    async getTokenByMint(mint) {
        const query = `SELECT id, mint, symbol, name, logo_uri, decimals FROM tokens WHERE mint = $1`;
        const result = await this.pool.query(query, [mint]);
        return result.rows[0];
    }

    async addTransaction(walletId, signature, blockTime, transactionType, solAmount, usdAmount) {
        const query = `
            INSERT INTO transactions (
                wallet_id, signature, block_time, transaction_type,
                sol_spent, usd_spent, sol_received, usd_received
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                return null; 
            }
            throw error;
        }
    }

    async addTokenOperation(transactionId, tokenId, amount, operationType) {
        const query = `
            INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `;
        const result = await this.pool.query(query, [transactionId, tokenId, amount, operationType]);
        return result.rows[0];
    }

    async getWalletByAddress(address) {
        const query = `SELECT * FROM wallets WHERE address = $1`;
        const result = await this.pool.query(query, [address]);
        return result.rows[0];
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
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            ${typeFilter}
            ORDER BY t.block_time DESC
            LIMIT $1
        `;

        const uniqueTransactions = await this.pool.query(uniqueTransactionsQuery, queryParams);
        
        if (uniqueTransactions.rows.length === 0) {
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

        const result = await this.pool.query(fullDataQuery, signatures);
        
        console.log(`📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens`);
        
        return result.rows;

    } catch (error) {
        console.error('❌ Error in getRecentTransactions:', error);
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
        return result.rows[0];
    } catch (error) {
        console.error('❌ Error in getWalletStats:', error);
        throw error;
    }
}
    async updateWalletStats(walletId) {
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
        return result.rows[0];
    }

    async getTopTokens(limit = 10, operationType = null) {
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
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.logo_uri
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getMonitoringStats() {
        const query = `
            SELECT 
                COUNT(DISTINCT w.id) as active_wallets,
                COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as buy_transactions_today,
                COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as sell_transactions_today,
                COALESCE(SUM(t.sol_spent), 0) as sol_spent_today,
                COALESCE(SUM(t.sol_received), 0) as sol_received_today,
                COALESCE(SUM(t.usd_spent), 0) as usd_spent_today,
                COALESCE(SUM(t.usd_received), 0) as usd_received_today,
                COUNT(DISTINCT to_.token_id) as unique_tokens_today
            FROM wallets w
            LEFT JOIN transactions t ON w.id = t.wallet_id 
                AND t.block_time >= CURRENT_DATE
            LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
            WHERE w.is_active = TRUE
        `;
        const result = await this.pool.query(query);
        return result.rows[0];
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
        const result = await this.pool.query(query, [
            processedSignatures, totalWallets, scanDuration, errorsCount
        ]);
        return result.rows[0];
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
            throw error;
        } finally {
            client.release();
        }
    }

    async close() {
        try {
            await this.pool.end();
            console.log('✅ Database connection pool closed');
        } catch (error) {
            console.error('❌ Error closing database pool:', error.message);
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
            return {
                status: 'unhealthy',
                error: error.message
            };
        }
    }

    async getTransactionBySignature(signature) {
    try {
        const query = `
            SELECT t.*, w.address as wallet_address, w.name as wallet_name
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.signature = $1
        `;
        
        const result = await this.pool.query(query, [signature]);
        return result.rows[0] || null;
    } catch (error) {
        console.error('Error getting transaction by signature:', error.message);
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
        throw error;
    } finally {
        client.release();
    }
}

async addMonitoringStats(processedSignatures, totalWallets, scanDuration, errors) {
    try {
        const query = `
            INSERT INTO monitoring_stats (
                processed_signatures, 
                total_wallets, 
                scan_duration, 
                errors, 
                created_at
            ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `;
        
        await this.pool.query(query, [
            processedSignatures,
            totalWallets,
            scanDuration,
            errors
        ]);
        
    } catch (error) {
        console.error('Error adding monitoring stats:', error.message);
        // Не бросаем ошибку, так как это не критично
    }
}

async getWebhookStats() {
    try {
        const query = `
            SELECT 
                COUNT(*) as total_webhooks_today,
                COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 hour' THEN 1 END) as webhooks_last_hour,
                MAX(created_at) as last_webhook_time
            FROM transactions 
            WHERE created_at >= CURRENT_DATE
        `;
        
        const result = await this.pool.query(query);
        return result.rows[0];
    } catch (error) {
        console.error('Error getting webhook stats:', error.message);
        return {
            total_webhooks_today: 0,
            webhooks_last_hour: 0,
            last_webhook_time: null
        };
    }
}
}

module.exports = Database;
