-- ===== Основные таблицы =====

-- Таблица групп кошельков
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица кошельков
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица токенов
CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint VARCHAR(44) UNIQUE NOT NULL,
    symbol VARCHAR(20),
    name VARCHAR(100),
    decimals INTEGER DEFAULT 0,
    logo_uri TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица транзакций с поддержкой USDC конвертации
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    signature VARCHAR(88) NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE NOT NULL,
    transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
    
    -- SOL операции (включает конвертированный USDC)
    sol_spent NUMERIC DEFAULT 0 NOT NULL,
    sol_received NUMERIC DEFAULT 0 NOT NULL,
    
    -- Дополнительная информация о конвертации
    original_usdc_amount NUMERIC DEFAULT 0, -- Если была операция с USDC
    usdc_to_sol_rate NUMERIC DEFAULT 0, -- Курс конвертации на момент транзакции
    sol_price_usd NUMERIC DEFAULT 0, -- Цена SOL в USD на момент транзакции
    
    -- Метаданные
    fee_lamports BIGINT DEFAULT 0,
    instruction_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Составной уникальный ключ для предотвращения дубликатов
    CONSTRAINT uk_transactions_signature_wallet UNIQUE (signature, wallet_id)
);

-- Таблица операций с токенами
CREATE TABLE IF NOT EXISTS token_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    token_id UUID NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL, -- Количество токенов
    operation_type VARCHAR(10) NOT NULL CHECK (operation_type IN ('buy', 'sell')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица статистики кошельков
CREATE TABLE IF NOT EXISTS wallet_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID UNIQUE NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    
    -- Общая статистика по SOL (включая конвертированный USDC)
    total_spent_sol NUMERIC DEFAULT 0,
    total_received_sol NUMERIC DEFAULT 0,
    net_pnl_sol NUMERIC GENERATED ALWAYS AS (total_received_sol - total_spent_sol) STORED,
    
    -- Статистика транзакций
    total_buy_transactions INTEGER DEFAULT 0,
    total_sell_transactions INTEGER DEFAULT 0,
    total_transactions INTEGER GENERATED ALWAYS AS (total_buy_transactions + total_sell_transactions) STORED,
    
    -- Статистика токенов
    unique_tokens_bought INTEGER DEFAULT 0,
    unique_tokens_sold INTEGER DEFAULT 0,
    
    -- Временные метки
    last_transaction_at TIMESTAMP WITH TIME ZONE,
    first_transaction_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Таблица статистики мониторинга
CREATE TABLE IF NOT EXISTS monitoring_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    processed_signatures BIGINT DEFAULT 0,
    total_wallets_monitored INTEGER DEFAULT 0,
    last_scan_duration INTEGER DEFAULT 0, -- в миллисекундах
    errors_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ===== Индексы для производительности =====

-- Индексы для кошельков
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_group_active ON wallets(group_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_wallets_created_at ON wallets(created_at DESC);

-- Индексы для транзакций
CREATE INDEX IF NOT EXISTS idx_transactions_wallet_time ON transactions(wallet_id, block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_signature ON transactions(signature);

-- Составной индекс для фильтрации по времени и типу
CREATE INDEX IF NOT EXISTS idx_transactions_time_type ON transactions(block_time DESC, transaction_type);

-- Индексы для токенов
CREATE INDEX IF NOT EXISTS idx_tokens_mint ON tokens(mint);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol);

-- Индексы для операций с токенами
CREATE INDEX IF NOT EXISTS idx_token_operations_transaction ON token_operations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_token ON token_operations(token_id);
CREATE INDEX IF NOT EXISTS idx_token_operations_type ON token_operations(operation_type);

-- Составной индекс для группировки по токенам
CREATE INDEX IF NOT EXISTS idx_token_operations_token_type ON token_operations(token_id, operation_type);

-- Индексы для статистики кошельков
CREATE INDEX IF NOT EXISTS idx_wallet_stats_wallet ON wallet_stats(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_stats_pnl ON wallet_stats(net_pnl_sol DESC);

-- ===== Триггеры для автоматического обновления =====

-- Триггер для обновления updated_at в wallets
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_wallets_updated_at 
    BEFORE UPDATE ON wallets 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_groups_updated_at 
    BEFORE UPDATE ON groups 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tokens_updated_at 
    BEFORE UPDATE ON tokens 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallet_stats_updated_at 
    BEFORE UPDATE ON wallet_stats 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== Функции для работы с USDC конвертацией =====

-- Функция для получения курса USDC к SOL
CREATE OR REPLACE FUNCTION get_current_usdc_sol_rate()
RETURNS NUMERIC AS $$
DECLARE
    current_rate NUMERIC;
BEGIN
    -- Пытаемся получить последний курс из транзакций (за последние 10 минут)
    SELECT usdc_to_sol_rate INTO current_rate
    FROM transactions 
    WHERE usdc_to_sol_rate > 0 
    AND block_time >= NOW() - INTERVAL '10 minutes'
    ORDER BY block_time DESC 
    LIMIT 1;
    
    -- Если нет свежих данных, возвращаем дефолтный курс
    IF current_rate IS NULL THEN
        current_rate := 0.0067; -- Примерно $150 за SOL
    END IF;
    
    RETURN current_rate;
END;
$$ LANGUAGE plpgsql;

-- Функция для пересчёта статистики кошелька
CREATE OR REPLACE FUNCTION refresh_wallet_stats(target_wallet_id UUID)
RETURNS void AS $$
BEGIN
    INSERT INTO wallet_stats (
        wallet_id,
        total_spent_sol,
        total_received_sol,
        total_buy_transactions,
        total_sell_transactions,
        unique_tokens_bought,
        unique_tokens_sold,
        last_transaction_at,
        first_transaction_at
    )
    SELECT 
        target_wallet_id,
        COALESCE(SUM(sol_spent), 0),
        COALESCE(SUM(sol_received), 0),
        COUNT(CASE WHEN transaction_type = 'buy' THEN 1 END),
        COUNT(CASE WHEN transaction_type = 'sell' THEN 1 END),
        COUNT(DISTINCT CASE WHEN to_.operation_type = 'buy' THEN to_.token_id END),
        COUNT(DISTINCT CASE WHEN to_.operation_type = 'sell' THEN to_.token_id END),
        MAX(t.block_time),
        MIN(t.block_time)
    FROM transactions t
    LEFT JOIN token_operations to_ ON t.id = to_.transaction_id
    WHERE t.wallet_id = target_wallet_id
    
    ON CONFLICT (wallet_id) DO UPDATE SET
        total_spent_sol = EXCLUDED.total_spent_sol,
        total_received_sol = EXCLUDED.total_received_sol,
        total_buy_transactions = EXCLUDED.total_buy_transactions,
        total_sell_transactions = EXCLUDED.total_sell_transactions,
        unique_tokens_bought = EXCLUDED.unique_tokens_bought,
        unique_tokens_sold = EXCLUDED.unique_tokens_sold,
        last_transaction_at = EXCLUDED.last_transaction_at,
        first_transaction_at = EXCLUDED.first_transaction_at,
        updated_at = CURRENT_TIMESTAMP;
END;
$ LANGUAGE plpgsql;

-- ===== Представления для удобного доступа к данным =====

-- Представление для детальной информации о кошельках
CREATE OR REPLACE VIEW wallet_details AS
SELECT 
    w.id,
    w.address,
    w.name,
    w.is_active,
    g.id as group_id,
    g.name as group_name,
    ws.total_spent_sol,
    ws.total_received_sol,
    ws.net_pnl_sol,
    ws.total_transactions,
    ws.last_transaction_at,
    w.created_at
FROM wallets w
LEFT JOIN groups g ON w.group_id = g.id
LEFT JOIN wallet_stats ws ON w.id = ws.wallet_id;

-- Представление для агрегированной статистики по токенам
CREATE OR REPLACE VIEW token_statistics AS
SELECT 
    t.mint,
    t.symbol,
    t.name,
    t.decimals,
    COUNT(DISTINCT tr.wallet_id) as unique_wallets,
    COUNT(CASE WHEN to_.operation_type = 'buy' THEN 1 END) as total_buys,
    COUNT(CASE WHEN to_.operation_type = 'sell' THEN 1 END) as total_sells,
    SUM(CASE WHEN to_.operation_type = 'buy' THEN to_.amount ELSE 0 END) as total_bought,
    SUM(CASE WHEN to_.operation_type = 'sell' THEN to_.amount ELSE 0 END) as total_sold,
    SUM(CASE WHEN tr.transaction_type = 'buy' THEN tr.sol_spent ELSE 0 END) as total_sol_spent,
    SUM(CASE WHEN tr.transaction_type = 'sell' THEN tr.sol_received ELSE 0 END) as total_sol_received,
    (SUM(CASE WHEN tr.transaction_type = 'sell' THEN tr.sol_received ELSE 0 END) - 
     SUM(CASE WHEN tr.transaction_type = 'buy' THEN tr.sol_spent ELSE 0 END)) as net_sol_pnl,
    MAX(tr.block_time) as last_activity
FROM tokens t
JOIN token_operations to_ ON t.id = to_.token_id
JOIN transactions tr ON to_.transaction_id = tr.id
JOIN wallets w ON tr.wallet_id = w.id
WHERE w.is_active = true
GROUP BY t.id, t.mint, t.symbol, t.name, t.decimals;

-- Представление для недавних транзакций с полной информацией
CREATE OR REPLACE VIEW recent_transactions_detailed AS
SELECT 
    tr.signature,
    tr.block_time,
    tr.transaction_type,
    tr.sol_spent,
    tr.sol_received,
    tr.original_usdc_amount,
    tr.usdc_to_sol_rate,
    tr.sol_price_usd,
    w.address as wallet_address,
    w.name as wallet_name,
    g.id as group_id,
    g.name as group_name,
    t.mint as token_mint,
    t.symbol as token_symbol,
    t.name as token_name,
    t.decimals as token_decimals,
    to_.amount as token_amount,
    to_.operation_type as token_operation_type
FROM transactions tr
JOIN wallets w ON tr.wallet_id = w.id
LEFT JOIN groups g ON w.group_id = g.id
LEFT JOIN token_operations to_ ON tr.id = to_.transaction_id
LEFT JOIN tokens t ON to_.token_id = t.id
WHERE w.is_active = true
ORDER BY tr.block_time DESC;

-- ===== Функции для массовых операций с оптимизацией =====

-- Функция для массового добавления кошельков с оптимизацией
CREATE OR REPLACE FUNCTION bulk_insert_wallets_optimized(
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
BEGIN
    -- Создаем временную таблицу для пакетной обработки
    CREATE TEMP TABLE temp_wallet_batch (
        address VARCHAR(44),
        name VARCHAR(255),
        group_id UUID
    ) ON COMMIT DROP;

    -- Заполняем временную таблицу данными
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

    -- Подсчитываем дубликаты
    SELECT COUNT(*)::INTEGER INTO duplicate_cnt
    FROM temp_wallet_batch t
    INNER JOIN wallets w ON w.address = t.address;

    -- Массовая вставка с обработкой дубликатов
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

    RETURN QUERY SELECT inserted_cnt, duplicate_cnt, error_cnt, result_data;
END;
$;

-- ===== Процедуры обслуживания и оптимизации =====

-- Процедура для очистки старых данных
CREATE OR REPLACE FUNCTION cleanup_old_data(days_to_keep INTEGER DEFAULT 30)
RETURNS TABLE(
    deleted_transactions INTEGER,
    deleted_operations INTEGER,
    deleted_stats INTEGER
)
LANGUAGE plpgsql
AS $
DECLARE
    tx_deleted INTEGER;
    op_deleted INTEGER;
    stats_deleted INTEGER;
BEGIN
    -- Удаляем старые транзакции
    WITH deleted_tx AS (
        DELETE FROM transactions 
        WHERE block_time < NOW() - INTERVAL '1 day' * days_to_keep
        RETURNING id
    )
    SELECT COUNT(*) INTO tx_deleted FROM deleted_tx;
    
    -- Удаляем операции с токенами, связанные с удаленными транзакциями
    WITH deleted_ops AS (
        DELETE FROM token_operations 
        WHERE transaction_id NOT IN (SELECT id FROM transactions)
        RETURNING id
    )
    SELECT COUNT(*) INTO op_deleted FROM deleted_ops;
    
    -- Удаляем статистику мониторинга старше указанного периода
    WITH deleted_monitoring AS (
        DELETE FROM monitoring_stats 
        WHERE created_at < NOW() - INTERVAL '1 day' * days_to_keep
        RETURNING id
    )
    SELECT COUNT(*) INTO stats_deleted FROM deleted_monitoring;
    
    -- Обновляем статистику всех кошельков
    PERFORM refresh_wallet_stats(w.id) FROM wallets w WHERE w.is_active = true;
    
    -- Обновляем статистику таблиц
    ANALYZE transactions;
    ANALYZE token_operations;
    ANALYZE wallet_stats;
    
    RETURN QUERY SELECT tx_deleted, op_deleted, stats_deleted;
END;
$;

-- Процедура для оптимизации после массового импорта
CREATE OR REPLACE FUNCTION optimize_after_bulk_import()
RETURNS void
LANGUAGE plpgsql
AS $
BEGIN
    -- Обновляем статистику таблиц для оптимизатора запросов
    ANALYZE wallets;
    ANALYZE groups;
    ANALYZE transactions;
    ANALYZE tokens;
    ANALYZE token_operations;
    ANALYZE wallet_stats;
    
    -- Обновляем статистику всех кошельков
    INSERT INTO wallet_stats (wallet_id)
    SELECT w.id FROM wallets w 
    WHERE w.is_active = true 
    AND w.id NOT IN (SELECT wallet_id FROM wallet_stats)
    ON CONFLICT (wallet_id) DO NOTHING;
    
    -- Пересчитываем статистику для всех кошельков
    PERFORM refresh_wallet_stats(w.id) FROM wallets w WHERE w.is_active = true;
    
    -- Очищаем неактивные записи старше 30 дней
    DELETE FROM wallets 
    WHERE is_active = false 
    AND updated_at < NOW() - INTERVAL '30 days';
    
    RAISE NOTICE 'Database optimization completed at %', NOW();
END;
$;

-- ===== Настройки автовакуума для интенсивных вставок =====

ALTER TABLE wallets SET (
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_threshold = 500,
    autovacuum_vacuum_scale_factor = 0.1,
    autovacuum_analyze_scale_factor = 0.05
);

ALTER TABLE transactions SET (
    autovacuum_vacuum_threshold = 2000,
    autovacuum_analyze_threshold = 1000,
    autovacuum_vacuum_scale_factor = 0.1,
    autovacuum_analyze_scale_factor = 0.05
);

-- ===== Представление для мониторинга производительности =====

CREATE OR REPLACE VIEW performance_monitoring AS
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
WHERE tablename IN ('wallets', 'groups', 'transactions', 'tokens', 'token_operations', 'wallet_stats')
ORDER BY n_tup_ins DESC;

-- ===== Конец схемы =====