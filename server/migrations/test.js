// server/src/scripts/hotfixDatabase.js
const Database = require('../src/database/connection');
require('dotenv').config();

async function hotfixDatabase() {
    console.log('🔧 Running hotfix for database NOT NULL constraints...');
    
    try {
        const db = new Database();
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // 1. Обновляем схему таблицы transactions для использования DEFAULT 0
            console.log('📝 Updating transactions table constraints...');
            
            const alterCommands = [
                'ALTER TABLE transactions ALTER COLUMN sol_spent SET DEFAULT 0',
                'ALTER TABLE transactions ALTER COLUMN sol_received SET DEFAULT 0', 
                'ALTER TABLE transactions ALTER COLUMN usd_spent SET DEFAULT 0',
                'ALTER TABLE transactions ALTER COLUMN usd_received SET DEFAULT 0'
            ];
            
            for (const command of alterCommands) {
                try {
                    await client.query(command);
                    console.log(`✅ Executed: ${command}`);
                } catch (err) {
                    console.warn(`⚠️ Warning: ${err.message}`);
                }
            }
            
            // 2. Обновляем существующие записи с NULL значениями
            console.log('📝 Updating existing NULL values...');
            
            const updateCommands = [
                'UPDATE transactions SET sol_spent = 0 WHERE sol_spent IS NULL',
                'UPDATE transactions SET sol_received = 0 WHERE sol_received IS NULL',
                'UPDATE transactions SET usd_spent = 0 WHERE usd_spent IS NULL', 
                'UPDATE transactions SET usd_received = 0 WHERE usd_received IS NULL'
            ];
            
            for (const command of updateCommands) {
                try {
                    const result = await client.query(command);
                    console.log(`✅ ${command} - Updated ${result.rowCount} rows`);
                } catch (err) {
                    console.warn(`⚠️ Warning: ${err.message}`);
                }
            }
            
            // 3. Делаем колонки NOT NULL после установки дефолтов
            console.log('📝 Setting NOT NULL constraints...');
            
            const notNullCommands = [
                'ALTER TABLE transactions ALTER COLUMN sol_spent SET NOT NULL',
                'ALTER TABLE transactions ALTER COLUMN sol_received SET NOT NULL',
                'ALTER TABLE transactions ALTER COLUMN usd_spent SET NOT NULL',
                'ALTER TABLE transactions ALTER COLUMN usd_received SET NOT NULL'
            ];
            
            for (const command of notNullCommands) {
                try {
                    await client.query(command);
                    console.log(`✅ ${command}`);
                } catch (err) {
                    console.warn(`⚠️ Warning: ${err.message}`);
                }
            }
            
            await client.query('COMMIT');
            console.log('✅ Hotfix completed successfully!');
            
            // Показываем статистику
            const statsQuery = `
                SELECT 
                    COUNT(*) as total_transactions,
                    COUNT(CASE WHEN transaction_type = 'buy' THEN 1 END) as buy_count,
                    COUNT(CASE WHEN transaction_type = 'sell' THEN 1 END) as sell_count,
                    AVG(sol_spent) as avg_sol_spent,
                    AVG(sol_received) as avg_sol_received
                FROM transactions
            `;
            
            const stats = await client.query(statsQuery);
            const row = stats.rows[0];
            
            console.log('\n📊 Current Statistics:');
            console.log(`Total Transactions: ${row.total_transactions}`);
            console.log(`Buy Transactions: ${row.buy_count}`);
            console.log(`Sell Transactions: ${row.sell_count}`);
            console.log(`Avg SOL Spent: ${Number(row.avg_sol_spent || 0).toFixed(6)}`);
            console.log(`Avg SOL Received: ${Number(row.avg_sol_received || 0).toFixed(6)}`);
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
        await db.close();
        
    } catch (error) {
        console.error('❌ Hotfix failed:', error.message);
        process.exit(1);
    }
}

// Запускаем если файл вызван напрямую
if (require.main === module) {
    hotfixDatabase();
}

module.exports = hotfixDatabase;