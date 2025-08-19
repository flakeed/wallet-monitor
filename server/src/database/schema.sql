-- Enhanced database schema with user management
SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET shared_buffers = '512MB';
SET autocommit = off;

-- Users table for Telegram authentication
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    is_admin BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE
);

-- Whitelist table for managing access
CREATE TABLE IF NOT EXISTS user_whitelist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    added_by UUID REFERENCES users(id),
    reason VARCHAR(500),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Admin list for super admin access
CREATE TABLE IF NOT EXISTS admin_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    added_by UUID REFERENCES users(id),
    permissions JSONB DEFAULT '{"all": true}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Update groups table to include user ownership
ALTER TABLE groups ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT FALSE;

-- Update wallets table to include user ownership
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- Update transactions to link to user
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- User sessions for managing active sessions
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ip_address INET,
    user_agent TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_user_whitelist_telegram_id ON user_whitelist(telegram_id);
CREATE INDEX IF NOT EXISTS idx_admin_list_telegram_id ON admin_list(telegram_id);
CREATE INDEX IF NOT EXISTS idx_groups_user_id ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);

-- Functions for user management
CREATE OR REPLACE FUNCTION add_user_to_whitelist(
    p_telegram_id BIGINT,
    p_added_by UUID DEFAULT NULL,
    p_reason VARCHAR(500) DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT,
    user_data JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
    existing_user UUID;
    new_user UUID;
BEGIN
    -- Check if user already exists
    SELECT id INTO existing_user FROM users WHERE telegram_id = p_telegram_id;
    
    IF existing_user IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, 'User already exists'::TEXT, NULL::JSONB;
        RETURN;
    END IF;
    
    -- Check if already in whitelist
    IF EXISTS (SELECT 1 FROM user_whitelist WHERE telegram_id = p_telegram_id) THEN
        RETURN QUERY SELECT FALSE, 'User already in whitelist'::TEXT, NULL::JSONB;
        RETURN;
    END IF;
    
    -- Add to whitelist
    INSERT INTO user_whitelist (telegram_id, added_by, reason)
    VALUES (p_telegram_id, p_added_by, p_reason);
    
    RETURN QUERY SELECT 
        TRUE, 
        'User added to whitelist successfully'::TEXT,
        jsonb_build_object(
            'telegram_id', p_telegram_id,
            'added_by', p_added_by,
            'reason', p_reason,
            'created_at', CURRENT_TIMESTAMP
        );
END;
$$;

CREATE OR REPLACE FUNCTION add_admin(
    p_telegram_id BIGINT,
    p_added_by UUID DEFAULT NULL,
    p_permissions JSONB DEFAULT '{"all": true}'
)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- Check if already admin
    IF EXISTS (SELECT 1 FROM admin_list WHERE telegram_id = p_telegram_id) THEN
        RETURN QUERY SELECT FALSE, 'User already an admin'::TEXT;
        RETURN;
    END IF;
    
    -- Add to admin list
    INSERT INTO admin_list (telegram_id, added_by, permissions)
    VALUES (p_telegram_id, p_added_by, p_permissions);
    
    RETURN QUERY SELECT TRUE, 'User added as admin successfully'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION authenticate_user(
    p_telegram_id BIGINT,
    p_username VARCHAR(255) DEFAULT NULL,
    p_first_name VARCHAR(255) DEFAULT NULL,
    p_last_name VARCHAR(255) DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT,
    user_data JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
    existing_user UUID;
    is_whitelisted BOOLEAN := FALSE;
    is_admin BOOLEAN := FALSE;
    user_record RECORD;
BEGIN
    -- Check if user is in whitelist or admin list
    SELECT EXISTS(SELECT 1 FROM user_whitelist WHERE telegram_id = p_telegram_id) INTO is_whitelisted;
    SELECT EXISTS(SELECT 1 FROM admin_list WHERE telegram_id = p_telegram_id) INTO is_admin;
    
    IF NOT is_whitelisted AND NOT is_admin THEN
        RETURN QUERY SELECT FALSE, 'Access denied: User not in whitelist'::TEXT, NULL::JSONB;
        RETURN;
    END IF;
    
    -- Check if user already exists
    SELECT id INTO existing_user FROM users WHERE telegram_id = p_telegram_id;
    
    IF existing_user IS NOT NULL THEN
        -- Update existing user
        UPDATE users 
        SET 
            username = COALESCE(p_username, username),
            first_name = COALESCE(p_first_name, first_name),
            last_name = COALESCE(p_last_name, last_name),
            last_login = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            is_admin = is_admin
        WHERE id = existing_user
        RETURNING * INTO user_record;
    ELSE
        -- Create new user
        INSERT INTO users (telegram_id, username, first_name, last_name, is_admin, last_login)
        VALUES (p_telegram_id, p_username, p_first_name, p_last_name, is_admin, CURRENT_TIMESTAMP)
        RETURNING * INTO user_record;
    END IF;
    
    RETURN QUERY SELECT 
        TRUE, 
        'Authentication successful'::TEXT,
        jsonb_build_object(
            'id', user_record.id,
            'telegram_id', user_record.telegram_id,
            'username', user_record.username,
            'first_name', user_record.first_name,
            'last_name', user_record.last_name,
            'is_admin', user_record.is_admin,
            'is_active', user_record.is_active,
            'last_login', user_record.last_login
        );
END;
$$;

-- Function to migrate existing data to user ownership
CREATE OR REPLACE FUNCTION migrate_existing_data_to_admin()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    admin_user_id UUID;
    default_admin_telegram_id BIGINT := 123456789; -- Replace with actual admin Telegram ID
BEGIN
    -- Create default admin user if not exists
    INSERT INTO users (telegram_id, username, first_name, is_admin, is_active)
    VALUES (default_admin_telegram_id, 'admin', 'System Admin', TRUE, TRUE)
    ON CONFLICT (telegram_id) DO UPDATE SET is_admin = TRUE
    RETURNING id INTO admin_user_id;
    
    -- Add to admin list
    INSERT INTO admin_list (telegram_id, permissions)
    VALUES (default_admin_telegram_id, '{"all": true}')
    ON CONFLICT (telegram_id) DO NOTHING;
    
    -- Migrate existing groups
    UPDATE groups SET user_id = admin_user_id WHERE user_id IS NULL;
    
    -- Migrate existing wallets
    UPDATE wallets SET user_id = admin_user_id WHERE user_id IS NULL;
    
    -- Migrate existing transactions
    UPDATE transactions 
    SET user_id = admin_user_id 
    WHERE user_id IS NULL AND wallet_id IN (
        SELECT id FROM wallets WHERE user_id = admin_user_id
    );
    
    RAISE NOTICE 'Migration completed. All existing data assigned to admin user.';
END;
$$;

-- Constraints to ensure data isolation
ALTER TABLE groups ADD CONSTRAINT check_user_group_access 
CHECK (user_id IS NOT NULL OR is_shared = TRUE);

ALTER TABLE wallets ADD CONSTRAINT check_user_wallet_access 
CHECK (user_id IS NOT NULL);

-- Updated views for user-specific data
CREATE OR REPLACE VIEW user_wallet_stats AS
SELECT 
    w.user_id,
    w.id as wallet_id,
    w.address,
    w.name,
    w.group_id,
    g.name as group_name,
    COUNT(t.id) as total_transactions,
    COUNT(CASE WHEN t.transaction_type = 'buy' THEN 1 END) as buy_transactions,
    COUNT(CASE WHEN t.transaction_type = 'sell' THEN 1 END) as sell_transactions,
    COALESCE(SUM(t.sol_spent), 0) as total_sol_spent,
    COALESCE(SUM(t.sol_received), 0) as total_sol_received,
    MAX(t.block_time) as last_transaction_at
FROM wallets w
LEFT JOIN groups g ON w.group_id = g.id
LEFT JOIN transactions t ON w.id = t.wallet_id
WHERE w.is_active = TRUE
GROUP BY w.user_id, w.id, w.address, w.name, w.group_id, g.name;

-- Clean up old data and optimize
ANALYZE users;
ANALYZE user_whitelist;
ANALYZE admin_list;
ANALYZE user_sessions;