-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Creating groups table to store wallet groups
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating wallets table to store monitored wallet addresses
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(44) NOT NULL UNIQUE,
    name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating tokens table to store token metadata
CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    mint VARCHAR(44) NOT NULL UNIQUE,
    symbol VARCHAR(20),
    name VARCHAR(100),
    decimals INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating transactions table to store transaction data
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    signature VARCHAR(88) NOT NULL UNIQUE,
    block_time TIMESTAMP NOT NULL,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
    sol_spent DECIMAL(20,9) DEFAULT 0,
    sol_received DECIMAL(20,9) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating token_operations table to store token transaction details
CREATE TABLE IF NOT EXISTS token_operations (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    amount DECIMAL(20,9) NOT NULL,
    operation_type VARCHAR(20) NOT NULL CHECK (operation_type IN ('buy', 'sell')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating wallet_stats table to store aggregated wallet statistics
CREATE TABLE IF NOT EXISTS wallet_stats (
    wallet_id UUID PRIMARY KEY REFERENCES wallets(id) ON DELETE CASCADE,
    total_spent_sol DECIMAL(20,9) DEFAULT 0,
    total_received_sol DECIMAL(20,9) DEFAULT 0,
    total_buy_transactions INTEGER DEFAULT 0,
    total_sell_transactions INTEGER DEFAULT 0,
    unique_tokens_bought INTEGER DEFAULT 0,
    unique_tokens_sold INTEGER DEFAULT 0,
    last_transaction_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating monitoring_stats table to store monitoring service statistics
CREATE TABLE IF NOT EXISTS monitoring_stats (
    id SERIAL PRIMARY KEY,
    processed_signatures INTEGER NOT NULL,
    total_wallets_monitored INTEGER NOT NULL,
    last_scan_duration INTEGER NOT NULL,
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Creating wallet_stats_view for aggregated wallet statistics
CREATE OR REPLACE VIEW wallet_stats_view AS
SELECT 
    w.id as wallet_id,
    w.address,
    w.name as wallet_name,
    w.group_id,
    g.name as group_name,
    COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as total_buy_transactions,
    COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as total_sell_transactions,
    COALESCE(SUM(t.sol_spent), 0) as total_sol_spent,
    COALESCE(SUM(t.sol_received), 0) as total_sol_received,
    MAX(t.block_time) as last_transaction_at,
    COUNT(DISTINCT CASE WHEN to_.operation_type = 'buy' THEN to_.token_id END) as unique_tokens_bought,
    COUNT(DISTINCT CASE WHEN to_.operation_type = 'sell' THEN to_.token_id END) as unique_tokens_sold
FROM wallets w
LEFT JOIN groups g ON w.group_id = g.id
LEFT JOIN transactions t ON w.id = t.wallet_id
LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
GROUP BY w.id, w.address, w.name, w.group_id, g.name;

-- Creating indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_wallets_group_id ON wallets(group_id);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_is_active ON wallets(is_active);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint);
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction_id ON token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_id ON token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

-- Adding triggers to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_groups_updated_at
    BEFORE UPDATE ON groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tokens_updated_at
    BEFORE UPDATE ON tokens
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();