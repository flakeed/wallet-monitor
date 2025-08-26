const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class AuthMiddleware {
    constructor(db) {
        this.db = db;
        this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
        this.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    }

    // Verify Telegram auth data (original method, kept for widget compatibility)
    verifyTelegramAuth(authData) {
        const { hash, ...data } = authData;
        
        if (!hash) {
            throw new Error('No hash provided');
        }

        // Skip verification for simple auth
        if (hash === 'simple_auth') {
            console.log(`[${new Date().toISOString()}] ℹ️ Skipping hash verification for simple auth`);
            return true;
        }

        // Create data string for verification
        const dataCheckString = Object.keys(data)
            .sort()
            .map(key => `${key}=${data[key]}`)
            .join('\n');

        // Create secret key
        const secretKey = crypto
            .createHash('sha256')
            .update(this.TELEGRAM_BOT_TOKEN)
            .digest();

        // Create hash
        const calculatedHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (calculatedHash !== hash) {
            throw new Error('Invalid auth data');
        }

        // Check if auth data is not too old (optional, skip for simple auth)
        const authDate = parseInt(data.auth_date);
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - authDate > 86400) { // 24 hours
            throw new Error('Auth data is too old');
        }

        return true;
    }

    // Generate session token
    generateSessionToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    // Create user session (updated to use 'sessions' table instead of 'user_sessions')
    async createUserSession(userId) {
        const sessionToken = this.generateSessionToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const query = `
            INSERT INTO sessions (user_id, session_token, expires_at)
            VALUES ($1, $2, $3)
            RETURNING session_token, expires_at
        `;
        
        const result = await this.db.pool.query(query, [userId, sessionToken, expiresAt]);
        return result.rows[0];
    }

    // Validate session (updated to use 'sessions' table)
    async validateSession(sessionToken) {
        const query = `
            SELECT s.*, u.id as user_id, u.telegram_id, u.username, u.first_name, 
                   u.last_name, u.is_admin, u.is_active
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.session_token = $1 AND s.expires_at > NOW() AND u.is_active = true
        `;
        
        const result = await this.db.pool.query(query, [sessionToken]);
        return result.rows[0] || null;
    }

    // Check if user is in whitelist
    async isUserWhitelisted(telegramId) {
        const query = `
            SELECT telegram_id FROM whitelist WHERE telegram_id = $1
            UNION
            SELECT telegram_id FROM users WHERE telegram_id = $1 AND is_active = true
        `;
        
        const result = await this.db.pool.query(query, [telegramId]);
        return result.rows.length > 0;
    }

    // Create or update user
    async createOrUpdateUser(telegramData) {
        const { id, username, first_name, last_name } = telegramData;
        
        const query = `
            INSERT INTO users (telegram_id, username, first_name, last_name, last_login)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (telegram_id) 
            DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                last_login = NOW(),
                updated_at = NOW()
            RETURNING *
        `;
        
        const result = await this.db.pool.query(query, [id, username, first_name, last_name]);
        return result.rows[0];
    }

    // Middleware function for protecting routes
    authRequired = async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'No valid authorization header' });
            }

            const sessionToken = authHeader.substring(7);
            const session = await this.validateSession(sessionToken);
            
            if (!session) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            req.user = {
                id: session.user_id,
                telegramId: session.telegram_id,
                username: session.username,
                firstName: session.first_name,
                lastName: session.last_name,
                isAdmin: session.is_admin,
                isActive: session.is_active
            };

            next();
        } catch (error) {
            console.error('Auth middleware error:', error);
            res.status(401).json({ error: 'Authentication failed' });
        }
    };

    // Admin required middleware
    adminRequired = async (req, res, next) => {
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    };

    // Add user to whitelist
    async addToWhitelist(telegramId, addedBy, notes = '') {
        const query = `
            INSERT INTO whitelist (telegram_id, added_by, notes)
            VALUES ($1, $2, $3)
            ON CONFLICT (telegram_id) DO UPDATE SET
                notes = EXCLUDED.notes,
                created_at = CURRENT_TIMESTAMP
            RETURNING *
        `;
        
        const result = await this.db.pool.query(query, [telegramId, addedBy, notes]);
        return result.rows[0];
    }

    // Remove user from whitelist
    async removeFromWhitelist(telegramId) {
        const query = `DELETE FROM whitelist WHERE telegram_id = $1`;
        await this.db.pool.query(query, [telegramId]);
    }

    // Get whitelist
    async getWhitelist() {
        const query = `
            SELECT w.*, u.username as added_by_username
            FROM whitelist w
            LEFT JOIN users u ON w.added_by = u.id
            ORDER BY w.created_at DESC
        `;
        
        const result = await this.db.pool.query(query);
        return result.rows;
    }

    // Clean expired sessions (updated to use 'sessions' table)
    async cleanExpiredSessions() {
        const query = `DELETE FROM sessions WHERE expires_at < NOW()`;
        const result = await this.db.pool.query(query);
        return result.rowCount;
    }

    // Revoke user session (updated to use 'sessions' table)
    async revokeSession(sessionToken) {
        const query = `DELETE FROM sessions WHERE session_token = $1`;
        await this.db.pool.query(query, [sessionToken]);
    }

    // Get user by telegram ID
    async getUserByTelegramId(telegramId) {
        const query = `SELECT * FROM users WHERE telegram_id = $1`;
        const result = await this.db.pool.query(query, [telegramId]);
        return result.rows[0] || null;
    }
}

module.exports = AuthMiddleware;