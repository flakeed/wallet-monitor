const Database = require('../database/connection');
require('dotenv').config();

async function initDatabase() {
    console.log('🗄️ Initializing PostgreSQL database...');
    
    try {
        const db = new Database();
        
        const health = await db.healthCheck();
        console.log('📊 Database health:', health);
        
        if (health.status === 'healthy') {
            console.log('✅ Database initialized successfully!');
            console.log(`📍 Connected to: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
            
            if (process.argv.includes('--add-test-wallets')) {
                await addTestWallets(db);
            }

            if (process.argv.includes('--show-stats')) {
                await showStats(db);
            }
        } else {
            throw new Error(`Database unhealthy: ${health.error}`);
        }
        
        await db.close();
        
    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.error('💡 Make sure PostgreSQL is running and accessible');
            console.error('💡 Check your connection settings in .env file');
        } else if (error.code === '3D000') {
            console.error('💡 Database does not exist. Create it first:');
            console.error(`   createdb ${process.env.DB_NAME}`);
        } else if (error.code === '28P01') {
            console.error('💡 Authentication failed. Check DB_USER and DB_PASSWORD');
        }
        
        process.exit(1);
    }
}

async function addTestWallets(db) {
    const testWallets = [
        {
            address: '9yuiiicyZ2McJkFz7v7GvPPPXX92RX4jXDSdvhF5BkVd',
            name: 'Test Wallet 1'
        },
        {
            address: '53nHsQXkzZUp5MF1BK6Qoa48ud3aXfDFJBbe1oECPucC',
            name: 'Test Wallet 2'
        },
        {
            address: 'Cupjy3x8wfwCcLMkv5SqPtRjsJd5Zk8q7X2NGNGJGi5y',
            name: 'Test Wallet 3'
        }
    ];

    console.log('🧪 Adding test wallets...');
    
    for (const wallet of testWallets) {
        try {
            await db.addWallet(wallet.address, wallet.name);
            console.log(`✅ Added: ${wallet.name} (${wallet.address.slice(0, 8)}...)`);
        } catch (err) {
            if (err.message.includes('already exists')) {
                console.log(`ℹ️ Already exists: ${wallet.name}`);
            } else {
                console.error(`❌ Error adding ${wallet.name}:`, err.message);
            }
        }
    }
}

async function showStats(db) {
    console.log('\n📈 Current Database Statistics:');
    
    try {
        const stats = await db.getMonitoringStats();
        const wallets = await db.getActiveWallets();
        
        console.log(`👛 Active Wallets: ${stats.active_wallets}`);
        console.log(`📊 Transactions Today: ${stats.transactions_today}`);
        console.log(`💰 SOL Spent Today: ${Number(stats.sol_spent_today).toFixed(6)}`);
        console.log(`💵 USD Spent Today: $${Number(stats.usd_spent_today).toFixed(2)}`);
        console.log(`🪙 Unique Tokens Today: ${stats.unique_tokens_today}`);
        
        if (wallets.length > 0) {
            console.log('\n👛 Monitored Wallets:');
            wallets.forEach(wallet => {
                console.log(`  • ${wallet.name || 'Unnamed'} (${wallet.address.slice(0, 8)}...) - ${wallet.total_transactions} txs`);
            });
        }
        
    } catch (error) {
        console.error('❌ Error fetching stats:', error.message);
    }
}

if (require.main === module) {
    initDatabase();
}

module.exports = initDatabase;