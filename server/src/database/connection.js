// database/connection.js
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

    async addGroup(name) {
        const query = `
            INSERT INTO groups (name)
            VALUES ($1)
            RETURNING id, name, created_at
        `;
        try {
            const result = await this.pool.query(query, [name]);
            return result.rows[0];
        } catch (error) {
            if (error.code === '23505') {
                throw new Error('Group name already exists');
            }
            throw error;
        }
    }

    async getGroups() {
        const query = `
            SELECT g.id, g.name, COUNT(wg.wallet_id) as wallet_count
            FROM groups g
            LEFT JOIN wallet_groups wg ON g.id = wg.group_id
            GROUP BY g.id, g.name
            ORDER BY g.created_at
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }

    async addWallet(address, name = null, groupId = null) {
        return await this.withTransaction(async (client) => {
          const upsertWallet = `
            INSERT INTO wallets (address, name) 
            VALUES ($1, $2) 
            ON CONFLICT (address) DO UPDATE SET name = COALESCE(EXCLUDED.name, wallets.name)
            RETURNING *
          `;
          const walletRes = await client.query(upsertWallet, [address, name]);
          const wallet = walletRes.rows[0];
      
          if (groupId) {
            const addMembership = `
              INSERT INTO wallet_groups (wallet_id, group_id)
              VALUES ($1, $2)
              ON CONFLICT DO NOTHING
            `;
            await client.query(addMembership, [wallet.id, groupId]);
          }
      
          return wallet;
        });
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

    async removeAllWallets(groupId = null) {
        let query = `DELETE FROM wallets`;
        const params = [];
        if (groupId) {
            query += ` WHERE id IN (SELECT wallet_id FROM wallet_groups WHERE group_id = $1)`;
            params.push(groupId);
            await this.pool.query('DELETE FROM wallet_groups WHERE group_id = $1', [groupId]);
        } else {
            await this.pool.query('DELETE FROM wallet_groups');
        }
        try {
            const result = await this.pool.query(query, params);
            console.log(`[${new Date().toISOString()}] 🗑️ Removed ${result.rowCount} wallets and associated data`);
            return { deletedCount: result.rowCount };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets:`, error);
            throw new Error(`Failed to remove all wallets: ${error.message}`);
        }
    }

    async getActiveWallets(groupId = null) {
        let query = `
            SELECT w.*, NULL as group_name
            FROM wallets w
        `;
        const params = [];
        if (groupId) {
            query = `
              SELECT w.*, (SELECT name FROM groups WHERE id = $1) as group_name
              FROM wallets w
              JOIN wallet_groups wg ON w.id = wg.wallet_id
              WHERE wg.group_id = $1 AND w.is_active = TRUE
            `;
            params.push(groupId);
        } else {
            query += ` WHERE w.is_active = TRUE `;
        }
        query += ` ORDER BY w.created_at DESC`;
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async isWalletInGroup(walletId, groupId) {
        if (!groupId) return true; // If no group active, always true
        const query = 'SELECT 1 FROM wallet_groups WHERE wallet_id = $1 AND group_id = $2 LIMIT 1';
        const result = await this.pool.query(query, [walletId, groupId]);
        return result.rowCount > 0;
      }
      
      async getGroupName(groupId) {
        if (!groupId) return null;
        const query = 'SELECT name FROM groups WHERE id = $1';
        const result = await this.pool.query(query, [groupId]);
        return result.rows[0]?.name || null;
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

    async getRecentTransactions(hours = 24, limit = 400, transactionType = null, groupId = null) {
        try {
          let typeFilter = '';
          let queryParams = [hours, limit];
          let paramIndex = 3;
          
          if (transactionType) {
            typeFilter = `AND t.transaction_type = $${paramIndex++}`;
            queryParams.push(transactionType);
          }
          let groupJoin = '';
          let groupNameSelect = ', NULL as group_name, NULL as group_id';
          if (groupId) {
            groupJoin = `JOIN wallet_groups wg ON w.id = wg.wallet_id`;
            typeFilter += ` AND wg.group_id = $${paramIndex}`;
            queryParams.push(groupId);
            groupNameSelect = `, (SELECT name FROM groups WHERE id = $${paramIndex - 1}) as group_name, $${paramIndex - 1} as group_id`;
          }
      
          const fullDataQuery = `
            SELECT 
              t.signature,
              t.block_time,
              t.transaction_type,
              t.sol_spent,
              t.sol_received,
              w.address as wallet_address,
              w.name as wallet_name${groupNameSelect},
              tk.mint,
              tk.symbol,
              tk.name as token_name,
              to_.amount as token_amount,
              to_.operation_type,
              tk.decimals
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
            ${groupJoin}
            LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
            LEFT JOIN tokens tk ON to_.token_id = tk.id
            WHERE t.block_time >= NOW() - INTERVAL '$1 hours'
            ${typeFilter}
            ORDER BY t.block_time DESC
            LIMIT $2
          `;
      
          const result = await this.pool.query(fullDataQuery, queryParams);
          
          console.log(`📊 getRecentTransactions: Found ${result.rows.length} total rows with tokens`);
          
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

    async getTopTokens(limit = 10, operationType = null, groupId = null) {
        let typeFilter = '';
        let queryParams = [limit];
        let paramIndex = 2;
        
        let groupJoin = '';
        if (groupId) {
            groupJoin = `JOIN wallet_groups wg ON w.id = wg.wallet_id`;
            typeFilter += ` AND wg.group_id = $${paramIndex++}`;
            queryParams.push(groupId);
        }
        if (operationType) {
            typeFilter += `AND to_.operation_type = $${paramIndex}`;
            queryParams.push(operationType);
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
            ${groupJoin}
            WHERE t.block_time >= NOW() - INTERVAL '24 hours'
            ${typeFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getTokenWalletAggregates(hours = 24, groupId = null) {
        let params = [];
        let query = `
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
        `;
        if (groupId) {
          query += `,
            $1 as group_id,
            (SELECT name FROM groups WHERE id = $1) as group_name
          `;
          query += `
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            JOIN wallet_groups wg ON w.id = wg.wallet_id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            AND wg.group_id = $1
          `;
          params = [groupId];
        } else {
          query += `,
            NULL as group_id,
            NULL as group_name
          `;
          query += `
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
          `;
          params = [];
        }
        query += `
          GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name
          ORDER BY tk.mint, wallet_id
        `;
        const result = await this.pool.query(query, params);
        return result.rows;
      }

    async getMonitoringStats(groupId = null) {
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
            WHERE w.is_active = TRUE
        `;
        let params = [];
        let groupJoin = '';
        if (groupId) {
            groupJoin = `JOIN wallet_groups wg ON w.id = wg.wallet_id`;
            query = query.replace('FROM wallets w', `FROM wallets w ${groupJoin}`);
            query += ` AND wg.group_id = $1`;
            params.push(groupId);
        }
        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    async getTokenInflowSeries(mint, hours = 24, groupId = null) {
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
        `;
        const params = [mint];
        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id AND wg.group_id = $2`;
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

    async getTokenOperations(mint, hours = 24, groupId = null) {
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
        `;
        const params = [mint];
        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id AND wg.group_id = $2`;
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