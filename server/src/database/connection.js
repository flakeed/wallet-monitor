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

    // UPDATED: Groups methods with user context
    async addGroup(name, userId = null) {
        if (!userId) {
            throw new Error('User ID is required');
        }
        
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
                throw new Error('Group name already exists for this user');
            }
            throw error;
        }
    }

    async getGroups(userId = null) {
        let query = `
            SELECT g.id, g.name, COUNT(w.id) as wallet_count
            FROM groups g
            LEFT JOIN wallets w ON g.id = w.group_id AND w.is_active = true
        `;
        const params = [];
        
        if (userId) {
            query += ` WHERE g.user_id = $1`;
            params.push(userId);
        }
        
        query += ` GROUP BY g.id, g.name ORDER BY g.created_at`;
        const result = await this.pool.query(query, params);
        return result.rows;
    }

    // UPDATED: Wallet methods with user context
    async addWallet(address, name = null, groupId = null, userId = null) {
        if (!address) {
            throw new Error('Wallet address is required');
        }
        
        if (!userId) {
            throw new Error('User ID is required');
        }
    
        if (address.length < 32 || address.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) {
            return res.status(400).json({ error: 'Invalid Solana wallet address format' });
        }
    
        const query = `
            INSERT INTO wallets (address, name, group_id, user_id) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, address, name, group_id, user_id, created_at
        `;
        
        try {
            const result = await this.pool.query(query, [address, name, groupId, userId]);
            return result.rows[0];
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error adding wallet:`, error);
            
            if (error.code === '23505') {
                throw new Error(`Wallet ${address.slice(0, 8)}... already exists for this user`);
            }
            
            if (error.code === '23503') {
                if (error.constraint && error.constraint.includes('user_id')) {
                    throw new Error('Invalid user ID');
                }
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
    
        // Проверяем, что все кошельки имеют userId
        const walletsWithUser = wallets.filter(w => w.userId);
        if (walletsWithUser.length !== wallets.length) {
            throw new Error('All wallets must have userId specified');
        }
    
        try {
            const client = await this.pool.connect();
            
            try {
                await client.query('BEGIN');
    
                // ИСПРАВЛЕННАЯ версия без ::uuid кастинга в параметрах
                const values = [];
                const placeholders = [];
                
                wallets.forEach((wallet, index) => {
                    const offset = index * 4;
                    // ИСПРАВЛЕНО: убран ::uuid кастинг из placeholders
                    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
                    values.push(
                        wallet.address,
                        wallet.name || null,
                        wallet.groupId || null, // PostgreSQL автоматически распознает UUID
                        wallet.userId        // PostgreSQL автоматически распознает UUID
                    );
                });
    
                const insertQuery = `
                    INSERT INTO wallets (address, name, group_id, user_id)
                    VALUES ${placeholders.join(', ')}
                    ON CONFLICT (address, user_id) DO NOTHING
                    RETURNING id, address, name, group_id, user_id, created_at
                `;
    
                console.log(`[${new Date().toISOString()}] 🗄️ Executing optimized batch insert for ${wallets.length} wallets`);
    
                const insertResult = await client.query(insertQuery, values);
    
                await client.query('COMMIT');
    
                const insertTime = Date.now() - startTime;
                const walletsPerSecond = Math.round((insertResult.rows.length / insertTime) * 1000);
                
                console.log(`[${new Date().toISOString()}] ✅ Optimized batch insert completed: ${insertResult.rows.length} inserted in ${insertTime}ms (${walletsPerSecond} wallets/sec)`);
    
                return insertResult.rows;
    
            } catch (error) {
                await client.query('ROLLBACK');
                console.error(`[${new Date().toISOString()}] ❌ Database transaction error:`, error.message);
                throw error;
            } finally {
                client.release();
            }
    
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Optimized batch insert failed:`, error.message);
            throw new Error(`Optimized batch insert failed: ${error.message}`);
        }
    }

    async addWalletsBatch(wallets) {
        // Если это большой batch, используем оптимизированную версию
        if (wallets.length > 500) {
            console.log(`[${new Date().toISOString()}] 🔄 Large batch detected (${wallets.length}), using optimized method`);
            return this.addWalletsBatchOptimized(wallets);
        }

        if (!wallets || wallets.length === 0) {
            throw new Error('Wallets array is required');
        }

        // Проверяем, что все кошельки имеют userId
        const walletsWithUser = wallets.filter(w => w.userId);
        if (walletsWithUser.length !== wallets.length) {
            throw new Error('All wallets must have userId specified');
        }

        // Для небольших batch используем существующий метод с VALUES
        const batchSize = 100; // Уменьшаем batch size для стабильности
        const results = [];

        for (let i = 0; i < wallets.length; i += batchSize) {
            const batch = wallets.slice(i, i + batchSize);
            
            const query = `
              INSERT INTO wallets (address, name, group_id, user_id) 
              VALUES ${batch.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ')}
              ON CONFLICT (address, user_id) DO NOTHING
              RETURNING id, address, name, group_id, user_id, created_at
            `;
            
            const values = [];
            batch.forEach(wallet => {
              values.push(wallet.address, wallet.name, wallet.groupId, wallet.userId);
            });
          
            try {
              const result = await this.pool.query(query, values);
              results.push(...result.rows);
              
            } catch (error) {
              console.error(`[${new Date().toISOString()}] ❌ Batch ${Math.floor(i / batchSize) + 1} failed:`, error.message);
              throw new Error(`Batch insert failed: ${error.message}`);
            }
        }

        return results;
    }

    async removeWallet(address, userId = null) {
        let query = `DELETE FROM wallets WHERE address = $1`;
        const params = [address];
        
        if (userId) {
            query += ` AND user_id = $2`;
            params.push(userId);
        }
        
        query += ` RETURNING id`;
        
        try {
            const result = await this.pool.query(query, params);
            if (result.rowCount === 0) {
                throw new Error('Wallet not found or access denied');
            }
            return result.rows[0];
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async removeAllWallets(groupId = null, userId = null) {
        let query = `DELETE FROM wallets WHERE 1=1`;
        const params = [];
        let paramIndex = 1;
        
        if (userId) {
            query += ` AND user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND group_id = $${paramIndex}`;
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

    async getActiveWallets(groupId = null, userId = null) {
        let query = `
            SELECT w.*, g.name as group_name
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE w.is_active = TRUE
        `;
        const params = [];
        let paramIndex = 1;
        
        // ОБЯЗАТЕЛЬНО фильтруем по пользователю если указан
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
            params.push(groupId);
        }
        
        query += ` ORDER BY w.created_at DESC`;
        
        const result = await this.pool.query(query, params);
        
        console.log(`[${new Date().toISOString()}] 📊 Found ${result.rows.length} active wallets for user ${userId}${groupId ? `, group ${groupId}` : ''}`);
        
        // Логируем первые несколько кошельков для отладки
        if (result.rows.length > 0) {
            result.rows.slice(0, 3).forEach(wallet => {
            });
        }
        
        return result.rows;
    }

    async checkWalletsExistBatch(addresses, userId) {
        if (!addresses || addresses.length === 0) return [];
        
        const query = `
            SELECT address, id, name, group_id, is_active 
            FROM wallets 
            WHERE address = ANY($1) AND user_id = $2
        `;
        
        try {
            const result = await this.pool.query(query, [addresses, userId]);
            return result.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error checking wallet existence batch:`, error);
            return [];
        }
    }

    async updateWalletStatsBatch(walletIds) {
        if (!walletIds || walletIds.length === 0) return [];

        console.log(`[${new Date().toISOString()}] 📊 Updating stats for ${walletIds.length} wallets...`);
        
        try {
            // Используем CTE для эффективного обновления статистики
            const query = `
                WITH wallet_stats_calc AS (
                    SELECT 
                        w.id as wallet_id,
                        COALESCE(SUM(t.sol_spent), 0) as total_spent_sol,
                        COALESCE(SUM(t.sol_received), 0) as total_received_sol,
                        COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as total_buy_transactions,
                        COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as total_sell_transactions,
                        COUNT(DISTINCT CASE WHEN to_.operation_type = 'buy' THEN to_.token_id END) as unique_tokens_bought,
                        COUNT(DISTINCT CASE WHEN to_.operation_type = 'sell' THEN to_.token_id END) as unique_tokens_sold,
                        MAX(t.block_time) as last_transaction_at
                    FROM wallets w
                    LEFT JOIN transactions t ON w.id = t.wallet_id
                    LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                    WHERE w.id = ANY($1)
                    GROUP BY w.id
                )
                INSERT INTO wallet_stats (
                    wallet_id, total_spent_sol, total_received_sol,
                    total_buy_transactions, total_sell_transactions,
                    unique_tokens_bought, unique_tokens_sold, last_transaction_at,
                    created_at, updated_at
                ) 
                SELECT 
                    wallet_id, total_spent_sol, total_received_sol,
                    total_buy_transactions, total_sell_transactions,
                    unique_tokens_bought, unique_tokens_sold, last_transaction_at,
                    NOW(), NOW()
                FROM wallet_stats_calc
                ON CONFLICT (wallet_id) DO UPDATE SET
                    total_spent_sol = EXCLUDED.total_spent_sol,
                    total_received_sol = EXCLUDED.total_received_sol,
                    total_buy_transactions = EXCLUDED.total_buy_transactions,
                    total_sell_transactions = EXCLUDED.total_sell_transactions,
                    unique_tokens_bought = EXCLUDED.unique_tokens_bought,
                    unique_tokens_sold = EXCLUDED.unique_tokens_sold,
                    last_transaction_at = EXCLUDED.last_transaction_at,
                    updated_at = NOW()
                RETURNING *
            `;

            const result = await this.pool.query(query, [walletIds]);
            console.log(`[${new Date().toISOString()}] ✅ Updated stats for ${result.rows.length} wallets`);
            return result.rows;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating wallet stats batch:`, error);
            throw error;
        }
    }

    async getActiveWalletsPaginated(offset = 0, limit = 1000, groupId = null, userId = null) {
        let query = `
            SELECT w.*, g.name as group_name,
                   COUNT(w.id) OVER() as total_count
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE w.is_active = TRUE
        `;
        const params = [];
        let paramIndex = 1;
        
        if (userId) {
            query += ` AND w.user_id = ${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = ${paramIndex++}`;
            params.push(groupId);
        }
        
        query += ` ORDER BY w.created_at DESC LIMIT ${paramIndex++} OFFSET ${paramIndex}`;
        params.push(limit, offset);
        
        const result = await this.pool.query(query, params);
        
        return {
            wallets: result.rows,
            totalCount: result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
            hasMore: result.rows.length === limit
        };
    }

    async removeWalletsBatch(addresses, userId = null) {
        if (!addresses || addresses.length === 0) return { deletedCount: 0 };

        console.log(`[${new Date().toISOString()}] 🗑️ Removing ${addresses.length} wallets...`);

        try {
            let query = `DELETE FROM wallets WHERE address = ANY($1)`;
            const params = [addresses];
            
            if (userId) {
                query += ` AND user_id = $2`;
                params.push(userId);
            }
            
            query += ` RETURNING id, address`;
            
            const result = await this.pool.query(query, params);
            
            console.log(`[${new Date().toISOString()}] ✅ Removed ${result.rowCount} wallets`);
            
            return { 
                deletedCount: result.rowCount,
                deletedWallets: result.rows 
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing wallets batch:`, error);
            throw new Error(`Failed to remove wallets: ${error.message}`);
        }
    }

    // НОВАЯ функция для оптимизации базы данных после bulk операций
    async optimizeAfterBulkOperation() {
        try {
            console.log(`[${new Date().toISOString()}] 🔧 Starting database optimization...`);
            const startTime = Date.now();

            const client = await this.pool.connect();
            
            try {
                // Обновляем статистику таблиц
                await client.query('ANALYZE wallets');
                await client.query('ANALYZE groups');
                await client.query('ANALYZE transactions');
                await client.query('ANALYZE tokens');
                
                // Очищаем устаревшие записи
                const cleanupResult = await client.query(`
                    DELETE FROM wallets 
                    WHERE is_active = false 
                    AND updated_at < NOW() - INTERVAL '7 days'
                `);

                // Обновляем счетчики групп
                await client.query(`
                    UPDATE groups 
                    SET updated_at = CURRENT_TIMESTAMP
                    FROM (
                        SELECT group_id, COUNT(*) as wallet_count
                        FROM wallets 
                        WHERE is_active = true AND group_id IS NOT NULL
                        GROUP BY group_id
                    ) counts
                    WHERE groups.id = counts.group_id
                `);

                const duration = Date.now() - startTime;
                console.log(`[${new Date().toISOString()}] ✅ Database optimization completed in ${duration}ms`);
                console.log(`  - Cleaned up ${cleanupResult.rowCount} inactive wallets`);

            } finally {
                client.release();
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Database optimization failed:`, error);
            // Не бросаем ошибку, так как оптимизация не критична
        }
    }

    // НОВАЯ функция для проверки производительности базы данных
    async getPerformanceMetrics() {
        try {
            const query = `
                SELECT 
                    schemaname,
                    tablename,
                    n_tup_ins as inserts_count,
                    n_tup_upd as updates_count,
                    n_tup_del as deletes_count,
                    n_live_tup as live_tuples,
                    n_dead_tup as dead_tuples,
                    last_vacuum,
                    last_autovacuum,
                    last_analyze,
                    last_autoanalyze
                FROM pg_stat_user_tables 
                WHERE tablename IN ('wallets', 'groups', 'transactions', 'tokens')
                ORDER BY n_tup_ins DESC
            `;

            const result = await this.pool.query(query);
            
            // Получаем размеры таблиц
            const sizeQuery = `
                SELECT 
                    tablename,
                    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
                FROM pg_tables 
                WHERE tablename IN ('wallets', 'groups', 'transactions', 'tokens')
                ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
            `;

            const sizeResult = await this.pool.query(sizeQuery);

            return {
                tableStats: result.rows,
                tableSizes: sizeResult.rows,
                connectionPool: {
                    total: this.pool.totalCount,
                    idle: this.pool.idleCount,
                    waiting: this.pool.waitingCount
                }
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting performance metrics:`, error);
            return null;
        }
    }

    // NEW: User-specific wallet methods
    async checkWalletExistsForUser(address, userId) {
        const query = `
            SELECT id, address, name, group_id, is_active 
            FROM wallets 
            WHERE address = $1 AND user_id = $2
        `;
        
        try {
            const result = await this.pool.query(query, [address, userId]);
            return result.rows[0] || null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error checking wallet existence:`, error);
            return null;
        }
    }

    async getUsersWithWallet(address) {
        const query = `
            SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name,
                   w.name as wallet_name, w.group_id, g.name as group_name
            FROM wallets w
            JOIN users u ON w.user_id = u.id
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE w.address = $1 AND w.is_active = true
            ORDER BY w.created_at
        `;
        
        try {
            const result = await this.pool.query(query, [address]);
            return result.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting users with wallet:`, error);
            return [];
        }
    }

    async getRecentTransactionsOptimized(hours = 24, limit = 400, transactionType = null, groupId = null, userId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🚀 Optimized transactions fetch: ${hours}h, limit ${limit}, user ${userId}`);
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
            if (userId) {
                typeFilter += ` AND w.user_id = $${paramIndex++}`;
                queryParams.push(userId);
            }
    
            // Оптимизированный запрос с минимальной выборкой данных
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
                    w.user_id,
                    g.name as group_name,
                    -- Агрегированные данные токенов в одном запросе
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
                         w.group_id, w.user_id, g.name
                ORDER BY t.block_time DESC
                LIMIT $1
            `;
    
            const result = await this.pool.query(optimizedQuery, queryParams);
            const duration = Date.now() - startTime;
    
            console.log(`[${new Date().toISOString()}] ⚡ Optimized transactions fetch completed in ${duration}ms: ${result.rows.length} transactions`);
    
            // Преобразуем результат в нужный формат
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
            console.error(`[${new Date().toISOString()}] ❌ Error in optimized transactions fetch:`, error);
            throw error;
        }
    }

    async getMonitoringStatusFast(groupId = null, userId = null) {
        try {
            console.log(`[${new Date().toISOString()}] ⚡ Fast monitoring status for user ${userId}, group ${groupId}`);
            
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
            let paramIndex = 1;
            
            if (userId) {
                query += ` AND w.user_id = $${paramIndex++}`;
                params.push(userId);
            }
            
            if (groupId) {
                query += ` AND w.group_id = $${paramIndex}`;
                params.push(groupId);
            }
            
            const result = await this.pool.query(query, params);
            return result.rows[0];
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in fast monitoring status:`, error);
            throw error;
        }
    }

    async getWalletCountFast(userId, groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🚀 Fast wallet count for user ${userId}, group ${groupId}`);
            const startTime = Date.now();
    
            let query;
            let params;
    
            if (groupId) {
                // For specific group - simple count with explicit UUID casting
                query = `
                    SELECT 
                        COUNT(*) as total_wallets,
                        $2::uuid as group_id,
                        g.name as group_name,
                        COUNT(*) as wallet_count
                    FROM wallets w
                    LEFT JOIN groups g ON w.group_id = g.id
                    WHERE w.user_id = $1::uuid AND w.is_active = true AND w.group_id = $2::uuid
                    GROUP BY g.name
                `;
                params = [userId, groupId];
            } else {
                // For all groups - simplified approach without ROLLUP to avoid type conflicts
                query = `
                    WITH group_counts AS (
                        SELECT 
                            w.group_id,
                            COALESCE(g.name, 'No Group') as group_name,
                            COUNT(*) as wallet_count
                        FROM wallets w
                        LEFT JOIN groups g ON w.group_id = g.id
                        WHERE w.user_id = $1::uuid AND w.is_active = true
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
                params = [userId];
            }
    
            const result = await this.pool.query(query, params);
            const duration = Date.now() - startTime;
    
            if (groupId) {
                // For specific group
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
                // For all groups - extract data from the result
                const totalRow = result.rows.find(row => row.group_name === 'TOTAL');
                const totalWallets = totalRow ? parseInt(totalRow.total_wallets || 0) : 0;
                
                const groups = result.rows
                    .filter(row => row.group_name !== 'TOTAL')
                    .map(row => ({
                        groupId: row.group_id,
                        groupName: row.group_name,
                        walletCount: parseInt(row.wallet_count || 0)
                    }));
    
                console.log(`[${new Date().toISOString()}] ⚡ Fast wallet count completed in ${duration}ms: ${totalWallets} wallets`);
    
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

// НОВЫЙ МЕТОД: Получение только активных транзакций без детальных данных кошельков
async getRecentTransactionsOptimized(hours = 24, limit = 400, transactionType = null, groupId = null, userId = null) {
    try {
        console.log(`[${new Date().toISOString()}] 🚀 Optimized transactions fetch: ${hours}h, limit ${limit}, user ${userId}`);
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
        if (userId) {
            typeFilter += ` AND w.user_id = $${paramIndex++}`;
            queryParams.push(userId);
        }

        // Оптимизированный запрос с минимальной выборкой данных
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
                w.user_id,
                g.name as group_name,
                -- Агрегированные данные токенов в одном запросе
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
                     w.group_id, w.user_id, g.name
            ORDER BY t.block_time DESC
            LIMIT $1
        `;

        const result = await this.pool.query(optimizedQuery, queryParams);
        const duration = Date.now() - startTime;

        console.log(`[${new Date().toISOString()}] ⚡ Optimized transactions fetch completed in ${duration}ms: ${result.rows.length} transactions`);

        // Преобразуем результат в нужный формат
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
        console.error(`[${new Date().toISOString()}] ❌ Error in optimized transactions fetch:`, error);
        throw error;
    }
}

// НОВЫЙ МЕТОД: Быстрое получение статуса мониторинга без загрузки кошельков
async getMonitoringStatusFast(groupId = null, userId = null) {
    try {
        console.log(`[${new Date().toISOString()}] ⚡ Fast monitoring status for user ${userId}, group ${groupId}`);
        
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
        let paramIndex = 1;
        
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
            params.push(groupId);
        }
        
        const result = await this.pool.query(query, params);
        return result.rows[0];
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error in fast monitoring status:`, error);
        throw error;
    }
}

// ОБНОВЛЕННЫЙ МЕТОД: Оптимизированный batch insert с подсчетом
async addWalletsBatchOptimizedWithCount(wallets) {
    if (!wallets || wallets.length === 0) {
        throw new Error('Wallets array is required');
    }

    const maxBatchSize = 1000;
    if (wallets.length > maxBatchSize) {
        throw new Error(`Batch size too large. Maximum ${maxBatchSize} wallets per batch.`);
    }

    console.log(`[${new Date().toISOString()}] 🚀 Starting optimized batch insert with count tracking: ${wallets.length} wallets`);
    const startTime = Date.now();

    // Validate that all wallets have userId
    const walletsWithUser = wallets.filter(w => w.userId && w.userId.trim() !== '');
    if (walletsWithUser.length !== wallets.length) {
        throw new Error('All wallets must have a valid userId specified');
    }

    try {
        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');

            // FIXED: Properly handle UUID values and NULL validation
            const values = [];
            const placeholders = [];
            
            wallets.forEach((wallet, index) => {
                const offset = index * 4;
                placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
                
                // CRITICAL FIX: Validate and clean UUID values before insertion
                const cleanUserId = wallet.userId?.trim();
                const cleanGroupId = wallet.groupId?.trim();
                
                // Validate UUID format (basic check)
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                
                if (!cleanUserId || !uuidRegex.test(cleanUserId)) {
                    throw new Error(`Invalid userId UUID format: ${cleanUserId}`);
                }
                
                // For groupId, allow null but validate if provided
                let validGroupId = null;
                if (cleanGroupId && cleanGroupId !== 'null' && cleanGroupId !== '') {
                    if (!uuidRegex.test(cleanGroupId)) {
                        throw new Error(`Invalid groupId UUID format: ${cleanGroupId}`);
                    }
                    validGroupId = cleanGroupId;
                }
                
                values.push(
                    wallet.address?.trim(),           // address (string)
                    wallet.name?.trim() || null,     // name (string or null)
                    validGroupId,                     // group_id (UUID or null)
                    cleanUserId                       // user_id (UUID, required)
                );
            });

            // FIXED: Simple insert without explicit UUID casting - let PostgreSQL handle it
            const insertQuery = `
                INSERT INTO wallets (address, name, group_id, user_id)
                VALUES ${placeholders.join(', ')}
                ON CONFLICT (address, user_id) DO NOTHING
                RETURNING id, address, name, group_id, user_id, created_at
            `;

            console.log(`[${new Date().toISOString()}] 🗄️ Executing optimized batch insert for ${wallets.length} wallets`);
            
            const insertResult = await client.query(insertQuery, values);

            // FIXED: Simplified count queries to avoid UUID casting issues
            const userId = wallets[0].userId.trim();
            
            // Get total wallet count for user
            const totalCountQuery = `
                SELECT COUNT(*) as total_wallets
                FROM wallets 
                WHERE user_id = $1 AND is_active = true
            `;
            const totalResult = await client.query(totalCountQuery, [userId]);
            const totalWallets = parseInt(totalResult.rows[0]?.total_wallets || 0);

            // Get group counts separately to avoid ROLLUP UUID issues
            const groupCountQuery = `
                SELECT 
                    group_id,
                    COUNT(*) as group_count
                FROM wallets
                WHERE user_id = $1 AND is_active = true AND group_id IS NOT NULL
                GROUP BY group_id
            `;
            
            const groupResult = await client.query(groupCountQuery, [userId]);
            const groupCounts = groupResult.rows.map(row => ({
                groupId: row.group_id,
                count: parseInt(row.group_count || 0)
            }));

            await client.query('COMMIT');

            const insertTime = Date.now() - startTime;
            const walletsPerSecond = Math.round((insertResult.rows.length / insertTime) * 1000);
            
            console.log(`[${new Date().toISOString()}] ✅ Optimized batch with count completed: ${insertResult.rows.length} inserted in ${insertTime}ms (${walletsPerSecond} wallets/sec)`);

            return {
                insertedWallets: insertResult.rows,
                counts: {
                    totalWallets: totalWallets,
                    groupCounts: groupCounts
                }
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error(`[${new Date().toISOString()}] ❌ Transaction error:`, {
                message: error.message,
                code: error.code,
                detail: error.detail,
                hint: error.hint,
                position: error.position
            });
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Optimized batch with count failed:`, error.message);
        throw new Error(`Optimized batch insert failed: ${error.message}`);
    }
}

async getWalletsPaginated(userId, groupId = null, limit = 50, offset = 0, includeStats = false) {
    try {
        console.log(`[${new Date().toISOString()}] 📄 Paginated wallets: user ${userId}, group ${groupId}, limit ${limit}, offset ${offset}`);
        const startTime = Date.now();

        let query = `
            SELECT w.id, w.address, w.name, w.group_id, w.created_at,
                   g.name as group_name,
                   COUNT(*) OVER() as total_count
        `;

        if (includeStats) {
            query += `,
                   COALESCE(ws.total_buy_transactions, 0) as total_buy_transactions,
                   COALESCE(ws.total_sell_transactions, 0) as total_sell_transactions,
                   COALESCE(ws.total_spent_sol, 0) as total_spent_sol,
                   COALESCE(ws.total_received_sol, 0) as total_received_sol,
                   ws.last_transaction_at
            `;
        }

        query += `
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
        `;

        if (includeStats) {
            query += ` LEFT JOIN wallet_stats ws ON w.id = ws.wallet_id`;
        }

        query += ` WHERE w.is_active = TRUE AND w.user_id = $1`;
        
        const params = [userId];
        let paramIndex = 2;
        
        if (groupId) {
            query += ` AND w.group_id = ${paramIndex++}`;
            params.push(groupId);
        }
        
        query += ` ORDER BY w.created_at DESC LIMIT ${paramIndex++} OFFSET ${paramIndex}`;
        params.push(limit, offset);
        
        const result = await this.pool.query(query, params);
        const duration = Date.now() - startTime;

        console.log(`[${new Date().toISOString()}] ⚡ Paginated wallets completed in ${duration}ms: ${result.rows.length} wallets`);

        const wallets = result.rows.map(row => {
            const wallet = {
                id: row.id,
                address: row.address,
                name: row.name,
                group_id: row.group_id,
                group_name: row.group_name,
                created_at: row.created_at
            };

            if (includeStats) {
                wallet.stats = {
                    totalBuyTransactions: parseInt(row.total_buy_transactions || 0),
                    totalSellTransactions: parseInt(row.total_sell_transactions || 0),
                    totalTransactions: parseInt(row.total_buy_transactions || 0) + parseInt(row.total_sell_transactions || 0),
                    totalSpentSOL: Number(row.total_spent_sol || 0).toFixed(6),
                    totalReceivedSOL: Number(row.total_received_sol || 0).toFixed(6),
                    netSOL: (Number(row.total_received_sol || 0) - Number(row.total_spent_sol || 0)).toFixed(6),
                    lastTransactionAt: row.last_transaction_at
                };
            }

            return wallet;
        });

        return {
            wallets,
            totalCount: result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
            hasMore: result.rows.length === limit,
            limit,
            offset
        };

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error in paginated wallets:`, error);
        throw error;
    }
}

// НОВЫЙ МЕТОД: Быстрое удаление кошельков с обновлением счетчиков
async removeAllWalletsWithCount(groupId = null, userId = null) {
    try {
        console.log(`[${new Date().toISOString()}] 🗑️ Fast remove all wallets: user ${userId}, group ${groupId}`);
        const startTime = Date.now();

        const client = await this.pool.connect();
        
        try {
            await client.query('BEGIN');

            // Удаляем кошельки
            let deleteQuery = `DELETE FROM wallets WHERE 1=1`;
            const deleteParams = [];
            let paramIndex = 1;
            
            if (userId) {
                deleteQuery += ` AND user_id = ${paramIndex++}`;
                deleteParams.push(userId);
            }
            
            if (groupId) {
                deleteQuery += ` AND group_id = ${paramIndex}`;
                deleteParams.push(groupId);
            }
            
            const deleteResult = await client.query(deleteQuery, deleteParams);

            // Быстро получаем новые счетчики
            let countQuery = `
                SELECT 
                    COUNT(*) as total_wallets,
                    group_id,
                    COUNT(*) as group_wallets
                FROM wallets 
                WHERE is_active = true
            `;
            const countParams = [];
            let countParamIndex = 1;

            if (userId) {
                countQuery += ` AND user_id = ${countParamIndex++}`;
                countParams.push(userId);
            }

            countQuery += ` GROUP BY ROLLUP(group_id) ORDER BY group_id NULLS FIRST`;
            
            const countResult = await client.query(countQuery, countParams);

            await client.query('COMMIT');

            const duration = Date.now() - startTime;
            console.log(`[${new Date().toISOString()}] ✅ Fast remove completed in ${duration}ms: ${deleteResult.rowCount} wallets removed`);

            return {
                deletedCount: deleteResult.rowCount,
                newCounts: {
                    totalWallets: countResult.rows[0]?.total_wallets || 0,
                    groupCounts: countResult.rows.slice(1).map(row => ({
                        groupId: row.group_id,
                        count: parseInt(row.group_wallets || 0)
                    }))
                }
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error in fast remove all wallets:`, error);
        throw new Error(`Failed to remove wallets: ${error.message}`);
    }
}

// НОВЫЙ МЕТОД: Быстрая валидация кошельков без вставки
async validateWalletsBatch(addresses, userId) {
    try {
        console.log(`[${new Date().toISOString()}] ⚡ Fast wallet validation: ${addresses.length} addresses for user ${userId}`);
        const startTime = Date.now();

        if (addresses.length === 0) return { valid: [], duplicates: [], invalid: [] };

        // CRITICAL FIX: Validate userId before using in query
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const cleanUserId = userId?.trim();
        
        if (!cleanUserId || !uuidRegex.test(cleanUserId)) {
            throw new Error(`Invalid userId UUID format: ${cleanUserId}`);
        }

        // Fast check for existing wallets with proper UUID handling
        const query = `
            SELECT address 
            FROM wallets 
            WHERE address = ANY($1) AND user_id = $2 AND is_active = true
        `;
        
        const result = await this.pool.query(query, [addresses, cleanUserId]);
        const existingAddresses = new Set(result.rows.map(row => row.address));

        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ⚡ Wallet validation completed in ${duration}ms: ${existingAddresses.size} duplicates found`);

        // Separate into categories with improved validation
        const valid = [];
        const duplicates = [];
        const invalid = [];

        const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]+$/;

        addresses.forEach(address => {
            const cleanAddress = address?.trim();
            
            // Enhanced Solana address validation
            if (!cleanAddress || 
                cleanAddress.length < 32 || 
                cleanAddress.length > 44 || 
                !solanaAddressRegex.test(cleanAddress)) {
                invalid.push(address);
            } else if (existingAddresses.has(cleanAddress)) {
                duplicates.push(cleanAddress);
            } else {
                valid.push(cleanAddress);
            }
        });

        return {
            valid,
            duplicates,
            invalid,
            summary: {
                total: addresses.length,
                validCount: valid.length,
                duplicateCount: duplicates.length,
                invalidCount: invalid.length
            }
        };

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error in wallet validation:`, error);
        throw error;
    }
}

    async getWalletsByAddress(address) {
        const query = `
            SELECT w.*, u.username, u.first_name, g.name as group_name
            FROM wallets w
            JOIN users u ON w.user_id = u.id
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE w.address = $1
            ORDER BY w.created_at
        `;
        
        try {
            const result = await this.pool.query(query, [address]);
            return result.rows;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting wallets by address:`, error);
            return [];
        }
    }

    async getWalletByAddressAndUser(address, userId) {
        const query = `
            SELECT w.*, g.name as group_name
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE w.address = $1 AND w.user_id = $2
        `;
        
        try {
            const result = await this.pool.query(query, [address, userId]);
            return result.rows[0] || null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting wallet by address and user:`, error);
            return null;
        }
    }

    // Backward compatibility method
    async getWalletByAddress(address) {
        const query = `SELECT * FROM wallets WHERE address = $1 LIMIT 1`;
        const result = await this.pool.query(query, [address]);
        return result.rows[0];
    }

    // UPDATED: Transaction methods with user context
    async getRecentTransactions(hours = 24, limit = 400, transactionType = null, groupId = null, userId = null) {
        try {
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
            if (userId) {
                typeFilter += ` AND w.user_id = $${paramIndex++}`;
                queryParams.push(userId);
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
                    w.user_id,
                    g.name as group_name
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
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
                    w.group_id,
                    w.user_id,
                    g.name as group_name,
                    tk.mint,
                    tk.symbol,
                    tk.name as token_name,
                    to_.amount as token_amount,
                    to_.operation_type,
                    tk.decimals
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                LEFT JOIN tokens tk ON to_.token_id = tk.id
                WHERE t.signature IN (${placeholders})
                ORDER BY t.block_time DESC, t.signature, to_.id
            `;

            const result = await this.pool.query(fullDataQuery, signatures);
            
            console.log(`📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens${userId ? ` for user ${userId}` : ''}`);
            
            return result.rows;

        } catch (error) {
            console.error('❌ Error in getRecentTransactions:', error);
            throw error;
        }
    }

    // UPDATED: Monitoring stats with user context
    async getMonitoringStats(groupId = null, userId = null) {
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
        const params = [];
        let paramIndex = 1;
        
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
            params.push(groupId);
        }
        
        const result = await this.pool.query(query, params);
        return result.rows[0];
    }

    // UPDATED: Token aggregates with user context
    async getTokenWalletAggregates(hours = 24, groupId = null, userId = null) {
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
                w.user_id,
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
            JOIN wallets w ON t.wallet_id = w.id
            LEFT JOIN groups g ON w.group_id = g.id
            WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
            AND tk.mint NOT IN (${EXCLUDED_TOKENS.map((_, i) => `$${i + 1}`).join(', ')})
        `;
        
        const params = [...EXCLUDED_TOKENS];
        let paramIndex = EXCLUDED_TOKENS.length + 1;
        
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
            params.push(groupId);
        }
        
        query += `
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name, tk.decimals, w.id, w.address, w.name, w.group_id, w.user_id, g.name
            ORDER BY last_activity DESC, tk.mint, w.address
        `;
        
        const result = await this.pool.query(query, params);
    
        console.log(`[${new Date().toISOString()}] 📊 Token aggregates query returned ${result.rows.length} rows (excluded ${EXCLUDED_TOKENS.length} tokens)${userId ? ` for user ${userId}` : ''}`);
    
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
                user_id: row.user_id,
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

    // UPDATED: Top tokens with user context
    async getTopTokens(limit = 10, operationType = null, groupId = null, userId = null) {
        let typeFilter = '';
        let queryParams = [limit];
        let paramIndex = 2;
        
        if (operationType) {
            typeFilter = `AND to_.operation_type = $${paramIndex++}`;
            queryParams.push(operationType);
        }
        
        if (userId) {
            typeFilter += ` AND w.user_id = $${paramIndex++}`;
            queryParams.push(userId);
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
            ${typeFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    // UPDATED: Token operations with user context
    async getTokenInflowSeries(mint, hours = 24, groupId = null, userId = null) {
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
        let paramIndex = 2;
        
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
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

    async getTokenOperations(mint, hours = 24, groupId = null, userId = null) {
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
                w.user_id,
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
        let paramIndex = 2;
        
        if (userId) {
            query += ` AND w.user_id = $${paramIndex++}`;
            params.push(userId);
        }
        
        if (groupId) {
            query += ` AND w.group_id = $${paramIndex}`;
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
                group_name: r.group_name,
                user_id: r.user_id
            }
        }));
    }

    // Existing methods that don't need user context (keeping as is)
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