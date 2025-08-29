
const Redis = require('ioredis');
const SimplifiedTokenService = require('./SimplifiedTokenService');

class PriceService {
constructor() {
this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
this.simplifiedTokenService = new SimplifiedTokenService();

// Fallback to DexScreener for some operations
this.fallbackEnabled = true;

this.solPriceCache = {
price: 150,
lastUpdated: 0,
cacheTimeout: 30000 // 30 seconds
};

this.tokenPriceCache = new Map();
this.maxCacheSize = 1000;

// Statistics
this.stats = {
rpcRequests: 0,
fallbackRequests: 0,
cacheHits: 0,
errors: 0,
avgResponseTime: 0,
startTime: Date.now()
};

// Start background price updates
this.startBackgroundUpdates();

console.log(`[${new Date().toISOString()}] 🚀 Enhanced Price Service initialized with Simplified Token Service`);
}

// Background service to keep SOL price fresh
startBackgroundUpdates() {
// Update SOL price every 30 seconds using RPC
setInterval(async () => {
try {
await this.updateSolPriceInBackground();
} catch (error) {
console.error(`[${new Date().toISOString()}] ❌ Background SOL price update failed:`, error.message);
}
}, 30000);

// Clean old token price cache every 5 minutes
setInterval(() => {
this.cleanTokenPriceCache();
}, 300000);
}

async updateSolPriceInBackground() {
const startTime = Date.now();

try {
console.log(`[${new Date().toISOString()}] 🔄 Updating SOL price via RPC...`);

// Try to get SOL price from RPC first
let newPrice;
try {
const solPriceData = await this.enhancedTokenService.getSolPrice();
newPrice = solPriceData;
this.stats.rpcRequests++;
console.log(`[${new Date().toISOString()}] ✅ SOL price from RPC: ${newPrice}`);
} catch (rpcError) {
console.warn(`[${new Date().toISOString()}] ⚠️ RPC SOL price failed, using fallback:`, rpcError.message);

if (this.fallbackEnabled) {
// Fallback to DexScreener
const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
    timeout: 5000,
    headers: { 'Accept': 'application/json' }
});

if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
}

const data = await response.json();

if (data.pairs && data.pairs.length > 0) {
    const bestPair = data.pairs.reduce((prev, current) =>
        (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
    );
    newPrice = parseFloat(bestPair.priceUsd || 150);
    this.stats.fallbackRequests++;
    console.log(`[${new Date().toISOString()}] ✅ SOL price from fallback: ${newPrice}`);
} else {
    throw new Error('No price data found');
}
} else {
throw rpcError;
}
}

this.solPriceCache = {
price: newPrice,
lastUpdated: Date.now(),
cacheTimeout: 30000
};

// Also cache in Redis for sharing across instances
await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));

const responseTime = Date.now() - startTime;
this.updateAvgResponseTime(responseTime);

console.log(`[${new Date().toISOString()}] ✅ SOL price updated: ${newPrice} (${responseTime}ms)`);

} catch (error) {
console.error(`[${new Date().toISOString()}] ❌ Failed to update SOL price:`, error.message);
this.stats.errors++;
}
}

async getSolPrice() {
const now = Date.now();

// Return cached price if fresh
if (now - this.solPriceCache.lastUpdated < this.solPriceCache.cacheTimeout) {
this.stats.cacheHits++;
return {
success: true,
price: this.solPriceCache.price,
source: 'cache',
lastUpdated: this.solPriceCache.lastUpdated
};
}

// Try to get from Redis first (shared cache)
try {
const redisPrice = await this.redis.get('sol_price');
if (redisPrice) {
const cached = JSON.parse(redisPrice);
if (now - cached.lastUpdated < cached.cacheTimeout) {
this.solPriceCache = cached;
this.stats.cacheHits++;
return {
    success: true,
    price: cached.price,
    source: 'redis',
    lastUpdated: cached.lastUpdated
};
}
}
} catch (error) {
console.warn(`[${new Date().toISOString()}] ⚠️ Redis price fetch failed:`, error.message);
}

// Fetch fresh price
const startTime = Date.now();
try {
// Try RPC first
let newPrice;
try {
newPrice = await this.simplifiedTokenService.getSolPrice();
this.stats.rpcRequests++;
} catch (rpcError) {
console.warn(`[${new Date().toISOString()}] ⚠️ RPC SOL price failed, using fallback:`, rpcError.message);

if (this.fallbackEnabled) {
// Fallback to DexScreener
const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
    timeout: 5000,
    headers: { 'Accept': 'application/json' }
});

if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
}

const data = await response.json();

if (data.pairs && data.pairs.length > 0) {
    const bestPair = data.pairs.reduce((prev, current) =>
        (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
    );
    newPrice = parseFloat(bestPair.priceUsd || 150);
    this.stats.fallbackRequests++;
} else {
    throw new Error('No price data found');
}
} else {
throw rpcError;
}
}

this.solPriceCache = {
price: newPrice,
lastUpdated: now,
cacheTimeout: 30000
};

