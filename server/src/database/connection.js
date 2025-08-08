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

    // async addWallet(address, name = null) {
    //     const query = `
    //         INSERT INTO wallets (address, name) 
    //         VALUES ($1, $2) 
    //         RETURNING id, address, name, created_at
    //     `;
    //     try {
    //         const result = await this.pool.query(query, [address, name]);
    //         return result.rows[0];
    //     } catch (error) {
    //         if (error.code === '23505') {
    //             throw new Error('Wallet already exists');
    //         }
    //         throw error;
    //     }
    // }

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

    // async getActiveWallets() {
    //     const query = `
    //         SELECT * FROM wallets 
    //         WHERE is_active = TRUE 
    //         ORDER BY created_at DESC
    //     `;
    //     const result = await this.pool.query(query);
    //     return result.rows;
    // }

async removeAllWallets() {
    const query = `DELETE FROM wallets`;
    try {
        const result = await this.pool.query(query);
        console.log(`[${new Date().toISOString()}] 🗑️ Removed ${result.rowCount} wallets and associated data`);
        return { deletedCount: result.rowCount };
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
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
        const result = await this.pool.query(query, [
            mint, symbol, name, decimals
        ]);
        return result.rows[0];
    }

    async getTokenByMint(mint) {
        const query = `SELECT id, mint, symbol, name, decimals FROM tokens WHERE mint = $1`;
        const result = await this.pool.query(query, [mint]);
        return result.rows[0];
    }

    async addTransaction(walletId, signature, blockTime, transactionType, solAmount) {
        const query = `
            INSERT INTO transactions (
                wallet_id, signature, block_time, transaction_type,
                sol_spent, sol_received
            ) 
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, signature, transaction_type
        `;
        try {
            const result = await this.pool.query(query, [
                walletId, 
                signature, 
                blockTime, 
                transactionType,
                transactionType === 'buy' ? solAmount : 0,
                transactionType === 'sell' ? solAmount : 0,
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

async getRecentTransactions(hours = 24, limit = 400, transactionType = null) {
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
        const result = await this.pool.query(query, [
            walletId,
            stats.total_sol_spent || 0,
            stats.total_sol_received || 0,
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
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    /**
     * Returns per-token per-wallet aggregates for a recent time window.
     * Each row contains totals of SOL spent/received and token amounts for that wallet on that token.
     */
    async getTokenWalletAggregates(hours = 24) {
        const query = `
            SELECT 
                tk.mint,
                tk.symbol,
                tk.name,
                tk.decimals,
                w.id as wallet_id,
                w.address as wallet_address,
                w.name as wallet_name,
                COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as tx_buys,
                COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as tx_sells,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN to_.amount ELSE 0 END), 0) as tokens_bought,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN ABS(to_.amount) ELSE 0 END), 0) as tokens_sold,
                MAX(t.block_time) as last_activity
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name
            ORDER BY tk.mint, wallet_id
        `;
        const result = await this.pool.query(query);
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

    /**
     * Returns time series of SOL inflow per token over a period.
     * bucket = minute-level timestamp; consumer can downsample client-side.
     */
    async getTokenInflowSeries(mint, hours = 24) {
        const query = `
            SELECT 
                date_trunc('minute', t.block_time) AS bucket,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) AS buy_sol,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.sol_received ELSE 0 END), 0) AS sell_sol
            FROM tokens tk
            JOIN token_operations to_ ON to_.token_id = tk.id
            JOIN transactions t ON t.id = to_.transaction_id
            WHERE tk.mint = $1
              AND t.block_time >= NOW() - INTERVAL '${hours} hours'
            GROUP BY bucket
            ORDER BY bucket
        `;
        const result = await this.pool.query(query, [mint]);
        return result.rows.map(r => ({
            bucket: r.bucket,
            buy_sol: Number(r.buy_sol || 0),
            sell_sol: Number(r.sell_sol || 0),
            net_sol: Number(r.sell_sol || 0) - Number(r.buy_sol || 0),
        }));
    }

    /**
     * Returns individual token operations for a given mint and period for plotting markers
     */
    async getTokenOperations(mint, hours = 24) {
        const query = `
            SELECT 
                t.block_time,
                t.transaction_type,
                t.sol_spent,
                t.sol_received,
                to_.amount as token_amount,
                tk.decimals,
                w.address as wallet_address,
                w.name as wallet_name
            FROM tokens tk
            JOIN token_operations to_ ON to_.token_id = tk.id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE tk.mint = $1
              AND t.block_time >= NOW() - INTERVAL '${hours} hours'
            ORDER BY t.block_time ASC
        `;
        const result = await this.pool.query(query, [mint]);
        return result.rows.map(r => ({
            time: r.block_time,
            type: r.transaction_type,
            sol: r.transaction_type === 'buy' ? Number(r.sol_spent || 0) : Number(r.sol_received || 0),
            tokenAmount: Number(r.token_amount || 0),
            decimals: r.decimals || 0,
            wallet: { address: r.wallet_address, name: r.wallet_name }
        }));
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

    async createWalletGroup(name, description = null, color = '#3B82F6') {
        const query = `
            INSERT INTO wallet_groups (name, description, color) 
            VALUES ($1, $2, $3) 
            RETURNING id, name, description, color, is_active, created_at
        `;
        try {
            const result = await this.pool.query(query, [name, description, color]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('Group name already exists');
            }
            throw error;
        }
    }
    
    async getWalletGroups() {
        const query = `
            SELECT 
                wg.*,
                COUNT(w.id) as wallet_count
            FROM wallet_groups wg
            LEFT JOIN wallets w ON wg.id = w.group_id AND w.is_active = TRUE
            WHERE wg.is_active = TRUE
            GROUP BY wg.id, wg.name, wg.description, wg.color, wg.is_active, wg.created_at, wg.updated_at
            ORDER BY wg.created_at ASC
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }
    
    async getWalletGroup(groupId) {
        const query = `
            SELECT 
                wg.*,
                COUNT(w.id) as wallet_count
            FROM wallet_groups wg
            LEFT JOIN wallets w ON wg.id = w.group_id AND w.is_active = TRUE
            WHERE wg.id = $1 AND wg.is_active = TRUE
            GROUP BY wg.id, wg.name, wg.description, wg.color, wg.is_active, wg.created_at, wg.updated_at
        `;
        const result = await this.pool.query(query, [groupId]);
        return result.rows[0];
    }
    
    async updateWalletGroup(groupId, updates) {
        const fields = [];
        const values = [];
        let paramCount = 1;
    
        if (updates.name !== undefined) {
            fields.push(`name = $${paramCount++}`);
            values.push(updates.name);
        }
        if (updates.description !== undefined) {
            fields.push(`description = $${paramCount++}`);
            values.push(updates.description);
        }
        if (updates.color !== undefined) {
            fields.push(`color = $${paramCount++}`);
            values.push(updates.color);
        }
    
        if (fields.length === 0) {
            throw new Error('No fields to update');
        }
    
        fields.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(groupId);
    
        const query = `
            UPDATE wallet_groups 
            SET ${fields.join(', ')} 
            WHERE id = $${paramCount} AND is_active = TRUE
            RETURNING *
        `;
    
        const result = await this.pool.query(query, values);
        if (result.rowCount === 0) {
            throw new Error('Group not found');
        }
        return result.rows[0];
    }
    
    async deleteWalletGroup(groupId) {
        // Check if group has wallets
        const walletsCheck = await this.pool.query(
            'SELECT COUNT(*) as count FROM wallets WHERE group_id = $1 AND is_active = TRUE',
            [groupId]
        );
        
        if (parseInt(walletsCheck.rows[0].count) > 0) {
            throw new Error('Cannot delete group that contains wallets');
        }
    
        const query = `
            UPDATE wallet_groups 
            SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND is_active = TRUE
            RETURNING id
        `;
        const result = await this.pool.query(query, [groupId]);
        if (result.rowCount === 0) {
            throw new Error('Group not found');
        }
        return result.rows[0];
    }
    
    async getWalletsByGroup(groupId) {
        const query = `
            SELECT * FROM wallets 
            WHERE group_id = $1 AND is_active = TRUE 
            ORDER BY created_at DESC
        `;
        const result = await this.pool.query(query, [groupId]);
        return result.rows;
    }
    
    async moveWalletToGroup(walletAddress, groupId) {
        const query = `
            UPDATE wallets 
            SET group_id = $1, updated_at = CURRENT_TIMESTAMP
            WHERE address = $2 AND is_active = TRUE
            RETURNING *
        `;
        const result = await this.pool.query(query, [groupId, walletAddress]);
        if (result.rowCount === 0) {
            throw new Error('Wallet not found');
        }
        return result.rows[0];
    }
    
    async getDefaultGroup() {
        const query = `
            SELECT id FROM wallet_groups 
            WHERE name = 'Default Group' AND is_active = TRUE 
            LIMIT 1
        `;
        const result = await this.pool.query(query);
        return result.rows[0];
    }
    
    // Update the existing addWallet method to support groups
    async addWallet(address, name = null, groupId = null) {
        if (!groupId) {
            const defaultGroup = await this.getDefaultGroup();
            groupId = defaultGroup ? defaultGroup.id : null;
        }
    
        const query = `
            INSERT INTO wallets (address, name, group_id) 
            VALUES ($1, $2, $3) 
            RETURNING id, address, name, group_id, created_at
        `;
        try {
            const result = await this.pool.query(query, [address, name, groupId]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('Wallet already exists');
            }
            throw error;
        }
    }
    
    // Update getActiveWallets to support filtering by group
    async getActiveWallets(groupId = null) {
        let query = `
            SELECT w.*, wg.name as group_name, wg.color as group_color
            FROM wallets w
            LEFT JOIN wallet_groups wg ON w.group_id = wg.id
            WHERE w.is_active = TRUE
        `;
        const params = [];
        
        if (groupId) {
            query += ` AND w.group_id = $1`;
            params.push(groupId);
        }
        
        query += ` ORDER BY w.created_at DESC`;
        
        const result = await this.pool.query(query, params);
        return result.rows;
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
}

module.exports = Database;
