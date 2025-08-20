const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class Database {
    constructor() {
        this.pool = new Pool({
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
                        // Ignore errors for existing objects
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

    // User management methods
    async createUser(telegramId, username, firstName, lastName, isAdmin = false) {
        const query = `
            INSERT INTO users (telegram_id, username, first_name, last_name, is_admin, last_login)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            RETURNING *
        `;
        try {
            const result = await this.pool.query(query, [telegramId, username, firstName, lastName, isAdmin]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('User already exists');
            }
            throw error;
        }
    }

    async getUserByTelegramId(telegramId) {
        const query = 'SELECT * FROM users WHERE telegram_id = $1';
        const result = await this.pool.query(query, [telegramId]);
        return result.rows[0];
    }

    async getUserById(userId) {
        const query = 'SELECT * FROM users WHERE id = $1';
        const result = await this.pool.query(query, [userId]);
        return result.rows[0];
    }

    async updateUserLastLogin(userId) {
        const query = `
            UPDATE users 
            SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
        `;
        const result = await this.pool.query(query, [userId]);
        return result.rows[0];
    }

    async addGroup(name, userId) {
        const query = `
            INSERT INTO groups (name, user_id)
            VALUES ($1, $2)
            RETURNING id, name, user_id, created_at
        `;
        try {
            const result = await this.pool.query(query, [name, userId]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('Group name already exists');
            }
            throw error;
        }
    }

    async getGroups(userId) {
        const query = `
            SELECT g.id, g.name, g.user_id, g.is_shared, COUNT(w.id) as wallet_count, g.created_at
            FROM groups g
            LEFT JOIN wallets w ON g.id = w.group_id AND w.is_active = TRUE
            WHERE g.user_id = $1 OR g.is_shared = TRUE
            GROUP BY g.id, g.name, g.user_id, g.is_shared, g.created_at
            ORDER BY g.created_at DESC
        `;
        const result = await this.pool.query(query, [userId]);
        return result.rows;
    }

    async addWallet(address, name = null, groupId = null, userId) {
        const query = `
            INSERT INTO wallets (address, name, group_id, user_id) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, address, name, group_id, user_id, created_at
        `;
        try {
            const result = await this.pool.query(query, [address, name, groupId, userId]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('Wallet already exists');
            }
            throw error;
        }
    }

    async addWalletsBatch(wallets, userId) {
        const query = `
          INSERT INTO wallets (address, name, group_id, user_id) 
          VALUES ${wallets.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ')}
          ON CONFLICT (address) DO NOTHING
          RETURNING id, address, name, group_id, user_id, created_at
        `;
        
        const values = [];
        wallets.forEach(wallet => {
          values.push(wallet.address, wallet.name, wallet.groupId, userId);
        });
      
        try {
          const result = await this.pool.query(query, values);
          return result.rows;
        } catch (error) {
          throw new Error(`Batch insert failed: ${error.message}`);
        }
    }

    async removeWallet(address, userId) {
        const query = `
            DELETE FROM wallets 
            WHERE address = $1 AND user_id = $2
            RETURNING id
        `;
        try {
            const result = await this.pool.query(query, [address, userId]);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found or access denied');
            }
            return result.rows[0];
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async removeAllWallets(groupId = null, userId) {
        let query = `DELETE FROM wallets WHERE user_id = $1`;
        const params = [userId];
        
        if (groupId) {
            query += ` AND group_id = $2`;
            params.push(groupId);
        }
        
        try {
            const result = await this.pool.query(query, params);
            console.log(`[${new Date().toISOString()}] 🗑️ Removed ${result.rowCount} wallets for user ${userId}${groupId ? ` in group ${groupId}` : ''}`);
            return { deletedCount: result.rowCount };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallets for user ${userId}:`, error);
            throw new Error(`Failed to remove wallets: ${error.message}`);
        }
    }

    async getActiveWallets(groupId = null, userId) {
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
        const result = await this.pool.query(query, params);
        return result.rows;
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

    async addTransaction(walletId, signature, blockTime, transactionType, solAmount, userId) {
        const query = `
            INSERT INTO transactions (
                wallet_id, signature, block_time, transaction_type,
                sol_spent, sol_received, user_id
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)
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
                userId
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

    async getWalletByAddress(address, userId = null) {
        let query = `SELECT * FROM wallets WHERE address = $1`;
        const params = [address];
        
        if (userId) {
            query += ` AND user_id = $2`;
            params.push(userId);
        }
        
        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    async getRecentTransactions(hours = 24, limit = 400, transactionType = null, groupId = null, userId) {
        try {
            let typeFilter = '';
            let queryParams = [userId, limit];
            let paramIndex = 3;
    
            // Build the typeFilter and queryParams correctly
            if (transactionType && transactionType !== 'all') {
                typeFilter += ` AND t.transaction_type = $${paramIndex++}`;
                queryParams.push(transactionType);
            }
            if (groupId) {
                typeFilter += ` AND w.group_id = $${paramIndex++}`;
                queryParams.push(groupId);
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
                    w.group_id,
                    g.name as group_name
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
                WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
                  AND w.user_id = $1
                ${typeFilter}
                ORDER BY t.block_time DESC
                LIMIT $2
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
                    g.name as group_name,
                    tk.mint,
                    tk.symbol,
                    tk.name as token_name,
                    to_.amount as token_amount,
                    to_.operation_type,
                    tk.decimals
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id AND w.user_id = $${signatures.length + 1}
                LEFT JOIN groups g ON w.group_id = g.id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                LEFT JOIN tokens tk ON to_.token_id = tk.id
                WHERE t.signature IN (${placeholders})
                ORDER BY t.block_time DESC, t.signature, to_.id
            `;
    
            const result = await this.pool.query(fullDataQuery, [...signatures, userId]);
    
            console.log(`📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens for user ${userId}`);
    
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
            stats.total_received_sol || 0,
            stats.total_buy_transactions || 0,
            stats.total_sell_transactions || 0,
            stats.unique_tokens_bought || 0,
            stats.unique_tokens_sold || 0,
            stats.last_transaction_at
        ]);
        return result.rows[0];
    }

    async getTopTokens(limit = 10, operationType = null, groupId = null, userId) {
        let typeFilter = '';
        let queryParams = [userId, limit];
        let paramIndex = 3;
        
        if (operationType) {
            typeFilter = `AND to_.operation_type = $${paramIndex++}`;
            queryParams.push(operationType);
        }
        if (groupId) {
            typeFilter += ` AND w.group_id = $${paramIndex}`;
            queryParams.push(groupId);
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
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= NOW() - INTERVAL '24 hours'
              AND w.user_id = $1
            ${typeFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $2
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getTokenWalletAggregates(hours = 24, groupId = null, userId) {
        const EXCLUDED_TOKENS = [
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 
            'So11111111111111111111111111111111111111112',  
        ];
    
        let query = `
            SELECT 
                tk.mint,
                tk.symbol,
                tk.name,
                tk.decimals,
                w.id as wallet_id,
                w.address as wallet_address,
                w.name as wallet_name,
                w.group_id,
                g.name as group_name,
                COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as tx_buys,
                COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as tx_sells,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.usdc_spent ELSE 0 END), 0) as usdc_spent_original,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.usdc_received ELSE 0 END), 0) as usdc_received_original,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN ABS(to_.amount) ELSE 0 END), 0) as tokens_bought,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN ABS(to_.amount) ELSE 0 END), 0) as tokens_sold,
                MAX(t.block_time) as last_activity,
                MIN(CASE WHEN to_.operation_type = 'buy' THEN t.block_time END) as first_buy_time,
                MIN(CASE WHEN to_.operation_type = 'sell' THEN t.block_time END) as first_sell_time
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id AND w.user_id = $${EXCLUDED_TOKENS.length + 2}
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            AND tk.mint NOT IN (${EXCLUDED_TOKENS.map((_, i) => `$${i + 1}`).join(', ')})
        `;
        
        const params = [...EXCLUDED_TOKENS, userId];
        let paramIndex = EXCLUDED_TOKENS.length + 3;
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
            params.push(groupId);
        }
        
        query += `
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name, w.group_id, g.name
            ORDER BY last_activity DESC, tk.mint, w.address
        `;
        
        const result = await this.pool.query(query, params);
    
        console.log(`[${new Date().toISOString()}] 📊 Token aggregates query returned ${result.rows.length} rows (excluded ${EXCLUDED_TOKENS.length} tokens) for user ${userId}`);
    
        return result.rows.map(row => {
            const solSpent = Number(row.sol_spent) || 0;
            const solReceived = Number(row.sol_received) || 0;
            const tokensBought = Number(row.tokens_bought) || 0;
            const tokensSold = Number(row.tokens_sold) || 0;
            const txBuys = Number(row.tx_buys) || 0;
            const txSells = Number(row.tx_sells) || 0;
            
            const pnlSol = +(solReceived - solSpent).toFixed(6);
            
            return {
                mint: row.mint,
                symbol: row.symbol || 'Unknown',
                name: row.name || 'Unknown Token',
                decimals: Number(row.decimals) || 9,
                wallet_id: row.wallet_id,
                wallet_address: row.wallet_address,
                wallet_name: row.wallet_name,
                group_id: row.group_id,
                group_name: row.group_name,
                tx_buys: txBuys,
                tx_sells: txSells,
                sol_spent: solSpent,
                sol_received: solReceived,
                usdc_spent_original: Number(row.usdc_spent_original) || 0,
                usdc_received_original: Number(row.usdc_received_original) || 0,
                tokens_bought: tokensBought,
                tokens_sold: tokensSold,
                pnl_sol: pnlSol,
                last_activity: row.last_activity,
                first_buy_time: row.first_buy_time,
                first_sell_time: row.first_sell_time
            };
        });
    }

    async getMonitoringStats(groupId = null, userId) {
        let query = `
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
            query += ` AND w.group_id = $2`;
            params.push(groupId);
        }
        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    async getTokenInflowSeries(mint, hours = 24, groupId = null, userId) {
        let query = `
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
              AND w.user_id = $2
        `;
        const params = [mint, userId];
        if (groupId) {
            query += ` AND w.group_id = $3`;
            params.push(groupId);
        }
        query += `
            GROUP BY bucket
            ORDER BY bucket
        `;
        const result = await this.pool.query(query, params);
        return result.rows.map(r => ({
            bucket: r.bucket,
            buy_sol: Number(r.buy_sol || 0),
            sell_sol: Number(r.sell_sol || 0),
            net_sol: Number(r.sell_sol || 0) - Number(r.buy_sol || 0),
        }));
    }

    async getTokenOperations(mint, hours = 24, groupId = null, userId) {
        let query = `
            SELECT 
                t.block_time,
                t.transaction_type,
                t.sol_spent,
                t.sol_received,
                to_.amount as token_amount,
                tk.decimals,
                w.address as wallet_address,
                w.name as wallet_name,
                w.group_id,
                g.name as group_name
            FROM tokens tk
            JOIN token_operations to_ ON to_.token_id = tk.id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE tk.mint = $1
              AND t.block_time >= NOW() - INTERVAL '${hours} hours'
              AND w.user_id = $2
        `;
        const params = [mint, userId];
        if (groupId) {
            query += ` AND w.group_id = $3`;
            params.push(groupId);
        }
        query += `
            ORDER BY t.block_time ASC
        `;
        const result = await this.pool.query(query, params);
        return result.rows.map(r => ({
            time: r.block_time,
            type: r.transaction_type,
            sol: r.transaction_type === 'buy' ? Number(r.sol_spent || 0) : Number(r.sol_received || 0),
            tokenAmount: Number(r.token_amount || 0),
            decimals: r.decimals || 0,
            wallet: { 
                address: r.wallet_address, 
                name: r.wallet_name,
                group_id: r.group_id,
                group_name: r.group_name 
            }
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