// Cache in Redis
await this.redis.setex('sol_price', 60, JSON.stringify(this.solPriceCache));

const responseTime = Date.now() - startTime;
this.updateAvgResponseTime(responseTime);

return {
success: true,
price: newPrice,
source: 'fresh_rpc',
lastUpdated: now,
responseTime
};

} catch (error) {
console.error(`[${new Date().toISOString()}] ❌ Error fetching fresh SOL price:`, error.message);
this.stats.errors++;

// Return cached price even if expired, better than nothing
return {
success: true,
price: this.solPriceCache.price,
source: 'fallback_cache',
lastUpdated: this.solPriceCache.lastUpdated,
error: error.message
};
}
}

// Enhanced token price fetching with RPC and detailed data
async getTokenPrices(tokenMints) {
if (!tokenMints || tokenMints.length === 0) {
return new Map();
}

const results = new Map();
const uncachedMints = [];
const now = Date.now();

console.log(`[${new Date().toISOString()}] 🔍 Getting prices for ${tokenMints.length} tokens via RPC`);
const startTime = Date.now();

// Check cache first
for (const mint of tokenMints) {
const cached = this.tokenPriceCache.get(mint);
if (cached && (now - cached.timestamp) < 60000) { // 1 minute cache
results.set(mint, cached.data);
this.stats.cacheHits++;
} else {
uncachedMints.push(mint);
}
}

// Fetch uncached prices using enhanced service
if (uncachedMints.length > 0) {
console.log(`[${new Date().toISOString()}] 📡 Fetching ${uncachedMints.length} uncached token prices via RPC`);

try {
// Use simplified token service for batch price fetching
const enhancedPrices = await this.simplifiedTokenService.getTokenPrices(uncachedMints);

for (const [mint, priceData] of enhancedPrices) {
// Convert enhanced service format to our format
const formattedPriceData = {
    price: priceData.priceUsd || 0,
    change24h: 0, // Would need historical data
    volume24h: priceData.volume24h || 0,
    liquidity: priceData.liquidity || 0,
    marketCap: priceData.marketCap || 0,
    pools: priceData.pools || [],
    deployedAt: null, // Will be fetched separately if needed
    ageHours: null,
    source: priceData.source || 'rpc',
    lastUpdated: priceData.lastUpdated || now
};

// Get additional token info if this is a new token
if (priceData.source === 'pools' && priceData.poolCount > 0) {
    try {
        const tokenInfo = await this.enhancedTokenService.getTokenInfo(mint);
        if (tokenInfo.deployedAt) {
            const ageMs = now - new Date(tokenInfo.deployedAt).getTime();
            formattedPriceData.deployedAt = tokenInfo.deployedAt;
            formattedPriceData.ageHours = Math.floor(ageMs / (1000 * 60 * 60));
        }
        formattedPriceData.symbol = tokenInfo.symbol;
        formattedPriceData.name = tokenInfo.name;
    } catch (infoError) {
        console.warn(`[${new Date().toISOString()}] ⚠️ Could not get token info for ${mint}:`, infoError.message);
    }
}

// Cache the result
this.tokenPriceCache.set(mint, {
    data: formattedPriceData,
    timestamp: now
});

results.set(mint, formattedPriceData);
this.stats.rpcRequests++;
}

} catch (rpcError) {
console.warn(`[${new Date().toISOString()}] ⚠️ RPC batch price fetch failed, using fallback:`, rpcError.message);

// Fallback to DexScreener for uncached tokens
if (this.fallbackEnabled) {
const fallbackResults = await this.getFallbackPrices(uncachedMints);
for (const [mint, priceData] of fallbackResults) {
    this.tokenPriceCache.set(mint, {
        data: priceData,
        timestamp: now
    });
    results.set(mint, priceData);
    this.stats.fallbackRequests++;
}
}
}
}

const responseTime = Date.now() - startTime;
this.updateAvgResponseTime(responseTime);

console.log(`[${new Date().toISOString()}] ✅ Token price batch completed in ${responseTime}ms: ${results.size} tokens (${this.stats.cacheHits} from cache, ${uncachedMints.length} fresh)`);

return results;
}

