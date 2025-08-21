CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wallets' AND column_name = 'group_id') THEN
        ALTER TABLE wallets ADD COLUMN group_id UUID REFERENCES groups(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL,
    signature VARCHAR(88) UNIQUE NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    sol_spent DECIMAL(20, 9) DEFAULT 0, 
    sol_received DECIMAL(20, 9) DEFAULT 0,
    transaction_type VARCHAR(20) DEFAULT 'buy',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(20),
    name VARCHAR(255),
    decimals INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL,
    token_id UUID NOT NULL,
    amount DECIMAL(30, 18) NOT NULL, 
    operation_type VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES tokens (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_stats (
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
    FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS monitoring_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    processed_signatures INTEGER DEFAULT 0,
    total_wallets_monitored INTEGER DEFAULT 0,
    last_scan_duration INTEGER,
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

SET work_mem = '256MB';

SET maintenance_work_mem = '1GB';

SET shared_buffers = '512MB';

SET autocommit = off;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_address_unique 
ON wallets(address) 
WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_group_active 
ON wallets(group_id, is_active) 
WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_type_time 
ON transactions(transaction_type, block_time DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_wallet_time 
ON transactions(wallet_id, block_time DESC) 
INCLUDE (transaction_type, sol_spent, sol_received);

CREATE OR REPLACE FUNCTION bulk_insert_wallets(
    wallet_data jsonb[],
    default_group_id UUID DEFAULT NULL
) 
RETURNS TABLE(
    inserted_count INTEGER,
    duplicate_count INTEGER,
    error_count INTEGER,
    inserted_wallets jsonb
) 
LANGUAGE plpgsql
AS $$
DECLARE
    result_data jsonb := '[]'::jsonb;
    inserted_cnt INTEGER := 0;
    duplicate_cnt INTEGER := 0;
    error_cnt INTEGER := 0;
    wallet_record jsonb;
    new_wallet_id UUID;
BEGIN
    CREATE TEMP TABLE temp_wallet_batch (
        address VARCHAR(44),
        name VARCHAR(255),
        group_id UUID
    ) ON COMMIT DROP;

    FOR i IN 1..array_length(wallet_data, 1) LOOP
        BEGIN
            wallet_record := wallet_data[i];
            
            INSERT INTO temp_wallet_batch (address, name, group_id)
            VALUES (
                wallet_record->>'address',
                NULLIF(wallet_record->>'name', ''),
                COALESCE((wallet_record->>'groupId')::UUID, default_group_id)
            );
        EXCEPTION 
            WHEN OTHERS THEN
                error_cnt := error_cnt + 1;
        END;
    END LOOP;

    WITH inserted_wallets AS (
        INSERT INTO wallets (address, name, group_id)
        SELECT DISTINCT t.address, t.name, t.group_id
        FROM temp_wallet_batch t
        LEFT JOIN wallets w ON w.address = t.address
        WHERE w.address IS NULL
        RETURNING id, address, name, group_id, created_at
    )
    SELECT 
        COUNT(*)::INTEGER,
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'address', address,
                'name', name,
                'group_id', group_id,
                'created_at', created_at
            )
        )
    INTO inserted_cnt, result_data
    FROM inserted_wallets;

    SELECT COUNT(*)::INTEGER INTO duplicate_cnt
    FROM temp_wallet_batch t
    INNER JOIN wallets w ON w.address = t.address;

    RETURN QUERY SELECT inserted_cnt, duplicate_cnt, error_cnt, result_data;
END;
$$;

CREATE OR REPLACE FUNCTION get_bulk_import_stats()
RETURNS TABLE(
    total_wallets BIGINT,
    active_wallets BIGINT,
    groups_count BIGINT,
    avg_wallets_per_group NUMERIC,
    last_import_time TIMESTAMP WITH TIME ZONE
)
LANGUAGE SQL
STABLE
AS $$
    SELECT 
        COUNT(*) as total_wallets,
        COUNT(*) FILTER (WHERE is_active = true) as active_wallets,
        COUNT(DISTINCT group_id) FILTER (WHERE group_id IS NOT NULL) as groups_count,
        ROUND(AVG(group_wallet_count), 2) as avg_wallets_per_group,
        MAX(created_at) as last_import_time
    FROM wallets w
    LEFT JOIN (
        SELECT group_id, COUNT(*) as group_wallet_count
        FROM wallets 
        WHERE group_id IS NOT NULL 
        GROUP BY group_id
    ) g ON w.group_id = g.group_id;
$$;

WITH duplicates AS (
    SELECT id, 
           ROW_NUMBER() OVER (PARTITION BY signature, wallet_id ORDER BY created_at) as row_num
    FROM transactions
)
DELETE FROM transactions 
WHERE id IN (
    SELECT id FROM duplicates WHERE row_num > 1
);

ALTER TABLE transactions 
ADD CONSTRAINT check_sol_amounts_positive 
CHECK (sol_spent >= 0 AND sol_received >= 0);

ALTER TABLE transactions 
ADD CONSTRAINT check_usdc_amounts_positive 
CHECK (usdc_spent >= 0 AND usdc_received >= 0);

ALTER TABLE transactions 
ADD CONSTRAINT check_transaction_logic 
CHECK (
    (transaction_type = 'buy' AND sol_spent > 0 AND sol_received = 0) OR
    (transaction_type = 'sell' AND sol_received > 0 AND sol_spent = 0)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_usdc_monitoring 
ON transactions(block_time, usdc_spent, usdc_received) 
WHERE (usdc_spent > 0 OR usdc_received > 0);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_signature_wallet 
ON transactions(signature, wallet_id);


CREATE OR REPLACE FUNCTION optimize_after_bulk_import()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    ANALYZE wallets;
    ANALYZE groups;
    ANALYZE transactions;
    ANALYZE tokens;
    
    DELETE FROM wallets 
    WHERE is_active = false 
    AND updated_at < NOW() - INTERVAL '30 days';
    
    UPDATE groups 
    SET updated_at = CURRENT_TIMESTAMP
    FROM (
        SELECT group_id, COUNT(*) as wallet_count
        FROM wallets 
        WHERE is_active = true AND group_id IS NOT NULL
        GROUP BY group_id
    ) counts
    WHERE groups.id = counts.group_id;
    
    RAISE NOTICE 'Database optimization completed at %', NOW();
END;
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_created_at_desc 
ON wallets(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_wallet_group 
ON transactions(wallet_id) 
INCLUDE (block_time, transaction_type);

ALTER TABLE wallets SET (
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 500,
    autovacuum_vacuum_scale_factor = 0.1,
    autovacuum_analyze_scale_factor = 0.05
);

CREATE OR REPLACE VIEW bulk_import_monitoring AS
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
ORDER BY n_tup_ins DESC;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Add user_id to existing tables
ALTER TABLE groups ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Update groups table
CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_user ON groups(name, user_id);
DROP INDEX IF EXISTS groups_name_key; -- Remove old unique constraint

-- Update wallets table
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address_user ON wallets(address, user_id);
DROP INDEX IF EXISTS wallets_address_key; -- Remove old unique constraint

-- Sessions table for managing user sessions
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Whitelist table for managing access
CREATE TABLE IF NOT EXISTS whitelist (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    added_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    notes TEXT
);

-- Update wallet_stats to include user_id
ALTER TABLE wallet_stats ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_whitelist_telegram_id ON whitelist(telegram_id);
CREATE INDEX IF NOT EXISTS idx_groups_user_id ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

-- Function to clean expired sessions
CREATE OR REPLACE FUNCTION clean_expired_sessions()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM user_sessions WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get user stats
CREATE OR REPLACE FUNCTION get_user_stats(user_uuid UUID)
RETURNS TABLE(
    total_wallets BIGINT,
    active_wallets BIGINT,
    total_groups BIGINT,
    total_transactions BIGINT,
    total_sol_spent NUMERIC,
    total_sol_received NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(w.id) as total_wallets,
        COUNT(w.id) FILTER (WHERE w.is_active = true) as active_wallets,
        COUNT(DISTINCT g.id) as total_groups,
        COUNT(t.id) as total_transactions,
        COALESCE(SUM(t.sol_spent), 0) as total_sol_spent,
        COALESCE(SUM(t.sol_received), 0) as total_sol_received
    FROM users u
    LEFT JOIN wallets w ON u.id = w.user_id
    LEFT JOIN groups g ON u.id = g.user_id
    LEFT JOIN transactions t ON w.id = t.wallet_id
    WHERE u.id = user_uuid
    GROUP BY u.id;
END;
$$ LANGUAGE plpgsql;

-- Insert initial admin user (replace with your Telegram ID)
INSERT INTO users (telegram_id, username, first_name, is_admin, is_active)
VALUES (789676557, 'admin', 'Admin', true, true)
ON CONFLICT (telegram_id) DO UPDATE SET
    is_admin = true,
    is_active = true;

-- Insert into whitelist
INSERT INTO whitelist (telegram_id, notes)
VALUES (789676557, 'Initial admin user')
ON CONFLICT (telegram_id) DO NOTHING;