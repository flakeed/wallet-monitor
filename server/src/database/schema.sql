-- ===== COMPLETE DATABASE SCHEMA WITH STABLECOIN SUPPORT =====

-- 1. Main tables creation (if not exists)
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(50),
    name VARCHAR(255),
    decimals INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    signature VARCHAR(88) NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
    sol_spent DECIMAL(20,9) DEFAULT 0 NOT NULL,
    sol_received DECIMAL(20,9) DEFAULT 0 NOT NULL,
    usd_spent DECIMAL(20,9) DEFAULT 0,
    usd_received DECIMAL(20,9) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    amount DECIMAL(30,18) NOT NULL,
    operation_type VARCHAR(10) NOT NULL CHECK (operation_type IN ('buy', 'sell')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID UNIQUE NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    total_spent_sol DECIMAL(20,9) DEFAULT 0,
    total_received_sol DECIMAL(20,9) DEFAULT 0,
    total_spent_stablecoin DECIMAL(20,9) DEFAULT 0,
    total_received_stablecoin DECIMAL(20,9) DEFAULT 0,
    total_buy_transactions INTEGER DEFAULT 0,
    total_sell_transactions INTEGER DEFAULT 0,
    unique_tokens_bought INTEGER DEFAULT 0,
    unique_tokens_sold INTEGER DEFAULT 0,
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitoring_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processed_signatures BIGINT DEFAULT 0,
    total_wallets_monitored INTEGER DEFAULT 0,
    last_scan_duration INTEGER DEFAULT 0,
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Add stablecoin columns to transactions table
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS stablecoin_spent DECIMAL(20,9) DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS stablecoin_received DECIMAL(20,9) DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS stablecoin_mint VARCHAR(44);

-- 3. Update existing NULL values
UPDATE transactions 
SET stablecoin_spent = 0 
WHERE stablecoin_spent IS NULL;

UPDATE transactions 
SET stablecoin_received = 0 
WHERE stablecoin_received IS NULL;

-- 4. Set NOT NULL constraints
ALTER TABLE transactions 
ALTER COLUMN stablecoin_spent SET NOT NULL,
ALTER COLUMN stablecoin_received SET NOT NULL;

-- 5. Add unique constraint to prevent duplicate transactions
ALTER TABLE transactions
ADD CONSTRAINT IF NOT EXISTS uk_transactions_signature_wallet
UNIQUE (signature, wallet_id);

-- 6. Create optimized indexes
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_address_unique
ON wallets(address)
WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_group_active
ON wallets(group_id, is_active)
WHERE is_active = true;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_signature_wallet
ON transactions(signature, wallet_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_stablecoin_mint
ON transactions(stablecoin_mint)
WHERE stablecoin_mint IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_stablecoin_amounts
ON transactions(stablecoin_spent, stablecoin_received)
WHERE stablecoin_spent > 0 OR stablecoin_received > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_with_stablecoin
ON transactions(wallet_id, block_time DESC)
WHERE stablecoin_mint IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_wallet_group
ON transactions(wallet_id)
INCLUDE (block_time, transaction_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallets_created_at_desc
ON wallets(created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_block_time_desc
ON transactions(block_time DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_operations_transaction_type
ON token_operations(transaction_id, operation_type);

-- 7. Function for bulk wallet insertion with optimization
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
AS $
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
        INSERT INTO wallets (address, name, group_id, is_active)
        SELECT DISTINCT t.address, t.name, t.group_id, true
        FROM temp_wallet_batch t
        LEFT JOIN wallets w ON w.address = t.address AND w.is_active = true
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
    INNER JOIN wallets w ON w.address = t.address AND w.is_active = true;

    RETURN QUERY SELECT inserted_cnt, duplicate_cnt, error_cnt, result_data;
END;
$;

-- 8. Function for monitoring stats with stablecoin support
CREATE OR REPLACE FUNCTION get_monitoring_stats_with_stablecoin(p_group_id UUID DEFAULT NULL)
RETURNS TABLE(
    active_wallets BIGINT,
    buy_transactions_today BIGINT,
    sell_transactions_today BIGINT,
    sol_spent_today NUMERIC,
    sol_received_today NUMERIC,
    stablecoin_spent_today NUMERIC,
    stablecoin_received_today NUMERIC,
    unique_tokens_today BIGINT,
    unique_stablecoins_today BIGINT
)
LANGUAGE SQL
STABLE
AS $
    SELECT 
        COUNT(DISTINCT w.id) as active_wallets,
        COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as buy_transactions_today,
        COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as sell_transactions_today,
        COALESCE(SUM(t.sol_spent), 0) as sol_spent_today,
        COALESCE(SUM(t.sol_received), 0) as sol_received_today,
        COALESCE(SUM(t.stablecoin_spent), 0) as stablecoin_spent_today,
        COALESCE(SUM(t.stablecoin_received), 0) as stablecoin_received_today,
        COUNT(DISTINCT to_.token_id) as unique_tokens_today,
        COUNT(DISTINCT t.stablecoin_mint) FILTER (WHERE t.stablecoin_mint IS NOT NULL) as unique_stablecoins_today
    FROM wallets w
    LEFT JOIN transactions t ON w.id = t.wallet_id 
        AND t.block_time >= CURRENT_DATE
    LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
    WHERE w.is_active = TRUE
        AND (p_group_id IS NULL OR w.group_id = p_group_id);
$;

-- 9. Function for bulk import statistics
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
AS $
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
$;

-- 10. Remove duplicate transactions
WITH duplicates AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY signature, wallet_id ORDER BY created_at) as row_num
    FROM transactions
)
DELETE FROM transactions
WHERE id IN (
    SELECT id FROM duplicates WHERE row_num > 1
);

-- 11. Create comprehensive view for transaction analysis
CREATE OR REPLACE VIEW v_transactions_summary AS
SELECT 
    t.id,
    t.signature,
    t.block_time,
    t.transaction_type,
    w.address as wallet_address,
    w.name as wallet_name,
    g.name as group_name,
    t.sol_spent,
    t.sol_received,
    t.stablecoin_spent,
    t.stablecoin_received,
    t.stablecoin_mint,
    -- Total value in SOL equivalent (USDC/USDT at ~$150 per SOL)
    CASE 
        WHEN t.transaction_type = 'buy' THEN 
            t.sol_spent + (t.stablecoin_spent / 150)
        WHEN t.transaction_type = 'sell' THEN 
            t.sol_received + (t.stablecoin_received / 150)
        ELSE 0
    END as total_sol_equivalent,
    -- Estimated USD value
    CASE 
        WHEN t.transaction_type = 'buy' THEN 
            (t.sol_spent * 150) + t.stablecoin_spent
        WHEN t.transaction_type = 'sell' THEN 
            (t.sol_received * 150) + t.stablecoin_received
        ELSE 0
    END as estimated_usd_value,
    -- Token count in transaction
    (SELECT COUNT(*) FROM token_operations to_ WHERE to_.transaction_id = t.id) as token_count
FROM transactions t
JOIN wallets w ON t.wallet_id = w.id
LEFT JOIN groups g ON w.group_id = g.id
ORDER BY t.block_time DESC;

-- 12. Function for transaction consistency checking
CREATE OR REPLACE FUNCTION check_transaction_consistency()
RETURNS TABLE(
    total_transactions BIGINT,
    sol_only_transactions BIGINT,
    stablecoin_only_transactions BIGINT,
    mixed_transactions BIGINT,
    no_value_transactions BIGINT
)
LANGUAGE SQL
STABLE
AS $
    SELECT 
        COUNT(*) as total_transactions,
        COUNT(*) FILTER (WHERE (sol_spent > 0 OR sol_received > 0) AND stablecoin_mint IS NULL) as sol_only_transactions,
        COUNT(*) FILTER (WHERE (stablecoin_spent > 0 OR stablecoin_received > 0) AND sol_spent = 0 AND sol_received = 0) as stablecoin_only_transactions,
        COUNT(*) FILTER (WHERE (sol_spent > 0 OR sol_received > 0) AND (stablecoin_spent > 0 OR stablecoin_received > 0)) as mixed_transactions,
        COUNT(*) FILTER (WHERE sol_spent = 0 AND sol_received = 0 AND stablecoin_spent = 0 AND stablecoin_received = 0) as no_value_transactions
    FROM transactions;
$;

-- 13. Optimization procedure for after bulk imports
CREATE OR REPLACE FUNCTION optimize_after_bulk_import()
RETURNS void
LANGUAGE plpgsql
AS $
BEGIN
    ANALYZE wallets;
    ANALYZE groups;
    ANALYZE transactions;
    ANALYZE tokens;
    ANALYZE token_operations;

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
$;

-- 14. Optimize autovacuum settings for high-volume tables
ALTER TABLE wallets SET (
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 500,
    autovacuum_vacuum_scale_factor = 0.1,
    autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE transactions SET (
    autovacuum_vacuum_threshold = 2000,
    autovacuum_analyze_threshold = 1000,
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_analyze_scale_factor = 0.02
);

-- 15. Monitoring view for bulk operations
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
WHERE tablename IN ('wallets', 'groups', 'transactions', 'tokens', 'token_operations')
ORDER BY n_tup_ins DESC;

-- 16. Add helpful comments for documentation
COMMENT ON COLUMN transactions.stablecoin_spent IS 'Amount of stablecoin spent in this transaction (USDC/USDT)';
COMMENT ON COLUMN transactions.stablecoin_received IS 'Amount of stablecoin received in this transaction (USDC/USDT)';
COMMENT ON COLUMN transactions.stablecoin_mint IS 'Mint address of the stablecoin used (USDC/USDT)';
COMMENT ON VIEW v_transactions_summary IS 'Comprehensive view showing all transaction data with SOL equivalents and USD estimates';
COMMENT ON FUNCTION bulk_insert_wallets IS 'Optimized function for bulk wallet insertion with duplicate handling';

-- 17. Set work memory and other optimizations for current session
SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET shared_buffers = '512MB';

-- 18. Final analysis
ANALYZE wallets;
ANALYZE transactions;
ANALYZE tokens;
ANALYZE token_operations;

-- Show final statistics
SELECT 'Schema initialization completed' as status, NOW() as completed_at;
SELECT * FROM check_transaction_consistency();