// Fallback to DexScreener for compatibility
async getFallbackPrices(tokenMints) {
const results = new Map();
const BATCH_SIZE = 10;

for (let i = 0; i < tokenMints.length; i += BATCH_SIZE) {
const batch = tokenMints.slice(i, i + BATCH_SIZE);

const batchPromises = batch.map(async (mint) => {
try {
const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    timeout: 5000,
    headers: { 'Accept': 'application/json' }
});

if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
}

const data = await response.json();

let priceData = null;
if (data.pairs && data.pairs.length > 0) {
    const bestPair = data.pairs.reduce((prev, current) =>
        (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
    );
    
    priceData = {
        price: parseFloat(bestPair.priceUsd || 0),
        change24h: parseFloat(bestPair.priceChange?.h24 || 0),
        volume24h: parseFloat(bestPair.volume?.h24 || 0),
        liquidity: parseFloat(bestPair.liquidity?.usd || 0),
        marketCap: parseFloat(bestPair.marketCap || 0),
        pools: [{
            dex: bestPair.dexId,
            address: bestPair.pairAddress,
            liquidity: parseFloat(bestPair.liquidity?.usd || 0)
        }],
        source: 'fallback_dexscreener',
        lastUpdated: Date.now()
    };
    
    // Try to determine token age from pair creation
    if (bestPair.pairCreatedAt) {
        const ageMs = Date.now() - bestPair.pairCreatedAt;
        priceData.ageHours = Math.floor(ageMs / (1000 * 60 * 60));
        priceData.deployedAt = new Date(bestPair.pairCreatedAt);
    }
}

return { mint, data: priceData };
} catch (error) {
console.error(`[${new Date().toISOString()}] ❌ Error fetching fallback price for ${mint}:`, error.message);
return { 
    mint, 
    data: {
        price: 0,
        change24h: 0,
        volume24h: 0,
        liquidity: 0,
        marketCap: 0,
        pools: [],
        source: 'error',
        error: error.message,
        lastUpdated: Date.now()
    }
};
}
});

const batchResults = await Promise.all(batchPromises);
batchResults.forEach(({ mint, data }) => {
if (data) {
results.set(mint, data);
}
});

// Small delay between batches to avoid rate limiting
if (i + BATCH_SIZE < tokenMints.length) {
await new Promise(resolve => setTimeout(resolve, 100));
}
}

return results;
}

// Get comprehensive token data including deployment info
async getTokenInfo(mintAddress) {
try {
console.log(`[${new Date().toISOString()}] 🔍 Getting comprehensive token info for ${mintAddress}`);

const [priceData, tokenInfo] = await Promise.all([
this.enhancedTokenService.getTokenPrice(mintAddress),
this.enhancedTokenService.getTokenInfo(mintAddress)
]);

return {
...tokenInfo,
priceData: {
price: priceData.priceUsd || 0,
volume24h: priceData.volume24h || 0,
liquidity: priceData.liquidity || 0,
marketCap: priceData.marketCap || 0,
pools: priceData.pools || [],
source: priceData.source
},
ageHours: tokenInfo.deployedAt ? 
Math.floor((Date.now() - new Date(tokenInfo.deployedAt).getTime()) / (1000 * 60 * 60)) : 
null
};

} catch (error) {
console.error(`[${new Date().toISOString()}] ❌ Error getting token info for ${mintAddress}:`, error.message);
throw error;
}
}

updateAvgResponseTime(responseTime) {
if (this.stats.avgResponseTime === 0) {
this.stats.avgResponseTime = responseTime;
} else {
this.stats.avgResponseTime = (this.stats.avgResponseTime * 0.9) + (responseTime * 0.1);
}
}

cleanTokenPriceCache() {
if (this.tokenPriceCache.size <= this.maxCacheSize) return;

const now = Date.now();
const entries = Array.from(this.tokenPriceCache.entries());

// Remove expired entries first
const validEntries = entries.filter(([, value]) => 
(now - value.timestamp) < 300000 // 5 minutes
);

// If still too many, keep only the most recent
if (validEntries.length > this.maxCacheSize) {
validEntries.sort((a, b) => b[1].timestamp - a[1].timestamp);
validEntries.length = this.maxCacheSize;
}

// Rebuild cache
this.tokenPriceCache.clear();
validEntries.forEach(([key, value]) => {
this.tokenPriceCache.set(key, value);
});

console.log(`[${new Date().toISOString()}] 🧹 Cleaned token price cache: ${validEntries.length} entries remaining`);
}

// Enhanced statistics including RPC vs fallback usage
getStats() {
const uptime = Date.now() - this.stats.startTime;
const totalRequests = this.stats.rpcRequests + this.stats.fallbackRequests;

return {
service: 'enhanced',
uptime: Math.floor(uptime / 1000),
solPrice: {
current: this.solPriceCache.price,
lastUpdated: this.solPriceCache.lastUpdated,
age: Date.now() - this.solPriceCache.lastUpdated
},
tokenCache: {
size: this.tokenPriceCache.size,
maxSize: this.maxCacheSize,
utilization: Math.round((this.tokenPriceCache.size / this.maxCacheSize) * 100)
},
performance: {
totalRequests,
rpcRequests: this.stats.rpcRequests,
fallbackRequests: this.stats.fallbackRequests,
cacheHits: this.stats.cacheHits,
errors: this.stats.errors,
avgResponseTime: Math.round(this.stats.avgResponseTime),
rpcSuccessRate: totalRequests > 0 ? 
Math.round((this.stats.rpcRequests / totalRequests) * 100) : 0
},
enhancedService: this.enhancedTokenService.getStats()
};
}

async close() {
await this.enhancedTokenService.close();
await this.redis.quit();
console.log(`[${new Date().toISOString()}] ✅ Enhanced Price service closed`);
}
}

module.exports = PriceService;