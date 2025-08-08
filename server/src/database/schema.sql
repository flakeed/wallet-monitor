-- Ensure the schema exists
CREATE SCHEMA IF NOT EXISTS public;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;

-- Drop stale types (only if not tied to a table)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'wallets' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.wallets CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'groups' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.groups CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'transactions' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.transactions CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'tokens' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.tokens CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'token_operations' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.token_operations CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'wallet_stats' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.wallet_stats CASCADE;
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE t.typname = 'monitoring_stats' AND n.nspname = 'public' AND t.typrelid = 0
    ) THEN
        DROP TYPE IF EXISTS public.monitoring_stats CASCADE;
    END IF;
END $$;

-- Create groups table
CREATE TABLE IF NOT EXISTS public.groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create wallets table
CREATE TABLE IF NOT EXISTS public.wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    group_id INTEGER REFERENCES public.groups(id)
);

-- Create transactions table
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL,
    signature VARCHAR(88) UNIQUE NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    sol_spent DECIMAL(20, 9) DEFAULT 0,
    sol_received DECIMAL(20, 9) DEFAULT 0,
    transaction_type VARCHAR(20) DEFAULT 'buy',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES public.wallets (id) ON DELETE CASCADE
);

-- Create tokens table
CREATE TABLE IF NOT EXISTS public.tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(20),
    name VARCHAR(255),
    decimals INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create token_operations table
CREATE TABLE IF NOT EXISTS public.token_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL,
    token_id UUID NOT NULL,
    amount DECIMAL(30, 18) NOT NULL,
    operation_type VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES public.transactions (id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES public.tokens (id) ON DELETE CASCADE
);

-- Create wallet_stats table
CREATE TABLE IF NOT EXISTS public.wallet_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID UNIQUE NOT NULL,
    total_spent_sol DECIMAL(20, 9) DEFAULT 0,
    total_received_sol DECIMAL(20, 9) DEFAULT 0,
    total_buy_transactions INTEGER DEFAULT 0,
    total_sell_transactions INTEGER DEFAULT 0,
    unique_tokens_bought INTEGER DEFAULT 0,
    unique_tokens_sold INTEGER DEFAULT 0,
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES public.wallets (id) ON DELETE CASCADE
);

-- Create monitoring_stats table
CREATE TABLE IF NOT EXISTS public.monitoring_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    processed_signatures INTEGER DEFAULT 0,
    total_wallets_monitored INTEGER DEFAULT 0,
    last_scan_duration INTEGER,
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_wallets_address ON public.wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_is_active ON public.wallets(is_active);
CREATE INDEX IF NOT EXISTS idx_wallets_group_id ON public.wallets(group_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_id ON public.transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_block_time ON public.transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON public.transactions(signature);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction_id ON public.token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_id ON public.token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_type ON public.token_operations(operation_type);
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON public.tokens(mint);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON public.tokens(symbol);
CREATE INDEX IF NOT EXISTS idx_wallet_stats_wallet_id ON public.wallet_stats(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_time ON public.transactions(wallet_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_token_operations_token_amount ON public.token_operations(token_id, amount DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type_time ON public.transactions(transaction_type, block_time DESC);

-- Create update_updated_at_column function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers
CREATE TRIGGER update_wallets_updated_at BEFORE UPDATE ON public.wallets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_tokens_updated_at BEFORE UPDATE ON public.tokens FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_wallet_stats_updated_at BEFORE UPDATE ON public.wallet_stats FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create wallet_overview view
CREATE OR REPLACE VIEW public.wallet_overview AS
SELECT 
    w.id,
    w.address,
    w.name,
    w.is_active,
    w.created_at,
    COALESCE(ws.total_spent_sol, 0) as total_spent_sol,
    COALESCE(ws.total_received_sol, 0) as total_received_sol,
    COALESCE(ws.total_buy_transactions, 0) as total_buy_transactions,
    COALESCE(ws.total_sell_transactions, 0) as total_sell_transactions,
    COALESCE(ws.unique_tokens_bought, 0) as unique_tokens_bought,
    COALESCE(ws.unique_tokens_sold, 0) as unique_tokens_sold,
    ws.last_transaction_at
FROM public.wallets w
LEFT JOIN public.wallet_stats ws ON w.id = ws.wallet_id
WHERE w.is_active = TRUE;

-- Create recent_transactions_detailed view
CREATE OR REPLACE VIEW public.recent_transactions_detailed AS
SELECT 
    t.id,
    t.signature,
    t.block_time,
    t.transaction_type,
    t.sol_spent,
    t.sol_received,
    w.address as wallet_address,
    w.name as wallet_name,
    tk.mint,
    tk.symbol,
    tk.name as token_name,
    to_.amount as token_amount,
    to_.operation_type,
    tk.decimals
FROM public.transactions t
JOIN public.wallets w ON t.wallet_id = w.id
LEFT JOIN public.token_operations to_ ON t.id = to_.transaction_id
LEFT JOIN public.tokens tk ON to_.token_id = tk.id
WHERE t.block_time >= NOW() - INTERVAL '24 hours'
ORDER BY t.block_time DESC;

-- Migrate token_purchases to token_operations
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'token_purchases') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'token_purchases' AND column_name = 'operation_type') THEN
            ALTER TABLE public.token_purchases ADD COLUMN operation_type VARCHAR(10) DEFAULT 'buy';
        END IF;
        
        ALTER TABLE public.token_purchases RENAME TO token_operations;
        
        UPDATE public.token_operations SET operation_type = 'buy' WHERE operation_type IS NULL;
        
        RAISE NOTICE 'Migrated token_purchases to token_operations';
    END IF;
END $$;

-- Add sol_received column to transactions if missing
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'sol_received') THEN
        ALTER TABLE public.transactions ADD COLUMN sol_received DECIMAL(20, 9);
    END IF;
    
    UPDATE public.transactions SET transaction_type = 'buy' WHERE transaction_type IS NULL;
END $$;

-- Create wallet_stats_view
CREATE OR REPLACE VIEW public.wallet_stats_view AS
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
FROM public.wallets w
LEFT JOIN public.groups g ON w.group_id = g.id
LEFT JOIN public.transactions t ON w.id = t.wallet_id
LEFT JOIN public.token_operations to_ ON t.id = to_.transaction_id
GROUP BY w.id, w.address, w.name, w.group_id, g.name;