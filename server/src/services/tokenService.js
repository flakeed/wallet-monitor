const { Connection, PublicKey } = require('@solana/web3.js');
const { TokenListProvider } = require('@solana/spl-token-registry');
const axios = require('axios');
const { Metaplex } = require('@metaplex-foundation/js');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
let tokenMap = new Map();
let solPriceCache = new Map();
const promiseStore = new Map();
const TOKEN_CACHE_TTL = 24 * 60 * 60; // 24 hours
const PRICE_CACHE_TTL = 60 * 60; // 1 hour
const PROMISE_TTL = 2 * 60; // 2 minutes
const REQUEST_DELAY = 50; // 50ms delay between requests
let isProcessingQueue = false;

redis.on('connect', () => {
    console.log(`[${new Date().toISOString()}] ✅ Connected to Redis`);
});
redis.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ❌ Redis connection error:`, err.message);
});

(async () => {
    try {
        const tokens = await new TokenListProvider().resolve();
        const tokenList = tokens.filterByChainId(101).getList();
        console.log(`[${new Date().toISOString()}] ✅ Loaded ${tokenList.length} tokens from SPL token registry`);
        const pipeline = redis.pipeline();
        for (const token of tokenList) {
            pipeline.set(
                `token:${token.address}`,
                JSON.stringify({
                    address: token.address,
                    symbol: token.symbol || 'Unknown',
                    name: token.name || 'Unknown Token',
                    logoURI: token.logoURI || null,
                    decimals: token.decimals || 0
                }),
                'EX',
                TOKEN_CACHE_TTL
            );
        }
        await pipeline.exec();
        console.log(`[${new Date().toISOString()}] ✅ Stored ${tokenList.length} tokens in Redis`);
        await redis.del('helius:queue');
        console.log(`[${new Date().toISOString()}] ✅ Cleared stale Helius queue`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Failed to load SPL token registry:`, error.message);
    }
})();

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (true) {
        const requestData = await redis.rpop('helius:queue');
        if (!requestData) break;
        let request;
        try {
            request = JSON.parse(requestData);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, error.message);
            continue;
        }
        const { requestId, mint, connection: rpcEndpoint } = request;
        const connection = new Connection(rpcEndpoint, 'confirmed');
        console.log(`[${new Date().toISOString()}] 🔄 Processing Helius request ${requestId} for mint ${mint}`);
        try {
            const result = await processHeliusRequest(mint, connection);
            const promise = promiseStore.get(requestId);
            if (promise) {
                promise.resolve(result);
            } else {
                console.warn(`[${new Date().toISOString()}] ⚠️ No promise found for request ${requestId}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing Helius request ${requestId} for mint ${mint}:`, error.message);
            const promise = promiseStore.get(requestId);
            if (promise) {
                promise.reject(error);
            }
        }
        promiseStore.delete(requestId);
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
    isProcessingQueue = false;
    const queueLength = await redis.llen('helius:queue');
    if (queueLength > 0) {
        setImmediate(processQueue);
    }
}

