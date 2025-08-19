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