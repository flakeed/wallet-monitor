CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
    id SERIAL PRIMARY KEY,
    address VARCHAR(44) NOT NULL UNIQUE,
    name VARCHAR(100),
    group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tokens (
    id SERIAL PRIMARY KEY,
    mint VARCHAR(44) NOT NULL UNIQUE,
    symbol VARCHAR(20),
    name VARCHAR(100),
    decimals INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    signature VARCHAR(88) NOT NULL UNIQUE,
    block_time TIMESTAMP NOT NULL,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
    sol_spent NUMERIC(20, 9) DEFAULT 0,
    sol_received NUMERIC(20, 9) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_operations (
    id SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    amount NUMERIC(20, 9) NOT NULL,
    operation_type VARCHAR(20) NOT NULL CHECK (operation_type IN ('buy', 'sell')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_group_id ON wallets(group_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time);
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction_id ON token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_id ON token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint);