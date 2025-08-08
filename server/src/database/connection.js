const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class Database {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
        });

        this.pool.on('error', (err) => {
            console.error(`[${new Date().toISOString()}] ❌ Unexpected error on idle PostgreSQL client`, err);
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
                        console.warn(`[${new Date().toISOString()}] ⚠️ Skipping statement due to error:`, err.message);
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

    async addWallet(address, name = null, groupId = null) {
        const query = `
            INSERT INTO wallets (address, name, group_id) 
            VALUES ($1, $2, $3) 
            ON CONFLICT (address) DO UPDATE
            SET name = EXCLUDED.name, group_id = EXCLUDED.group_id, updated_at = CURRENT_TIMESTAMP, is_active = TRUE
            RETURNING id, address, name, group_id, created_at
        `;
        try {
            const result = await this.pool.query(query, [address, name, groupId]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23503') {
                throw new Error('Invalid group ID');
            }
            throw new Error(`Failed to add wallet: ${error.message}`);
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

    async getActiveWallets(groupId = null) {
        const query = groupId
            ? `SELECT * FROM wallets WHERE is_active = TRUE AND group_id = $1 ORDER BY created_at DESC`
            : `SELECT * FROM wallets WHERE is_active = TRUE ORDER BY created_at DESC`;
        const params = groupId ? [groupId] : [];
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async removeAllWallets(groupId = null) {
        const query = groupId
            ? `DELETE FROM wallets WHERE group_id = $1`
            : `DELETE FROM wallets`;
        const params = groupId ? [groupId] : [];
        try {
            const result = await this.pool.query(query, params);
            console.log(`[${new Date().toISOString()}] 🗑️ Removed ${result.rowCount} wallets and associated data${groupId ? ` for group ${groupId}` : ''}`);
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
        const result = await this.pool.query(query, [mint, symbol, name, decimals]);
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
                transactionType === 'sell' ? solAmount : 0,
            ]);
            return result.rows[0] || null;
        } catch (error) {
            throw new Error(`Failed to add transaction: ${error.message}`);
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
        const query = `SELECT * FROM wallets WHERE address = $1 AND is_active = TRUE`;
        const result = await this.pool.query(query, [address]);
        return result.rows[0];
    }

    async getRecentTransactions(hours = 24, limit = 400, transactionType = null, groupId = null) {
        try {
            let typeFilter = '';
            let groupFilter = '';
            let queryParams = [limit];
            let paramIndex = 2;

            if (transactionType) {
                typeFilter = `AND t.transaction_type = $${paramIndex}`;
                queryParams.push(transactionType);
                paramIndex++;
            }

            if (groupId) {
                groupFilter = `AND w.group_id = $${paramIndex}`;
                queryParams.push(groupId);
                paramIndex++;
            }

            const uniqueTransactionsQuery = `
                SELECT 
                    t.signature,
                    t.block_time,
                    t.transaction_type,
                    t.sol_spent,
                    t.sol_received,
                    w.address as wallet_address,
                    w.name as wallet_name,
                    w.group_id
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
                ${typeFilter}
                ${groupFilter}
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
                    w.group_id,
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
            
            console.log(`[${new Date().toISOString()}] 📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens${groupId ? ` for group ${groupId}` : ''}`);
            
            return result.rows;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in getRecentTransactions:`, error);
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
            console.error(`[${new Date().toISOString()}] ❌ Error in getWalletStats:`, error);
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

    async getTopTokens(limit = 10, operationType = null, groupId = null) {
        let typeFilter = '';
        let groupFilter = '';
        let queryParams = [limit];
        let paramIndex = 2;

        if (operationType) {
            typeFilter = `AND to_.operation_type = $${paramIndex}`;
            queryParams.push(operationType);
            paramIndex++;
        }

        if (groupId) {
            groupFilter = `AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
        }

        const query = `
            SELECT 
                tk.mint,
                tk.symbol,
                tk.name,
                tk.decimals,
                COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as buy_count,
                COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as sell_count,
                COUNT(DISTINCT t.wallet_id) as unique_wallets,
                SUM(CASE WHEN to_.operation_type = 'buy' THEN to_.amount ELSE 0 END) as total_bought,
                SUM(CASE WHEN to_.operation_type = 'sell' THEN ABS(to_.amount) ELSE 0 END) as total_sold,
                AVG(CASE WHEN t.transaction_type = 'buy' THEN t.sol_spent ELSE t.sol_received END) as avg_sol_amount
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= NOW() - INTERVAL '24 hours'
            ${typeFilter}
            ${groupFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getTokenWalletAggregates(hours = 24, groupId = null) {
        let groupFilter = '';
        let queryParams = [];
        let paramIndex = 1;

        if (groupId) {
            groupFilter = `AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
        }

        const query = `
            SELECT 
                tk.mint,
                tk.symbol,
                tk.name,
                tk.decimals,
                w.id as wallet_id,
                w.address as wallet_address,
                w.name as wallet_name,
                w.group_id,
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
            ${groupFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name, w.group_id
            ORDER BY tk.mint, wallet_id
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getMonitoringStats(groupId = null) {
        let groupFilter = '';
        let queryParams = [];
        let paramIndex = 1;

        if (groupId) {
            groupFilter = `AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
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
            ${groupFilter}
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows[0];
    }

    async getTokenInflowSeries(mint, hours = 24, groupId = null) {
        let groupFilter = '';
        let queryParams = [mint];
        let paramIndex = 2;

        if (groupId) {
            groupFilter = `AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
        }

        const query = `
            SELECT 
                date_trunc('minute', t.block_time) AS bucket,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) AS buy_sol,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.sol_received ELSE 0 END), 0) AS sell_sol
            FROM tokens tk
            JOIN token_operations to_ ON to_.token_id = tk.id
            JOIN transactions t ON t.id = to_.transaction_id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE tk.mint = $1
              AND t.block_time >= NOW() - INTERVAL '${hours} hours'
              ${groupFilter}
            GROUP BY bucket
            ORDER BY bucket
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows.map(r => ({
            bucket: r.bucket,
            buy_sol: Number(r.buy_sol || 0),
            sell_sol: Number(r.sell_sol || 0),
            net_sol: Number(r.sell_sol || 0) - Number(r.buy_sol || 0),
        }));
    }

    async getTokenOperations(mint, hours = 24, groupId = null) {
        let groupFilter = '';
        let queryParams = [mint];
        let paramIndex = 2;

        if (groupId) {
            groupFilter = `AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            paramIndex++;
        }

        const query = `
            SELECT 
                t.block_time,
                t.transaction_type,
                t.sol_spent,
                t.sol_received,
                to_.amount as token_amount,
                tk.decimals,
                w.address as wallet_address,
                w.name as wallet_name,
                w.group_id
            FROM tokens tk
            JOIN token_operations to_ ON to_.token_id = tk.id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE tk.mint = $1
              AND t.block_time >= NOW() - INTERVAL '${hours} hours'
              ${groupFilter}
            ORDER BY t.block_time ASC
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows.map(r => ({
            time: r.block_time,
            type: r.transaction_type,
            sol: r.transaction_type === 'buy' ? Number(r.sol_spent || 0) : Number(r.sell_sol || 0),
            tokenAmount: Number(r.token_amount || 0),
            decimals: r.decimals || 0,
            wallet: { address: r.wallet_address, name: r.wallet_name, group_id: r.group_id }
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

    async createGroup(name) {
        const query = `
            INSERT INTO groups (name)
            VALUES ($1)
            RETURNING id, name, created_at
        `;
        try {
            const result = await this.pool.query(query, [name]);
            return result.rows[0];
        } catch (error) {
            throw new Error(`Failed to create group: ${error.message}`);
        }
    }

    async getGroups() {
        const query = `SELECT id, name, created_at, updated_at FROM groups ORDER BY created_at DESC`;
        const result = await this.pool.query(query);
        return result.rows;
    }

    async getGroupById(groupId) {
        const query = `SELECT id, name, created_at, updated_at FROM groups WHERE id = $1`;
        const result = await this.pool.query(query, [groupId]);
        return result.rows[0];
    }

    async updateGroup(groupId, name) {
        const query = `
            UPDATE groups
            SET name = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING id, name, created_at, updated_at
        `;
        const result = await this.pool.query(query, [name, groupId]);
        if (result.rowCount === 0) {
            throw new Error('Group not found');
        }
        return result.rows[0];
    }

    async deleteGroup(groupId) {
        const query = `DELETE FROM groups WHERE id = $1 RETURNING id`;
        const result = await this.pool.query(query, [groupId]);
        if (result.rowCount === 0) {
            throw new Error('Group not found');
        }
        return { deletedCount: result.rowCount };
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
            console.log(`[${new Date().toISOString()}] ✅ Database connection pool closed`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error closing database pool:`, error.message);
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