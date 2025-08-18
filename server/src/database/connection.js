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
            SELECT g.id, g.name, COUNT(w.id) as wallet_count
            FROM groups g
            LEFT JOIN wallets w ON g.id = w.group_id
            GROUP BY g.id, g.name
            ORDER BY g.created_at
        `;
        const result = await this.pool.query(query);
        return result.rows;
    }

    async addWallet(address, name = null, groupId = null) {
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

    async addWalletsBatch(wallets) {
        const query = `
          INSERT INTO wallets (address, name, group_id) 
          VALUES ${wallets.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ')}
          ON CONFLICT (address) DO NOTHING
          RETURNING id, address, name, group_id, created_at
        `;
        
        const values = [];
        wallets.forEach(wallet => {
          values.push(wallet.address, wallet.name, wallet.groupId);
        });
      
        try {
          const result = await this.pool.query(query, values);
          return result.rows;
        } catch (error) {
          throw new Error(`Batch insert failed: ${error.message}`);
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

    async removeAllWallets(groupId = null) {
        let query = `DELETE FROM wallets`;
        const params = [];
        if (groupId) {
            query += ` WHERE group_id = $1`;
            params.push(groupId);
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
            SELECT w.*, g.name as group_name
            FROM wallets w
            LEFT JOIN groups g ON w.group_id = g.id
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
            let queryParams = [limit];
            let paramIndex = 2;
            
            if (transactionType) {
                typeFilter = `AND t.transaction_type = $${paramIndex++}`;
                queryParams.push(transactionType);
            }
            if (groupId) {
                typeFilter += ` AND w.group_id = $${paramIndex}`;
                queryParams.push(groupId);
            }
    
            const uniqueTransactionsQuery = `
                SELECT 
                    t.signature,
                    t.block_time,
                    t.transaction_type,
                    t.sol_spent,
                    t.sol_received,
                    t.original_usdc_amount,
                    t.usdc_to_sol_rate,
                    t.sol_price_usd,
                    w.address as wallet_address,
                    w.name as wallet_name,
                    w.group_id,
                    g.name as group_name
                FROM transactions t
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
                WHERE t.block_time >= NOW() - INTERVAL '${hours} hours'
                AND w.is_active = true
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
                    t.original_usdc_amount,
                    t.usdc_to_sol_rate,
                    t.sol_price_usd,
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
                JOIN wallets w ON t.wallet_id = w.id
                LEFT JOIN groups g ON w.group_id = g.id
                LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
                LEFT JOIN tokens tk ON to_.token_id = tk.id
                WHERE t.signature IN (${placeholders})
                AND w.is_active = true
                ORDER BY t.block_time DESC, t.signature, to_.id
            `;
    
            const result = await this.pool.query(fullDataQuery, signatures);
            
            console.log(`📊 getRecentTransactions: Found ${uniqueTransactions.rows.length} unique transactions, ${result.rows.length} total rows with tokens`);
            
            // Логируем информацию о USDC конвертации
            const usdcTransactions = result.rows.filter(row => row.original_usdc_amount > 0);
            if (usdcTransactions.length > 0) {
                console.log(`💱 Found ${usdcTransactions.length} rows with USDC conversion data`);
                
                // Группируем по signature для подсчёта уникальных транзакций с USDC
                const uniqueUsdcTxs = new Set(usdcTransactions.map(row => row.signature));
                console.log(`💱 ${uniqueUsdcTxs.size} unique transactions involved USDC conversion`);
                
                // Примеры конвертации для отладки
                const examples = Array.from(uniqueUsdcTxs).slice(0, 3);
                for (const sig of examples) {
                    const tx = usdcTransactions.find(row => row.signature === sig);
                    const convertedSol = tx.transaction_type === 'buy' ? tx.sol_spent : tx.sol_received;
                    console.log(`  - ${sig.slice(0, 8)}...: ${tx.original_usdc_amount} USDC → ${convertedSol} SOL (rate: ${tx.usdc_to_sol_rate})`);
                }
            }
            
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
            ${typeFilter}
            GROUP BY tk.id, tk.mint, tk.symbol, tk.name
            ORDER BY (buy_count + sell_count) DESC
            LIMIT $1
        `;
        const result = await this.pool.query(query, queryParams);
        return result.rows;
    }

    async getTokenWalletAggregates(hours, groupId) {
        const query = `
          SELECT
            tk.mint as token_mint,
            tk.symbol,
            tk.name,
            tk.decimals,
            w.address as wallet_address,
            w.name as wallet_name,
            w.group_id,
            g.name as group_name,
            COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as tx_buys,
            COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as tx_sells,
            -- Суммируем SOL (уже включая конвертированный USDC)
            COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN t.sol_spent ELSE 0 END), 0) as sol_spent,
            COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN t.sol_received ELSE 0 END), 0) as sol_received,
            COALESCE(SUM(CASE WHEN to_.operation_type = 'buy' THEN to_.amount ELSE 0 END), 0) as tokens_bought,
            COALESCE(SUM(CASE WHEN to_.operation_type = 'sell' THEN to_.amount ELSE 0 END), 0) as tokens_sold,
            -- Информация о USDC конвертации для отладки
            COALESCE(SUM(CASE WHEN t.original_usdc_amount > 0 THEN t.original_usdc_amount ELSE 0 END), 0) as total_usdc_used,
            AVG(CASE WHEN t.usdc_to_sol_rate > 0 THEN t.usdc_to_sol_rate ELSE NULL END) as avg_usdc_rate,
            MAX(t.block_time) as last_activity
          FROM token_operations to_
          JOIN transactions t ON to_.transaction_id = t.id
          JOIN tokens tk ON to_.token_id = tk.id
          JOIN wallets w ON t.wallet_id = w.id
          LEFT JOIN groups g ON w.group_id = g.id
          WHERE t.block_time >= NOW() - INTERVAL '1 hour' * $1
            AND ($2::text IS NULL OR w.group_id = $2::uuid)
            AND w.is_active = true
          GROUP BY tk.mint, tk.symbol, tk.name, tk.decimals, w.address, w.name, w.group_id, g.name
          ORDER BY tk.mint, w.address;
        `;
        
        try {
            const result = await this.pool.query(query, [hours, groupId]);
            
            console.log(`[${new Date().toISOString()}] 📊 getTokenWalletAggregates: Found ${result.rows.length} wallet-token combinations`);
    
            const byToken = new Map();
            for (const row of result.rows) {
                if (!byToken.has(row.token_mint)) {
                    byToken.set(row.token_mint, {
                        mint: row.token_mint,
                        symbol: row.symbol,
                        name: row.name,
                        decimals: row.decimals,
                        wallets: [],
                        summary: {
                            uniqueWallets: 0,
                            totalBuys: 0,
                            totalSells: 0,
                            totalSpentSOL: 0,
                            totalReceivedSOL: 0,
                            totalUsdcUsed: 0, // Общее количество USDC, использованного для транзакций
                        },
                    });
                }
    
                const token = byToken.get(row.token_mint);
                const solSpent = Number(row.sol_spent) || 0;
                const solReceived = Number(row.sol_received) || 0;
                const pnlSol = solReceived - solSpent;
                
                token.wallets.push({
                    address: row.wallet_address,
                    name: row.wallet_name,
                    groupId: row.group_id,
                    groupName: row.group_name,
                    txBuys: Number(row.tx_buys) || 0,
                    txSells: Number(row.tx_sells) || 0,
                    solSpent: solSpent,
                    solReceived: solReceived,
                    tokensBought: Number(row.tokens_bought) || 0,
                    tokensSold: Number(row.tokens_sold) || 0,
                    pnlSol: +pnlSol.toFixed(6), // PnL уже в SOL, включая конвертированный USDC
                    usdcUsed: Number(row.total_usdc_used) || 0, // Для информации
                    avgUsdcRate: Number(row.avg_usdc_rate) || 0, // Для информации
                    lastActivity: row.last_activity,
                });
                
                token.summary.uniqueWallets += 1;
                token.summary.totalBuys += Number(row.tx_buys) || 0;
                token.summary.totalSells += Number(row.tx_sells) || 0;
                token.summary.totalSpentSOL += solSpent;
                token.summary.totalReceivedSOL += solReceived;
                token.summary.totalUsdcUsed += Number(row.total_usdc_used) || 0;
            }
    
            const result_array = Array.from(byToken.values()).map((token) => ({
                ...token,
                summary: {
                    ...token.summary,
                    netSOL: +(token.summary.totalReceivedSOL - token.summary.totalSpentSOL).toFixed(6),
                },
            }));
    
            // Сортируем по абсолютному значению PnL (наибольший PnL/убыток сверху)
            result_array.sort((a, b) => Math.abs(b.summary.netSOL) - Math.abs(a.summary.netSOL));
            
            console.log(`[${new Date().toISOString()}] 📈 Returning ${result_array.length} tokens with aggregated data (USDC converted to SOL)`);
            
            // Логируем примеры конвертации USDC для отладки
            const usdcTokens = result_array.filter(t => t.summary.totalUsdcUsed > 0);
            if (usdcTokens.length > 0) {
                console.log(`[${new Date().toISOString()}] 💱 Found ${usdcTokens.length} tokens with USDC transactions:`);
                usdcTokens.slice(0, 3).forEach(token => {
                    console.log(`  - ${token.symbol}: ${token.summary.totalUsdcUsed.toFixed(2)} USDC converted to SOL`);
                });
            }
            
            return result_array;
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in getTokenWalletAggregates:`, error);
            throw error;
        }
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
        const params = [];
        if (groupId) {
            query += ` AND w.group_id = $1`;
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
            query += ` AND w.group_id = $2`;
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
            query += ` AND w.group_id = $2`;
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