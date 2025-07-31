-- PostgreSQL Schema for WalletPulse with Sales Support (Updated)

-- Enable UUID extension for better IDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Transactions table (supports both buy and sell)
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL,
    signature VARCHAR(88) UNIQUE NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    sol_spent DECIMAL(20, 9) DEFAULT 0, -- для покупок, может быть 0 для продаж
    sol_received DECIMAL(20, 9) DEFAULT 0, -- для продаж, может быть 0 для покупок
    usd_spent DECIMAL(15, 2) DEFAULT 0, -- для покупок, может быть 0 для продаж  
    usd_received DECIMAL(15, 2) DEFAULT 0, -- для продаж, может быть 0 для покупок
    transaction_type VARCHAR(20) DEFAULT 'buy', -- 'buy' или 'sell'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE
);

-- Tokens table
CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(20),
    name VARCHAR(255),
    logo_uri TEXT,
    decimals INTEGER DEFAULT 0,
    market_cap DECIMAL(20, 2),
    price_usd DECIMAL(20, 8),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Token operations table (покупки и продажи)
CREATE TABLE IF NOT EXISTS token_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL,
    token_id UUID NOT NULL,
    amount DECIMAL(30, 18) NOT NULL, -- положительное для покупок, отрицательное для продаж
    operation_type VARCHAR(10) NOT NULL, -- 'buy' или 'sell'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES tokens (id) ON DELETE CASCADE
);

-- Wallet statistics table (обновлена для поддержки продаж)
CREATE TABLE IF NOT EXISTS wallet_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID UNIQUE NOT NULL,
    total_spent_sol DECIMAL(20, 9) DEFAULT 0,
    total_received_sol DECIMAL(20, 9) DEFAULT 0,
    total_spent_usd DECIMAL(20, 2) DEFAULT 0,
    total_received_usd DECIMAL(20, 2) DEFAULT 0,
    total_buy_transactions INTEGER DEFAULT 0,
    total_sell_transactions INTEGER DEFAULT 0,
    unique_tokens_bought INTEGER DEFAULT 0,
    unique_tokens_sold INTEGER DEFAULT 0,
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE
);

-- Performance monitoring table (добавлена для поддержки addMonitoringStats)
CREATE TABLE IF NOT EXISTS monitoring_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    processed_signatures INTEGER DEFAULT 0,
    total_wallets_monitored INTEGER DEFAULT 0,
    scan_duration INTEGER, -- in milliseconds
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_is_active ON wallets(is_active);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON transactions(signature);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction_id ON token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_id ON token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_type ON token_operations(operation_type);
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);
CREATE INDEX IF NOT EXISTS idx_wallet_stats_wallet_id ON wallet_stats(wallet_id);

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_time ON transactions(wallet_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_amount ON token_operations(token_id, amount DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type_time ON transactions(transaction_type, block_time DESC);

-- Add triggers for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_wallet_stats_updated_at BEFORE UPDATE ON wallet_stats FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create views for common queries
CREATE OR REPLACE VIEW wallet_overview AS
SELECT 
    w.id,
    w.address,
    w.name,
    w.is_active,
    w.created_at,
    COALESCE(ws.total_spent_sol, 0) as total_spent_sol,
    COALESCE(ws.total_received_sol, 0) as total_received_sol,
    COALESCE(ws.total_spent_usd, 0) as total_spent_usd,
    COALESCE(ws.total_received_usd, 0) as total_received_usd,
    COALESCE(ws.total_buy_transactions, 0) as total_buy_transactions,
    COALESCE(ws.total_sell_transactions, 0) as total_sell_transactions,
    COALESCE(ws.unique_tokens_bought, 0) as unique_tokens_bought,
    COALESCE(ws.unique_tokens_sold, 0) as unique_tokens_sold,
    ws.last_transaction_at
FROM wallets w
LEFT JOIN wallet_stats ws ON w.id = ws.wallet_id
WHERE w.is_active = TRUE;

CREATE OR REPLACE VIEW recent_transactions_detailed AS
SELECT 
    t.id,
    t.signature,
    t.block_time,
    t.transaction_type,
    t.sol_spent,
    t.sol_received,
    t.usd_spent,
    t.usd_received,
    w.address as wallet_address,
    w.name as wallet_name,
    tk.mint,
    tk.symbol,
    tk.name as token_name,
    tk.logo_uri,
    to_.amount as token_amount,
    to_.operation_type,
    tk.decimals
FROM transactions t
JOIN wallets w ON t.wallet_id = w.id
LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
LEFT JOIN tokens tk ON to_.token_id = tk.id
WHERE t.block_time >= NOW() - INTERVAL '24 hours'
ORDER BY t.block_time DESC;

-- Migration script для существующих данных
DO $$
BEGIN
    -- Проверяем, существует ли старая таблица token_purchases
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'token_purchases') THEN
        -- Добавляем новые колонки если их нет
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'token_purchases' AND column_name = 'operation_type') THEN
            ALTER TABLE token_purchases ADD COLUMN operation_type VARCHAR(10) DEFAULT 'buy';
        END IF;
        
        -- Переименовываем таблицу
        ALTER TABLE token_purchases RENAME TO token_operations;
        
        -- Обновляем все записи как покупки
        UPDATE token_operations SET operation_type = 'buy' WHERE operation_type IS NULL;
        
        RAISE NOTICE 'Migrated token_purchases to token_operations';
    END IF;

    -- Добавляем новые колонки в transactions если их нет
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'sol_received') THEN
        ALTER TABLE transactions ADD COLUMN sol_received DECIMAL(20, 9) DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'usd_received') THEN
        ALTER TABLE transactions ADD COLUMN usd_received DECIMAL(15, 2) DEFAULT 0;
    END IF;
    
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'transaction_type') THEN
        ALTER TABLE transactions ADD COLUMN transaction_type VARCHAR(20) DEFAULT 'buy';
    END IF;
    
    -- Устанавливаем тип транзакции для существующих записей
    UPDATE transactions SET transaction_type = 'buy' WHERE transaction_type IS NULL;
END $$;

-- Добавить колонку total_wallets_monitored в monitoring_stats, если её нет
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'monitoring_stats' AND column_name = 'total_wallets_monitored') THEN
        ALTER TABLE monitoring_stats RENAME COLUMN total_wallets TO total_wallets_monitored;
    END IF;
END $$;