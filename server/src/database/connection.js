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
                        console.warn(`⚠️ Skipping statement due to error: ${err.message}`);
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

    async addWallet(address, name = null, groupId) {
        return this.withTransaction(async (client) => {
            // Check if group exists
            if (groupId) {
                const groupCheck = await client.query('SELECT id FROM groups WHERE id = $1', [groupId]);
                if (groupCheck.rows.length === 0) {
                    throw new Error('Group not found');
                }
            }

            // Check if wallet exists
            let wallet = await this.getWalletByAddress(address);
            if (!wallet) {
                // Add new wallet
                const walletQuery = `
                    INSERT INTO wallets (address, name) 
                    VALUES ($1, $2) 
                    RETURNING id, address, name, created_at
                `;
                const walletResult = await client.query(walletQuery, [address, name]);
                wallet = walletResult.rows[0];
            }

            // Add group association
            if (groupId) {
                const existingAssociation = await client.query(
                    'SELECT 1 FROM wallet_groups WHERE wallet_id = $1 AND group_id = $2',
                    [wallet.id, groupId]
                );
                
                if (existingAssociation.rows.length === 0) {
                    const groupQuery = `
                        INSERT INTO wallet_groups (wallet_id, group_id) 
                        VALUES ($1, $2)
                        RETURNING wallet_id, group_id
                    `;
                    await client.query(groupQuery, [wallet.id, groupId]);
                }
            }

            return {
                ...wallet,
                group_id: groupId,
            };
        });
    }

    async removeWallet(address) {
        return this.withTransaction(async (client) => {
            const query = `
                DELETE FROM wallets 
                WHERE address = $1
                RETURNING id
            `;
            const result = await client.query(query, [address]);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found');
            }
            return result.rows[0];
        });
    }

    async removeAllWallets(groupId = null) {
        return this.withTransaction(async (client) => {
            let query = 'DELETE FROM wallets';
            const params = [];
            
            if (groupId) {
                query = `
                    DELETE FROM wallets 
                    WHERE id IN (
                        SELECT wallet_id 
                        FROM wallet_groups 
                        WHERE group_id = $1
                    )
                `;
                params.push(groupId);
            }

            const result = await client.query(query, params);
            return { deletedCount: result.rowCount };
        });
    }

    async getActiveWallets() {
        const query = `
            SELECT w.*, 
                   ARRAY_AGG(g.id) as group_ids,
                   ARRAY_AGG(g.name) as group_names,
                   COUNT(t.id) as transaction_count,
                   (SELECT COUNT(*) FROM wallet_groups wg WHERE wg.wallet_id = w.id) as group_count
            FROM wallets w
            LEFT JOIN wallet_groups wg ON w.id = wg.wallet_id
            LEFT JOIN groups g ON wg.group_id = g.id
            LEFT JOIN transactions t ON w.id = t.wallet_id
            WHERE w.is_active = TRUE 
            GROUP BY w.id
            ORDER BY w.created_at DESC
        `;
        const result = await this.pool.query(query);
        return result.rows.map(row => ({
            ...row,
            groups: row.group_ids
                ? row.group_ids.map((id, index) => ({
                      id,
                      name: row.group_names[index],
                  }))
                : [],
        }));
    }

    async getWalletsByGroup(groupId) {
        const query = `
            SELECT w.*, 
                   g.name as group_name,
                   COUNT(t.id) as transaction_count
            FROM wallets w
            JOIN wallet_groups wg ON w.id = wg.wallet_id
            JOIN groups g ON wg.group_id = g.id
            LEFT JOIN transactions t ON w.id = t.wallet_id
            WHERE w.is_active = TRUE AND wg.group_id = $1
            GROUP BY w.id, g.name
            ORDER BY w.created_at DESC
        `;
        const result = await this.pool.query(query, [groupId]);
        return result.rows.map(row => ({
            ...row,
            groups: [{ id: groupId, name: row.group_name }],
        }));
    }

    async createGroup(name) {
        const query = `
            INSERT INTO groups (name) 
            VALUES ($1) 
            RETURNING id, name, created_at
        `;
        const result = await this.pool.query(query, [name]);
        return {
            ...result.rows[0],
            walletCount: 0,
        };
    }

    async getGroups() {
        const query = `
            SELECT g.*, 
                   (SELECT COUNT(*) FROM wallet_groups wg WHERE wg.group_id = g.id) as wallet_count
            FROM groups g
            ORDER BY g.created_at DESC
        `;
        const result = await this.pool.query(query);
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
        const query = `
            SELECT w.*, 
                   ARRAY_AGG(g.id) as group_ids,
                   ARRAY_AGG(g.name) as group_names
            FROM wallets w
            LEFT JOIN wallet_groups wg ON w.id = wg.wallet_id
            LEFT JOIN groups g ON wg.group_id = g.id
            WHERE w.address = $1
            GROUP BY w.id
        `;
        const result = await this.pool.query(query, [address]);
        return result.rows[0]
            ? {
                  ...result.rows[0],
                  groups: result.rows[0].group_ids
                      ? result.rows[0].group_ids.map((id, index) => ({
                            id,
                            name: result.rows[0].group_names[index],
                        }))
                      : [],
              }
            : null;
    }

    async getRecentTransactions(hours, limit, type = null, groupId = null) {
        let query = `
            SELECT 
                t.signature,
                t.block_time,
                t.transaction_type,
                t.sol_spent,
                t.sol_received,
                w.address as wallet_address,
                w.name as wallet_name,
                to_op.amount as token_amount,
                tok.mint,
                tok.symbol,
                tok.name as token_name,
                tok.decimals,
                to_op.operation_type
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
            LEFT JOIN token_operations to_op ON t.id = to_op.transaction_id
            LEFT JOIN tokens tok ON to_op.token_id = tok.id
            WHERE t.block_time >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        `;
        const params = [];

        if (type && type !== 'all') {
            query += ` AND t.transaction_type = $${params.length + 1}`;
            params.push(type);
        }

        if (groupId) {
            query += ` AND w.id IN (SELECT wallet_id FROM wallet_groups WHERE group_id = $${params.length + 1})`;
            params.push(groupId);
        }

        query += `
            ORDER BY t.block_time DESC
            LIMIT $${params.length + 1}
        `;
        params.push(limit);

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getMonitoringStats(groupId = null) {
        let query = `
            SELECT 
                COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as buy_transactions_today,
                COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as sell_transactions_today,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent_today,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received_today
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
        `;
        const params = [];

        if (groupId) {
            query += ` AND w.id IN (SELECT wallet_id FROM wallet_groups WHERE group_id = $${params.length + 1})`;
            params.push(groupId);
        }

        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    async getTopTokens(limit = 10, type = null, groupId = null) {
        let query = `
            SELECT 
                tok.mint,
                tok.symbol,
                tok.name,
                tok.decimals,
                COUNT(DISTINCT w.id) as unique_wallets,
                COUNT(CASE WHEN to_op.operation_type = 'buy' THEN 1 END) as buy_count,
                COUNT(CASE WHEN to_op.operation_type = 'sell' THEN 1 END) as sell_count,
                COALESCE(SUM(CASE WHEN to_op.operation_type = 'buy' THEN to_op.amount ELSE 0 END), 0) as total_bought,
                COALESCE(SUM(CASE WHEN to_op.operation_type = 'sell' THEN to_op.amount ELSE 0 END), 0) as total_sold,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received
            FROM tokens tok
            JOIN token_operations to_op ON tok.id = to_op.token_id
            JOIN transactions t ON to_op.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= CURRENT_TIMESTAMP - INTERVAL '168 hours'
        `;
        const params = [];

        if (type && type !== 'all') {
            query += ` AND t.transaction_type = $${params.length + 1}`;
            params.push(type);
        }

        if (groupId) {
            query += ` AND w.id IN (SELECT wallet_id FROM wallet_groups WHERE group_id = $${params.length + 1})`;
            params.push(groupId);
        }

        query += `
            GROUP BY tok.id
            ORDER BY unique_wallets DESC, sol_spent DESC
            LIMIT $${params.length + 1}
        `;
        params.push(limit);

        const result = await this.pool.query(query, params);
        return result.rows.map(row => ({
            ...row,
            total_bought: Number(row.total_bought),
            total_sold: Number(row.total_sold),
            sol_spent: Number(row.sol_spent),
            sol_received: Number(row.sol_received),
        }));
    }

    async getTokenWalletAggregates(hours, groupId = null) {
        let query = `
            SELECT 
                tok.mint,
                tok.symbol,
                tok.name,
                tok.decimals,
                w.address as wallet_address,
                w.name as wallet_name,
                MAX(t.block_time) as last_activity,
                COUNT(CASE WHEN to_op.operation_type = 'buy' THEN 1 END) as tx_buys,
                COUNT(CASE WHEN to_op.operation_type = 'sell' THEN 1 END) as tx_sells,
                COALESCE(SUM(CASE WHEN to_op.operation_type = 'buy' THEN to_op.amount ELSE 0 END), 0) as tokens_bought,
                COALESCE(SUM(CASE WHEN to_op.operation_type = 'sell' THEN to_op.amount ELSE 0 END), 0) as tokens_sold,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent,
                COALESCE(SUM(CASE WHEN t.transaction_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received
            FROM tokens tok
            JOIN token_operations to_op ON tok.id = to_op.token_id
            JOIN transactions t ON to_op.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            WHERE t.block_time >= CURRENT_TIMESTAMP - INTERVAL '${hours} hours'
        `;
        const params = [];

        if (groupId) {
            query += ` AND w.id IN (SELECT wallet_id FROM wallet_groups WHERE group_id = $${params.length + 1})`;
            params.push(groupId);
        }

        query += `
            GROUP BY tok.id, w.id
            ORDER BY sol_spent DESC, last_activity DESC
        `;
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getWalletStats(walletId) {
        const query = `
            SELECT 
                COUNT(CASE WHEN transaction_type = 'buy' THEN 1 END) as total_buy_transactions,
                COUNT(CASE WHEN transaction_type = 'sell' THEN 1 END) as total_sell_transactions,
                COALESCE(SUM(sol_spent), 0) as total_sol_spent,
                COALESCE(SUM(sol_received), 0) as total_sol_received,
                MAX(block_time) as last_transaction_at
            FROM transactions
            WHERE wallet_id = $1
        `;
        const result = await this.pool.query(query, [walletId]);
        return result.rows[0];
    }

    async close() {
        try {
            await this.pool.end();
            console.log('✅ Database connection closed');
        } catch (error) {
            console.error('❌ Error closing database connection:', error.message);
        }
    }
}

module.exports = Database;