async function processHeliusRequest(mint, connection) {
    const cachedToken = await redis.get(`token:${mint}`);
    if (cachedToken) {
        console.log(`[${new Date().toISOString()}] ✅ Using Redis cached metadata for mint ${mint}`);
        return JSON.parse(cachedToken);
    }
    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    if (!HELIUS_API_KEY) {
        console.warn(`[${new Date().toISOString()}] ⚠️ HELIUS_API_KEY not set — falling back to on-chain metadata`);
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || {
            address: mint,
            symbol: 'Unknown',
            name: 'Unknown Token',
            logoURI: null,
            decimals: 0
        };
        await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
        return data;
    }
    try {
        console.log(`[${new Date().toISOString()}] 🔍 Fetching metadata for mint: ${mint} via Helius API`);
        const response = await axios.post(
            `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
            { mintAccounts: [mint] },
            { timeout: 5000 }
        );
        if (response.data && response.data.length > 0) {
            const meta = response.data[0];
            let logoURI = null;
            const metadataUri = meta?.onChainMetadata?.metadata?.data?.uri;
            if (metadataUri) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const uriResponse = await axios.get(metadataUri, {
                        timeout: 3000,
                        responseType: 'json',
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (compatible; TokenMetadata/1.0)'
                        }
                    });
                    if (uriResponse.data && uriResponse.data.image) {
                        logoURI = normalizeImageUrl(uriResponse.data.image);
                        console.log(`[${new Date().toISOString()}] ✅ Found logo for mint ${mint}: ${logoURI}`);
                    }
                } catch (uriError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to fetch logo from URI for mint ${mint}:`, uriError.message);
                }
            }
            const tokenData = {
                address: mint,
                symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
                name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
                decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 0,
                logoURI: logoURI || null
            };
            await redis.set(`token:${mint}`, JSON.stringify(tokenData), 'EX', TOKEN_CACHE_TTL);
            return tokenData;
        }
        console.warn(`[${new Date().toISOString()}] ⚠️ No metadata found for mint ${mint} in Helius API, trying on-chain`);
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || {
            address: mint,
            symbol: 'Unknown',
            name: 'Unknown Token',
            logoURI: null,
            decimals: 0
        };
        await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
        return data;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error fetching Helius metadata for mint ${mint}:`, error.message);
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || {
            address: mint,
            symbol: 'Unknown',
            name: 'Unknown Token',
            logoURI: null,
            decimals: 0
        };
        await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
        return data;
    }
}

async function fetchOnChainMetadata(mint, connection) {
    try {
        const metaplex = Metaplex.make(connection);
        const mintPubkey = new PublicKey(mint);
        const metadataAccount = await metaplex.nfts().pdas().metadata({ mint: mintPubkey });
        const accountInfo = await connection.getAccountInfo(metadataAccount);
        if (!accountInfo) {
            console.warn(`[${new Date().toISOString()}] ⚠️ No on-chain metadata account found for mint ${mint}`);
            return null;
        }
        const metadata = metaplex.nfts().decodeMetadata(accountInfo.data);
        let logoURI = null;
        if (metadata.uri) {
            try {
                await new Promise(resolve => setTimeout(resolve, 100));
                const response = await axios.get(metadata.uri, {
                    timeout: 3000,
                    responseType: 'json',
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (compatible; TokenMetadata/1.0)'
                    }
                });
                if (response.data && response.data.image) {
                    logoURI = normalizeImageUrl(response.data.image);
                    console.log(`[${new Date().toISOString()}] ✅ Found on-chain logo for mint ${mint}: ${logoURI}`);
                }
            } catch (uriError) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Failed to fetch on-chain logo for mint ${mint}:`, uriError.message);
            }
        }
        return {
            address: mint,
            symbol: metadata.symbol || 'Unknown',
            name: metadata.name || 'Unknown Token',
            logoURI: logoURI || null,
            decimals: 0 // Note: On-chain metadata may not provide decimals; default to 0
        };
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error fetching on-chain metadata for mint ${mint}:`, error.message);
        return null;
    }
}

function normalizeImageUrl(url) {
    if (!url) return null;
    if (url.startsWith('ipfs://')) {
        return `https://ipfs.io/ipfs/${url.slice(7)}`;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return `https://${url}`;
    }
    return url;
}

async function fetchTokenMetadata(mint, connection) {
    const requestId = uuidv4();
    const promise = new Promise((resolve, reject) => {
        promiseStore.set(requestId, { resolve, reject });
        setTimeout(() => {
            if (promiseStore.has(requestId)) {
                promiseStore.delete(requestId);
                reject(new Error(`Request ${requestId} timed out`));
            }
        }, PROMISE_TTL * 1000);
    });
    await redis.lpush('helius:queue', JSON.stringify({
        requestId,
        mint,
        connection: connection.rpcEndpoint
    }));
    if (!isProcessingQueue) {
        setImmediate(processQueue);
    }
    return promise;
}

async function fetchHistoricalSolPrice(date) {
    const cacheKey = `solprice:${date.toISOString().slice(0, 13)}`;
    const cachedPrice = await redis.get(cacheKey);
    if (cachedPrice) {
        console.log(`[${new Date().toISOString()}] ✅ Using cached SOL price for ${cacheKey}`);
        return parseFloat(cachedPrice);
    }
    try {
        const timestamp = Math.floor(date.getTime() / 1000);
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/coins/solana/history`,
            {
                params: {
                    date: new Date(timestamp * 1000).toLocaleDateString('en-GB').split('/').reverse().join('-'),
                    localization: false
                },
                timeout: 5000
            }
        );
        const price = response.data?.market_data?.current_price?.usd || 100; // Fallback to $100 if API fails
        await redis.set(cacheKey, price, 'EX', PRICE_CACHE_TTL);
        console.log(`[${new Date().toISOString()}] ✅ Fetched SOL price for ${cacheKey}: $${price}`);
        return price;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price for ${date.toISOString()}:`, error.message);
        const fallbackPrice = 100;
        await redis.set(cacheKey, fallbackPrice, 'EX', PRICE_CACHE_TTL);
        return fallbackPrice;
    }
}

module.exports = {
    redis,
    fetchTokenMetadata,
    fetchHistoricalSolPrice
};