const { Pool } = require('pg');

class Database {
    constructor() {
        this.pool = new Pool({
            connectionString: process.env.DATABASE_URL,
        });
    }

    async addWallet(address, name = null, groupId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Insert or update wallet
            const walletQuery = `
                INSERT INTO wallets (address, name, created_at, updated_at)
                VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                ON CONFLICT (address) DO UPDATE
                SET name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP
                RETURNING id, address, name
            `;
            const walletResult = await client.query(walletQuery, [address, name]);
            const wallet = walletResult.rows[0];

            // Associate with group if groupId is provided
            if (groupId) {
                const groupQuery = `
                    INSERT INTO wallet_groups (wallet_id, group_id)
                    VALUES ($1, $2)
                    ON CONFLICT DO NOTHING
                `;
                await client.query(groupQuery, [wallet.id, groupId]);
            }

            await client.query('COMMIT');
            return wallet;
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`Failed to add wallet: ${error.message}`);
        } finally {
            client.release();
        }
    }

    async getWalletByAddress(address) {
        const query = `
            SELECT w.id, w.address, w.name, ARRAY_AGG(wg.group_id) as groups
            FROM wallets w
            LEFT JOIN wallet_groups wg ON w.id = wg.wallet_id
            WHERE w.address = $1
            GROUP BY w.id, w.address, w.name
        `;
        const result = await this.pool.query(query, [address]);
        return result.rows[0] ? { ...result.rows[0], groups: result.rows[0].groups || [] } : null;
    }

    async getWalletsByGroup(groupId) {
        const query = `
            SELECT w.id, w.address, w.name
            FROM wallets w
            JOIN wallet_groups wg ON w.id = wg.wallet_id
            WHERE wg.group_id = $1
        `;
        const result = await this.pool.query(query, [groupId]);
        return result.rows;
    }

    async getActiveWallets() {
        const query = `
            SELECT w.id, w.address, w.name
            FROM wallets w
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }

    async removeWallet(address) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const walletQuery = `
                SELECT id FROM wallets WHERE address = $1
            `;
            const walletResult = await client.query(walletQuery, [address]);
            if (walletResult.rows.length === 0) {
                throw new Error('Wallet not found');
            }
            const walletId = walletResult.rows[0].id;

            await client.query('DELETE FROM wallet_groups WHERE wallet_id = $1', [walletId]);
            await client.query('DELETE FROM transactions WHERE wallet_id = $1', [walletId]);
            await client.query('DELETE FROM wallets WHERE id = $1', [walletId]);

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`Failed to remove wallet: ${error.message}`);
        } finally {
            client.release();
        }
    }

    async removeAllWallets(groupId = null) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            if (groupId) {
                const walletIdsQuery = `
                    SELECT wallet_id FROM wallet_groups WHERE group_id = $1
                `;
                const walletIdsResult = await client.query(walletIdsQuery, [groupId]);
                const walletIds = walletIdsResult.rows.map(row => row.wallet_id);

                if (walletIds.length > 0) {
                    await client.query('DELETE FROM wallet_groups WHERE group_id = $1', [groupId]);
                    await client.query('DELETE FROM transactions WHERE wallet_id = ANY($1)', [walletIds]);
                    await client.query('DELETE FROM wallets WHERE id = ANY($1)', [walletIds]);
                }
            } else {
                await client.query('DELETE FROM wallet_groups');
                await client.query('DELETE FROM transactions');
                await client.query('DELETE FROM wallets');
            }

            await client.query('COMMIT');
            return { deletedCount: groupId ? walletIds.length : await this.getWalletCount() };
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`Failed to remove all wallets: ${error.message}`);
        } finally {
            client.release();
        }
    }

    async getGroups() {
        const query = `
            SELECT g.id, g.name, COUNT(wg.wallet_id) as walletCount
            FROM groups g
            LEFT JOIN wallet_groups wg ON g.id = wg.group_id
            GROUP BY g.id, g.name
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }

    async getGroupById(groupId) {
        const query = `
            SELECT id, name FROM groups WHERE id = $1
        `;
        const result = await this.pool.query(query, [groupId]);
        return result.rows[0] || null;
    }

    async createGroup(name) {
        const query = `
            INSERT INTO groups (name, created_at)
            VALUES ($1, CURRENT_TIMESTAMP)
            RETURNING id, name
        `;
        const result = await this.pool.query(query, [name]);
        return result.rows[0];
    }

    async getWalletStats(walletId) {
        const query = `
            SELECT 
                COUNT(*) FILTER (WHERE transaction_type = 'buy') as total_buy_transactions,
                COUNT(*) FILTER (WHERE transaction_type = 'sell') as total_sell_transactions,
                SUM(sol_spent) as total_sol_spent,
                SUM(sol_received) as total_sol_received,
                MAX(block_time) as last_transaction_at
            FROM transactions
            WHERE wallet_id = $1
        `;
        const result = await this.pool.query(query, [walletId]);
        return result.rows[0];
    }

    async getRecentTransactions(hours, limit, type, groupId) {
        let query = `
            SELECT 
                t.signature, t.block_time, t.transaction_type,
                t.sol_spent, t.sol_received,
                w.address as wallet_address, w.name as wallet_name,
                to.mint, to.amount as token_amount, to.operation_type,
                tok.symbol, tok.name as token_name, tok.decimals
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
            LEFT JOIN token_operations to ON t.id = to.transaction_id
            LEFT JOIN tokens tok ON to.token_id = tok.id
        `;
        const params = [];
        let conditions = [];

        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id `;
            conditions.push(`wg.group_id = $${params.length + 1}`);
            params.push(groupId);
        }

        conditions.push(`t.block_time >= NOW() - INTERVAL '${hours} hours'`);
        if (type && type !== 'all') {
            conditions.push(`t.transaction_type = $${params.length + 1}`);
            params.push(type);
        }

        query += ` WHERE ${conditions.join(' AND ')}`;
        query += ` ORDER BY t.block_time DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getMonitoringStats(groupId = null) {
        let query = `
            SELECT 
                COUNT(*) FILTER (WHERE transaction_type = 'buy' AND block_time >= CURRENT_DATE) as buy_transactions_today,
                COUNT(*) FILTER (WHERE transaction_type = 'sell' AND block_time >= CURRENT_DATE) as sell_transactions_today,
                SUM(sol_spent) FILTER (WHERE block_time >= CURRENT_DATE) as sol_spent_today,
                SUM(sol_received) FILTER (WHERE block_time >= CURRENT_DATE) as sol_received_today
            FROM transactions t
            JOIN wallets w ON t.wallet_id = w.id
        `;
        const params = [];

        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id `;
            query += ` WHERE wg.group_id = $1`;
            params.push(groupId);
        }

        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    async getTopTokens(limit, type, groupId) {
        let query = `
            SELECT 
                t.mint, t.symbol, t.name, t.decimals,
                COUNT(*) FILTER (WHERE to2.operation_type = 'buy') as buy_count,
                COUNT(*) FILTER (WHERE to2.operation_type = 'sell') as sell_count,
                SUM(to2.amount) FILTER (WHERE to2.operation_type = 'buy') as total_bought,
                SUM(to2.amount) FILTER (WHERE to2.operation_type = 'sell') as total_sold
            FROM tokens t
            JOIN token_operations to2 ON t.id = to2.token_id
            JOIN transactions tx ON to2.transaction_id = tx.id
            JOIN wallets w ON tx.wallet_id = w.id
        `;
        const params = [];
        let conditions = [];

        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id `;
            conditions.push(`wg.group_id = $${params.length + 1}`);
            params.push(groupId);
        }

        if (type && type !== 'all') {
            conditions.push(`to2.operation_type = $${params.length + 1}`);
            params.push(type);
        }

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` GROUP BY t.mint, t.symbol, t.name, t.decimals ORDER BY buy_count + sell_count DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getTokenWalletAggregates(hours, groupId) {
        let query = `
            SELECT 
                t.mint, t.symbol, t.name, t.decimals,
                w.address as wallet_address, w.name as wallet_name,
                COUNT(*) FILTER (WHERE to2.operation_type = 'buy') as tx_buys,
                COUNT(*) FILTER (WHERE to2.operation_type = 'sell') as tx_sells,
                SUM(to2.amount) FILTER (WHERE to2.operation_type = 'buy') as tokens_bought,
                SUM(to2.amount) FILTER (WHERE to2.operation_type = 'sell') as tokens_sold,
                SUM(tx.sol_spent) as sol_spent,
                SUM(tx.sol_received) as sol_received,
                MAX(tx.block_time) as last_activity
            FROM tokens t
            JOIN token_operations to2 ON t.id = to2.token_id
            JOIN transactions tx ON to2.transaction_id = tx.id
            JOIN wallets w ON tx.wallet_id = w.id
        `;
        const params = [];
        let conditions = [];

        if (groupId) {
            query += ` JOIN wallet_groups wg ON w.id = wg.wallet_id `;
            conditions.push(`wg.group_id = $${params.length + 1}`);
            params.push(groupId);
        }

        conditions.push(`tx.block_time >= NOW() - INTERVAL '${hours} hours'`);
        query += ` WHERE ${conditions.join(' AND ')}`;
        query += ` GROUP BY t.mint, t.symbol, t.name, t.decimals, w.address, w.name`;

        const result = await this.pool.query(query, params);
        return result.rows;
    }

    async getWalletCount() {
        const query = `SELECT COUNT(*) as count FROM wallets`;
        const result = await this.pool.query(query);
        return parseInt(result.rows[0].count);
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
        await this.pool.end();
        console.log(`[${new Date().toISOString()}] ✅ Database connection closed`);
    }
}

module.exports = Database;