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
                        // Игнорируем ошибки для существующих объектов
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

    // UPDATED: Groups methods - no user context needed
    async addGroup(name, createdBy = null) {
        const query = `
            INSERT INTO groups (name, created_by)
            VALUES ($1, $2)
            RETURNING id, name, created_by, created_at
        `;
        try {
            const result = await this.pool.query(query, [name, createdBy]);
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
            SELECT g.id, g.name, COUNT(w.id) as wallet_count, g.created_by, g.created_at,
                   u.username as created_by_username, u.first_name as created_by_name
            FROM groups g
            LEFT JOIN wallets w ON g.id = w.group_id AND w.is_active = true
            LEFT JOIN users u ON g.created_by = u.id
            GROUP BY g.id, g.name, g.created_by, g.created_at, u.username, u.first_name
            ORDER BY g.created_at
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }

    // UPDATED: Wallet methods - no user context needed
    async addWallet(address, name = null, groupId = null, addedBy = null) {
        if (!address) {
            throw new Error('Wallet address is required');
        }
    
        if (address.length < 32 || address.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            throw new Error('Invalid Solana wallet address format');
        }
    
        const query = `
            INSERT INTO wallets (address, name, group_id, added_by) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, address, name, group_id, added_by, created_at
        `;
        
        try {
            const result = await this.pool.query(query, [address, name, groupId, addedBy]);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet:`, error);
            
            if (error.code === '23505') {
                throw new Error(`Wallet ${address.slice(0, 8)}... already exists`);
            }
            
            if (error.code === '23503') {
                if (error.constraint && error.constraint.includes('group_id')) {
                    throw new Error('Invalid group ID');
                }
            }
            
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async addWalletsBatchOptimized(wallets) {
        if (!wallets || wallets.length === 0) {
            throw new Error('Wallets array is required');
        }
    
        const maxBatchSize = 1000;
        if (wallets.length > maxBatchSize) {
            throw new Error(`Batch size too large. Maximum ${maxBatchSize} wallets per batch.`);
        }
    
        const startTime = Date.now();
        console.log(`[${new Date().toISOString()}] 🚀 Starting global batch insert: ${wallets.length} wallets`);
    
        try {
            const client = await this.pool.connect();
            
            try {
                await client.query('BEGIN');
    
                const values = [];
                const placeholders = [];
                
                wallets.forEach((wallet, index) => {
                    const offset = index * 4;
                    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}::uuid, $${offset + 4}::uuid)`);
                    values.push(
                        wallet.address,
                        wallet.name || null,
                        wallet.groupId || null,
                        wallet.addedBy || null
                    );
                });
    
                const insertQuery = `
                    INSERT INTO wallets (address, name, group_id, added_by)
                    VALUES ${placeholders.join(', ')}
                    ON CONFLICT (address) DO NOTHING
                    RETURNING id, address, name, group_id, added_by, created_at
                `;
    
                const insertResult = await client.query(insertQuery, values);
                await client.query('COMMIT');

                const insertTime = Date.now() - startTime;
                console.log(`[${new Date().toISOString()}] ✅ Global batch insert completed in ${insertTime}ms: ${insertResult.rows.length} wallets`);
                
                return insertResult.rows;
    
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
    
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Global batch insert failed:`, error.message);
            throw new Error(`Global batch insert failed: ${error.message}`);
        }
    }

    async removeWallet(address) {
        const query = `DELETE FROM wallets WHERE address = $1 RETURNING id`;
        
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
        let query = `DELETE FROM wallets WHERE 1=1`;
        const params = [];
        
        if (groupId) {
            query += ` AND group_id = $1`;
            params.push(groupId);
        }
        
        try {
            const result = await this.pool.query(query, params);
            return { deletedCount: result.rowCount };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallets:`, error);
            throw new Error(`Failed to remove wallets: ${error.message}`);
        }
    }

    async getActiveWallets(groupId = null) {
        let query = `
            SELECT w.*, g.name as group_name, u.username as added_by_username
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
            LEFT JOIN users u ON w.added_by = u.id
            WHERE w.is_active = TRUE
        `;
        const params = [];
        
        if (groupId) {
            query += ` AND w.group_id = $1`;
            params.push(groupId);
        }
        
        query += ` ORDER BY w.created_at DESC`;
        
        const result = await this.pool.query(query, params);
        console.log(`[${new Date().toISOString()}] 📊 Found ${result.rows.length} active wallets globally${groupId ? ` for group ${groupId}` : ''}`);
        
        return result.rows;
    }

    async getWalletCountFast(groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🚀 Fast wallet count globally${groupId ? ` for group ${groupId}` : ''}`);
            const startTime = Date.now();
    
            let query;
            let params = [];
    
            if (groupId) {
                query = `
                    SELECT 
                        COUNT(*) as total_wallets,
                        $1::uuid as group_id,
                        g.name as group_name,
                        COUNT(*) as wallet_count
                    FROM wallets w
                    LEFT JOIN groups g ON w.group_id = g.id
                    WHERE w.is_active = true AND w.group_id = $1::uuid
                    GROUP BY g.name
                `;
                params = [groupId];
            } else {
                query = `
                    WITH group_counts AS (
                        SELECT 
                            w.group_id,
                            COALESCE(g.name, 'No Group') as group_name,
                            COUNT(*) as wallet_count
                        FROM wallets w
                        LEFT JOIN groups g ON w.group_id = g.id
                        WHERE w.is_active = true
                        GROUP BY w.group_id, g.name
                    ),
                    total_count AS (
                        SELECT SUM(wallet_count) as total_wallets
                        FROM group_counts
                    )
                    SELECT 
                        tc.total_wallets,
                        gc.group_id,
                        gc.group_name,
                        gc.wallet_count
                    FROM total_count tc
                    CROSS JOIN group_counts gc
                    UNION ALL
                    SELECT 
                        tc.total_wallets,
                        NULL as group_id,
                        'TOTAL' as group_name,
                        tc.total_wallets as wallet_count
                    FROM total_count tc
                    ORDER BY group_id NULLS LAST
                `;
            }
    
            const result = await this.pool.query(query, params);
            const duration = Date.now() - startTime;
    
            if (groupId) {
                const groupData = result.rows[0];
                const totalWallets = groupData ? parseInt(groupData.total_wallets || 0) : 0;
                
                console.log(`[${new Date().toISOString()}] ⚡ Fast wallet count completed in ${duration}ms: ${totalWallets} wallets`);
                
                return {
                    totalWallets: totalWallets,
                    selectedGroup: groupData ? {
                        groupId: groupData.group_id,
                        walletCount: parseInt(groupData.wallet_count || 0),
                        groupName: groupData.group_name
                    } : null,
                    groups: []
                };
            } else {
                const totalRow = result.rows.find(row => row.group_name === 'TOTAL');
                const totalWallets = totalRow ? parseInt(totalRow.total_wallets || 0) : 0;
                
                const groups = result.rows
                    .filter(row => row.group_name !== 'TOTAL')
                    .map(row => ({
                        groupId: row.group_id,
                        groupName: row.group_name,
                        walletCount: parseInt(row.wallet_count || 0)
                    }));
    
                console.log(`[${new Date().toISOString()}] ⚡ Fast wallet count completed in ${duration}ms: ${totalWallets} wallets globally`);
    
                return {
                    totalWallets: totalWallets,
                    selectedGroup: null,
                    groups: groups
                };
            }
    
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in fast wallet count:`, error);
            throw new Error(`Failed to get wallet count: ${error.message}`);
        }
    }

    // UPDATED: Transaction methods - no user context needed
    async getRecentTransactionsOptimized(hours = 24, limit = 400, transactionType = null, groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🚀 Global transactions fetch: ${hours}h, limit ${limit}${groupId ? `, group ${groupId}` : ''}`);
            const startTime = Date.now();

            let typeFilter = '';
            let queryParams = [limit];
            let paramIndex = 2;
            
            if (transactionType) {
                typeFilter = `AND t.transaction_type = $${paramIndex++}`;
                queryParams.push(transactionType);
            }
            if (groupId) {
                typeFilter += ` AND w.group_id = $${paramIndex++}`;
                queryParams.push(groupId);
            }

            const optimizedQuery = `
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
                    COALESCE(
                        json_agg(
                            CASE 
                                WHEN tk.mint IS NOT NULL 
                                THEN json_build_object(
                                    'mint', tk.mint,
                                    'symbol', tk.symbol,
                                    'name', tk.name,
                                    'amount', to_.amount,
                                    'decimals', tk.decimals,
                                    'operation_type', to_.operation_type
                                )
                                ELSE NULL
                            END
                        ) FILTER (WHERE tk.mint IS NOT NULL),
                        '[]'::json
                    ) as tokens
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                LEFT JOIN tokens tk ON to_.token_id = tk.id
                WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
                ${typeFilter}
                GROUP BY t.id, t.signature, t.block_time, t.transaction_type, 
                         t.sol_spent, t.sol_received, w.address, w.name, 
                         w.group_id, g.name
                ORDER BY t.block_time DESC
                LIMIT $1
            `;

            const result = await this.pool.query(optimizedQuery, queryParams);
            const duration = Date.now() - startTime;

            console.log(`[${new Date().toISOString()}] ⚡ Global transactions fetch completed in ${duration}ms: ${result.rows.length} transactions`);

            return result.rows.map(row => {
                const tokens = Array.isArray(row.tokens) ? row.tokens.filter(t => t !== null) : [];
                
                return {
                    signature: row.signature,
                    time: row.block_time,
                    transactionType: row.transaction_type,
                    solSpent: row.sol_spent ? Number(row.sol_spent).toFixed(6) : null,
                    solReceived: row.sol_received ? Number(row.sol_received).toFixed(6) : null,
                    wallet: {
                        address: row.wallet_address,
                        name: row.wallet_name,
                        group_id: row.group_id,
                        group_name: row.group_name,
                    },
                    tokensBought: tokens.filter(t => t.operation_type === 'buy').map(t => ({
                        mint: t.mint,
                        symbol: t.symbol,
                        name: t.name,
                        amount: Number(t.amount),
                        decimals: t.decimals
                    })),
                    tokensSold: tokens.filter(t => t.operation_type === 'sell').map(t => ({
                        mint: t.mint,
                        symbol: t.symbol,
                        name: t.name,
                        amount: Number(t.amount),
                        decimals: t.decimals
                    }))
                };
            });

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in global transactions fetch:`, error);
            throw error;
        }
    }

    async getMonitoringStatusFast(groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] ⚡ Fast global monitoring status${groupId ? ` for group ${groupId}` : ''}`);
            
            let query = `
                SELECT 
                    COUNT(DISTINCT w.id) as active_wallets,
                    COUNT(CASE WHEN t.transaction_type = 'buy' AND t.block_time >= CURRENT_DATE THEN 1 END) as buy_transactions_today,
                    COUNT(CASE WHEN t.transaction_type = 'sell' AND t.block_time >= CURRENT_DATE THEN 1 END) as sell_transactions_today,
                    COALESCE(SUM(CASE WHEN t.block_time >= CURRENT_DATE THEN t.sol_spent ELSE 0 END), 0) as sol_spent_today,
                    COALESCE(SUM(CASE WHEN t.block_time >= CURRENT_DATE THEN t.sol_received ELSE 0 END), 0) as sol_received_today,
                    COUNT(DISTINCT CASE WHEN t.block_time >= CURRENT_DATE THEN to_.token_id END) as unique_tokens_today
                FROM wallets w
                LEFT JOIN transactions t ON w.id = t.wallet_id 
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                WHERE w.is_active = TRUE
            `;
            
            const params = [];
            
            if (groupId) {
                query += ` AND w.group_id = $1`;
                params.push(groupId);
            }
            
            const result = await this.pool.query(query, params);
            return result.rows[0];
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in global monitoring status:`, error);
            throw error;
        }
    }

    // Remove all user-specific wallet methods
    async getWalletByAddress(address) {
        const query = `
            SELECT w.*, g.name as group_name, u.username as added_by_username
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
            LEFT JOIN users u ON w.added_by = u.id
            WHERE w.address = $1
        `;
        const result = await this.pool.query(query, [address]);
        return result.rows[0] || null;
    }

    // UPDATED: Token methods - remove user filtering
    async getTokenWalletAggregates(hours = 24, groupId = null) {
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
                COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN ABS(to_.amount) ELSE 0 END), 0) as tokens_bought,
                COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN ABS(to_.amount) ELSE 0 END), 0) as tokens_sold,
                MAX(t.block_time) as last_activity
            FROM tokens tk
            JOIN token_operations to_ ON tk.id = to_.token_id
            JOIN transactions t ON to_.transaction_id = t.id
            JOIN wallets w ON t.wallet_id = w.id
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            AND tk.mint NOT IN (${EXCLUDED_TOKENS.map((_, i) => `$${i + 1}`).join(', ')})
        `;
        
        const params = [...EXCLUDED_TOKENS];
        
        if (groupId) {
            query += ` AND w.group_id = $${params.length + 1}`;
            params.push(groupId);
        }
        
        query += `
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name, w.group_id, g.name
            ORDER BY last_activity DESC, tk.mint, w.address
        `;
        
        const result = await this.pool.query(query, params);
        console.log(`[${new Date().toISOString()}] 📊 Global token aggregates: ${result.rows.length} rows${groupId ? ` for group ${groupId}` : ''}`);
        
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
                tokens_bought: tokensBought,
                tokens_sold: tokensSold,
                pnl_sol: pnlSol,
                last_activity: row.last_activity
            };
        });
    }

    // Keep existing methods but remove user filtering
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