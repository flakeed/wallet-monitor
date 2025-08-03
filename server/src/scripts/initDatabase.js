const Database = require('./connection');
require('dotenv').config();

async function initDatabase() {
    console.log(`[${new Date().toISOString()}] 🗄️ Initializing PostgreSQL database...`);
    
    try {
        const db = new Database();
        
        const health = await db.healthCheck();
        console.log(`[${new Date().toISOString()}] 📊 Database health:`, health);
        
        if (health.status === 'healthy') {
            console.log(`[${new Date().toISOString()}] ✅ Database initialized successfully!`);
            console.log(`[${new Date().toISOString()}] 📍 Connected to: ${process.env.DATABASE_URL}`);
            
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
        console.error(`[${new Date().toISOString()}] ❌ Error initializing database:`, error.message);
        
        if (error.code === 'ECONNREFUSED') {
            console.error(`[${new Date().toISOString()}] 💡 Make sure PostgreSQL is running and accessible`);
            console.error(`[${new Date().toISOString()}] 💡 Check your connection settings in .env file`);
        } else if (error.code === '3D000') {
            console.error(`[${new Date().toISOString()}] 💡 Database does not exist. Create it first:`);
            console.error(`[${new Date().toISOString()}]    createdb ${process.env.DB_NAME}`);
        } else if (error.code === '28P01') {
            console.error(`[${new Date().toISOString()}] 💡 Authentication failed. Check DB_USER and DB_PASSWORD`);
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

    console.log(`[${new Date().toISOString()}] 🧪 Adding test wallets...`);
    
    for (const wallet of testWallets) {
        try {
            await db.addWallet(wallet.address, wallet.name);
            console.log(`[${new Date().toISOString()}] ✅ Added: ${wallet.name} (${wallet.address.slice(0, 8)}...)`);
        } catch (err) {
            if (err.message.includes('already exists')) {
                console.log(`[${new Date().toISOString()}] ℹ️ Already exists: ${wallet.name}`);
            } else {
                console.error(`[${new Date().toISOString()}] ❌ Error adding ${wallet.name}:`, err.message);
            }
        }
    }
}

async function showStats(db) {
    console.log(`[${new Date().toISOString()}] \n📈 Current Database Statistics:`);
    
    try {
        const stats = await db.getMonitoringStats();
        const wallets = await db.getActiveWallets();
        
        console.log(`[${new Date().toISOString()}] 👛 Active Wallets: ${stats.active_wallets}`);
        console.log(`[${new Date().toISOString()}] 📊 Buy Transactions Today: ${stats.buy_transactions_today}`);
        console.log(`[${new Date().toISOString()}] 📊 Sell Transactions Today: ${stats.sell_transactions_today}`);
        console.log(`[${new Date().toISOString()}] 💰 SOL Spent Today: ${Number(stats.sol_spent_today).toFixed(6)}`);
        console.log(`[${new Date().toISOString()}] 💰 SOL Received Today: ${Number(stats.sol_received_today).toFixed(6)}`);
        console.log(`[${new Date().toISOString()}] 💵 USD Spent Today: $${Number(stats.usd_spent_today).toFixed(2)}`);
        console.log(`[${new Date().toISOString()}] 💵 USD Received Today: $${Number(stats.usd_received_today).toFixed(2)}`);
        console.log(`[${new Date().toISOString()}] 🪙 Unique Tokens Today: ${stats.unique_tokens_today}`);
        
        if (wallets.length > 0) {
            console.log(`[${new Date().toISOString()}] \n👛 Monitored Wallets:`);
            wallets.forEach(wallet => {
                console.log(`[${new Date().toISOString()}]   • ${wallet.name || 'Unnamed'} (${wallet.address.slice(0, 8)}...)`);
            });
        }
        
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error fetching stats:`, error.message);
    }
}

if (require.main === module) {
    initDatabase();
}

module.exports = initDatabase;