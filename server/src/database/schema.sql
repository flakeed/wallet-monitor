-- Updated schema for shared system (remove user isolation)

SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET shared_buffers = '512MB';
SET autocommit = off;

-- Users table remains but only for authentication
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Sessions table remains the same
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Whitelist remains the same
CREATE TABLE IF NOT EXISTS whitelist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    added_by UUID REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- UPDATED: Groups table - remove user_id, make global
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,  -- Global unique names
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Track who created it
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- UPDATED: Wallets table - remove user_id, make global
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address VARCHAR(44) UNIQUE NOT NULL,  -- Global unique addresses
    name VARCHAR(255),
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    added_by UUID REFERENCES users(id) ON DELETE SET NULL,  -- Track who added it
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Transactions table remains mostly the same
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE,
    signature VARCHAR(88) UNIQUE NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
    sol_spent NUMERIC(20,9) DEFAULT 0,
    sol_received NUMERIC(20,9) DEFAULT 0,
    usdc_spent NUMERIC(20,9) DEFAULT 0,
    usdc_received NUMERIC(20,9) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tokens table remains the same
CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(50),
    name VARCHAR(255),
    decimals INTEGER DEFAULT 9,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Token operations table remains the same
CREATE TABLE IF NOT EXISTS token_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    token_id UUID REFERENCES tokens(id) ON DELETE CASCADE,
    amount NUMERIC(20,9) NOT NULL,
    operation_type VARCHAR(20) NOT NULL CHECK (operation_type IN ('buy', 'sell')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Wallet stats table remains mostly the same
CREATE TABLE IF NOT EXISTS wallet_stats (
    wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
    total_spent_sol NUMERIC(20,9) DEFAULT 0,
    total_received_sol NUMERIC(20,9) DEFAULT 0,
    total_buy_transactions BIGINT DEFAULT 0,
    total_sell_transactions BIGINT DEFAULT 0,
    unique_tokens_bought BIGINT DEFAULT 0,
    unique_tokens_sold BIGINT DEFAULT 0,
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Monitoring stats table remains the same
CREATE TABLE IF NOT EXISTS monitoring_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processed_signatures BIGINT DEFAULT 0,
    total_wallets_monitored BIGINT DEFAULT 0,
    last_scan_duration BIGINT DEFAULT 0,
    errors_count BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Updated indexes for global access
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_group_id ON wallets(group_id);
CREATE INDEX IF NOT EXISTS idx_wallets_added_by ON wallets(added_by);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time);
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction_id ON token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_id ON token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_whitelist_telegram_id ON whitelist(telegram_id);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

-- Migration script to remove user-specific constraints
DO $$ 
BEGIN
    -- Drop old constraints if they exist
    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS unique_wallet_address_per_user;
    ALTER TABLE groups DROP CONSTRAINT IF EXISTS unique_group_name_per_user;
    
    -- Remove user_id columns if they still exist
    ALTER TABLE wallets DROP COLUMN IF EXISTS user_id;
    ALTER TABLE groups DROP COLUMN IF EXISTS user_id;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Migration constraint or column may not exist: %', SQLERRM;
END $$;

-- Insert default admin user
INSERT INTO users (telegram_id, username, first_name, is_admin, is_active)
VALUES (789676557, 'admin', 'Admin', true, true)
ON CONFLICT (telegram_id) DO UPDATE SET
    is_admin = true,
    is_active = true;

-- Insert into whitelist
INSERT INTO whitelist (telegram_id, notes)
VALUES (789676557, 'Initial admin user')
ON CONFLICT (telegram_id) DO NOTHING;