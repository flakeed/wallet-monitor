// server/src/middleware/authMiddleware.js - Общая сессия для всех пользователей
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class AuthMiddleware {
    constructor(db) {
        this.db = db;
        this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';
        this.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
        
        // Единая сессия для всех пользователей
        this.SHARED_SESSION = {
            token: 'shared-session-token-' + crypto.randomBytes(16).toString('hex'),
            created: Date.now(),
            // Эта сессия никогда не истекает или имеет очень длинный срок жизни
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 год
        };
        
        console.log(`[${new Date().toISOString()}] 🔑 Shared session initialized: ${this.SHARED_SESSION.token}`);
    }

    // Verify Telegram auth data (упрощенная версия)
    verifyTelegramAuth(authData) {
        const { hash, ...data } = authData;
        
        if (!hash) {
            throw new Error('No hash provided');
        }

        // Для общей сессии просто пропускаем проверку хеша
        if (hash === 'simple_auth' || hash === 'shared_session') {
            console.log(`[${new Date().toISOString()}] ℹ️ Skipping hash verification for shared session`);
            return true;
        }

        // Оригинальная логика проверки для совместимости
        try {
            const dataCheckString = Object.keys(data)
                .sort()
                .map(key => `${key}=${data[key]}`)
                .join('\n');

            const secretKey = crypto
                .createHash('sha256')
                .update(this.TELEGRAM_BOT_TOKEN)
                .digest();

            const calculatedHash = crypto
                .createHmac('sha256', secretKey)
                .update(dataCheckString)
                .digest('hex');

            return calculatedHash === hash;
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Hash verification failed, allowing shared session anyway:`, error.message);
            return true; // Для общей сессии разрешаем в любом случае
        }
    }

    // Возвращает общую сессию для всех пользователей
    async createUserSession(userId) {
        console.log(`[${new Date().toISOString()}] 🔄 Returning shared session for user ${userId}`);
        
        // Обновляем время последнего входа пользователя
        await this.updateUserLastLogin(userId);
        
        return {
            session_token: this.SHARED_SESSION.token,
            expires_at: this.SHARED_SESSION.expiresAt
        };
    }

    // Обновляем время последнего входа пользователя
    async updateUserLastLogin(userId) {
        try {
            const query = `
                UPDATE users 
                SET last_login = NOW(), updated_at = NOW()
                WHERE id = $1
            `;
            await this.db.pool.query(query, [userId]);
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ Failed to update last login for user ${userId}:`, error.message);
        }
    }

    // Валидация общей сессии
    async validateSession(sessionToken) {
        // Если это общая сессия, просто проверяем что токен совпадает
        if (sessionToken === this.SHARED_SESSION.token) {
            console.log(`[${new Date().toISOString()}] ✅ Shared session validated`);
            return {
                user_id: null, // Не привязана к конкретному пользователю
                session_token: sessionToken,
                expires_at: this.SHARED_SESSION.expiresAt,
                is_shared: true
            };
        }
        
        // Для обратной совместимости проверяем индивидуальные сессии
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

    // Middleware function for protecting routes (обновленная для общей сессии)
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
    
            // Для общей сессии получаем данные пользователя из параметров запроса или заголовков
            if (session.is_shared) {
                const userIdHeader = req.headers['x-user-id'];
                const telegramIdHeader = req.headers['x-telegram-id'];
                
                console.log(`[${new Date().toISOString()}] 🔍 Shared session auth - telegramId: ${telegramIdHeader}, userId: ${userIdHeader}`);
                
                if (userIdHeader && userIdHeader !== 'shared-user') {
                    const user = await this.getUserById(userIdHeader);
                    if (user && user.is_active) {
                        req.user = {
                            id: user.id,
                            telegramId: user.telegram_id,
                            username: user.username,
                            firstName: user.first_name,
                            lastName: user.last_name,
                            isAdmin: user.is_admin,
                            isActive: user.is_active
                        };
                        req.isSharedSession = true;
                        console.log(`[${new Date().toISOString()}] ✅ Shared session user loaded: ${user.username || user.first_name} (admin: ${user.is_admin})`);
                    } else {
                        return res.status(401).json({ error: 'Invalid user data in shared session' });
                    }
                } else if (telegramIdHeader) {
                    const user = await this.getUserByTelegramId(parseInt(telegramIdHeader));
                    if (user && user.is_active) {
                        req.user = {
                            id: user.id,
                            telegramId: user.telegram_id,
                            username: user.username,
                            firstName: user.first_name,
                            lastName: user.last_name,
                            isAdmin: user.is_admin,
                            isActive: user.is_active
                        };
                        req.isSharedSession = true;
                        console.log(`[${new Date().toISOString()}] ✅ Shared session user loaded by telegram ID: ${user.username || user.first_name} (admin: ${user.is_admin})`);
                    } else {
                        return res.status(401).json({ error: 'Invalid user data in shared session' });
                    }
                } else {
                    // Если не указан конкретный пользователь, создаем базового пользователя
                    req.user = {
                        id: 'shared-user',
                        telegramId: null,
                        username: 'shared',
                        firstName: 'Shared',
                        lastName: 'User',
                        isAdmin: false,
                        isActive: true
                    };
                    req.isSharedSession = true;
                    console.log(`[${new Date().toISOString()}] ✅ Default shared session user`);
                }
            } else {
                // Обычная индивидуальная сессия
                req.user = {
                    id: session.user_id,
                    telegramId: session.telegram_id,
                    username: session.username,
                    firstName: session.first_name,
                    lastName: session.last_name,
                    isAdmin: session.is_admin,
                    isActive: session.is_active
                };
                req.isSharedSession = false;
                console.log(`[${new Date().toISOString()}] ✅ Individual session user: ${session.username || session.first_name} (admin: ${session.is_admin})`);
            }
    
            next();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Auth middleware error:`, error.message);
            res.status(401).json({ error: 'Authentication failed' });
        }
    };
    // Admin required middleware (обновлен для общей сессии)
    adminRequired = async (req, res, next) => {
        try {
            console.log(`[${new Date().toISOString()}] 🔑 Admin access check - shared session: ${req.isSharedSession}`);
            
            if (req.isSharedSession) {
                // В общей сессии проверяем админа по заголовку
                const telegramId = req.headers['x-telegram-id'];
                const userId = req.headers['x-user-id'];
                
                console.log(`[${new Date().toISOString()}] 🔍 Checking admin access - telegramId: ${telegramId}, userId: ${userId}`);
                
                let user = null;
                
                if (telegramId) {
                    user = await this.getUserByTelegramId(parseInt(telegramId));
                    console.log(`[${new Date().toISOString()}] 👤 User by telegram ID: ${user ? `${user.username || user.first_name} (admin: ${user.is_admin})` : 'not found'}`);
                } else if (userId && userId !== 'shared-user') {
                    user = await this.getUserById(userId);
                    console.log(`[${new Date().toISOString()}] 👤 User by user ID: ${user ? `${user.username || user.first_name} (admin: ${user.is_admin})` : 'not found'}`);
                }
                
                // Если пользователь не найден или не админ
                if (!user || !user.is_admin || !user.is_active) {
                    console.log(`[${new Date().toISOString()}] ❌ Admin access denied - user: ${user ? 'found' : 'not found'}, admin: ${user?.is_admin}, active: ${user?.is_active}`);
                    return res.status(403).json({ error: 'Admin access required' });
                }
                
                // Обновляем данные пользователя для админских операций
                req.user = {
                    id: user.id,
                    telegramId: user.telegram_id,
                    username: user.username,
                    firstName: user.first_name,
                    lastName: user.last_name,
                    isAdmin: user.is_admin,
                    isActive: user.is_active
                };
                
                console.log(`[${new Date().toISOString()}] ✅ Admin access granted for ${user.username || user.first_name} (${user.telegram_id})`);
            } else {
                // Обычная индивидуальная сессия
                if (!req.user || !req.user.isAdmin) {
                    console.log(`[${new Date().toISOString()}] ❌ Admin access denied - individual session, user admin: ${req.user?.isAdmin}`);
                    return res.status(403).json({ error: 'Admin access required' });
                }
                console.log(`[${new Date().toISOString()}] ✅ Admin access granted for individual session user ${req.user.id}`);
            }
            
            next();
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Admin middleware error:`, error.message);
            res.status(500).json({ error: 'Authentication error' });
        }
    };

    // Получение пользователя по ID
    async getUserById(userId) {
        const query = `SELECT * FROM users WHERE id = $1`;
        const result = await this.db.pool.query(query, [userId]);
        return result.rows[0] || null;
    }

    // Get user by telegram ID
    async getUserByTelegramId(telegramId) {
        const query = `SELECT * FROM users WHERE telegram_id = $1`;
        const result = await this.db.pool.query(query, [telegramId]);
        return result.rows[0] || null;
    }

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

    // Clean expired sessions (для совместимости, не влияет на общую сессию)
    async cleanExpiredSessions() {
        const query = `DELETE FROM sessions WHERE expires_at < NOW()`;
        const result = await this.db.pool.query(query);
        return result.rowCount;
    }

    // Revoke user session (для совместимости)
    async revokeSession(sessionToken) {
        if (sessionToken === this.SHARED_SESSION.token) {
            console.log(`[${new Date().toISOString()}] ℹ️ Cannot revoke shared session`);
            return;
        }
        const query = `DELETE FROM sessions WHERE session_token = $1`;
        await this.db.pool.query(query, [sessionToken]);
    }

    // Получить информацию об общей сессии
    getSharedSessionInfo() {
        return {
            token: this.SHARED_SESSION.token,
            created: this.SHARED_SESSION.created,
            expiresAt: this.SHARED_SESSION.expiresAt,
            isShared: true
        };
    }

    // Обновить общую сессию (если нужно)
    regenerateSharedSession() {
        this.SHARED_SESSION = {
            token: 'shared-session-token-' + crypto.randomBytes(16).toString('hex'),
            created: Date.now(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        };
        
        console.log(`[${new Date().toISOString()}] 🔄 Shared session regenerated: ${this.SHARED_SESSION.token}`);
        return this.SHARED_SESSION;
    }
}

module.exports = AuthMiddleware;