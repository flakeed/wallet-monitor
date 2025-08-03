const { Connection, PublicKey } = require('@solana/web3.js');
const { TokenListProvider } = require('@solana/spl-token-registry');
const axios = require('axios');
const { Metaplex } = require('@metaplex-foundation/js');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
let tokenMap = new Map();
let solPriceCache = new Map();

const requestQueue = [];
let isProcessingQueue = false;

const redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');

redis.on('connect', () => {
    console.log(`[${new Date().toISOString()}] ✅ Connected to Redis`);
});
redis.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ❌ Redis connection error:`, err.message);
});

const promiseStore = new Map();

const REQUEST_DELAY = 100; 
const TOKEN_CACHE_TTL = 24 * 60 * 60;
const PRICE_CACHE_TTL = 60 * 60; 
const PROMISE_TTL = 2 * 60; 
let lastPriceRequest = 0;
const PRICE_REQUEST_DELAY = 200; 

(async () => {
    try {
        const tokens = await new TokenListProvider().resolve();
        const tokenList = tokens.filterByChainId(101).getList();
        console.log(`[${new Date().toISOString()}] ✅ Loaded ${tokenList.length} tokens from registry`);

        const pipeline = redis.pipeline();
        for (const token of tokenList) {
            pipeline.set(
                `token:${token.address}`,
                JSON.stringify(token),
                'EX',
                TOKEN_CACHE_TTL
            );
        }
        await pipeline.exec();
        console.log(`[${new Date().toISOString()}] ✅ Stored ${tokenList.length} tokens in Redis`);

        await redis.del('helius:queue');
        console.log(`[${new Date().toISOString()}] ✅ Cleared stale Helius queue`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Failed to load token registry:`, e.message);
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
        } catch (e) {
            console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, e.message);
            continue;
        }

        const { requestId, mint, connection: rpcEndpoint } = request;
const connection = new Connection( process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', 'confirmed');
        console.log(`[${new Date().toISOString()}] Processing Helius request ${requestId} for mint ${mint}`);

        try {
            const result = await processHeliusRequest(mint, connection);
            const promise = promiseStore.get(requestId);
            if (promise) {
                promise.resolve(result);
            } else {
                console.warn(`[${new Date().toISOString()}] No promise found for request ${requestId}`);
            }
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error processing Helius request ${requestId} for mint ${mint}:`, error.message);
            const promise = promiseStore.get(requestId);
            if (promise) {
                promise.reject(error);
            }
        }

        promiseStore.delete(requestId);
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
    isProcessingQueue = false;

    redis.llen('helius:queue', (err, length) => {
        if (err) {
            console.error(`[${new Date().toISOString()}] Error checking queue length:`, err.message);
            return;
        }
        if (length > 0) {
            setImmediate(processQueue);
        }
    });
}

async function processHeliusRequest(mint, connection) {
    const cachedToken = await redis.get(`token:${mint}`);
    if (cachedToken) {
        console.log(`[${new Date().toISOString()}] Using Redis cached metadata for mint ${mint}`);
        return JSON.parse(cachedToken);
    }

    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    if (!HELIUS_API_KEY) {
        console.warn(`[${new Date().toISOString()}] HELIUS_API_KEY not set — trying on-chain metadata`);
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
        await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
        return data;
    }

    try {
        console.log(`[${new Date().toISOString()}] Fetching metadata for mint: ${mint}`);
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
                    } else {
                        console.warn(`[${new Date().toISOString()}] ❌ No image field found in metadata for mint ${mint}`);
                    }
                } catch (uriError) {
                    console.warn(`[${new Date().toISOString()}] Failed to fetch logo from URI for mint ${mint}:`, uriError.message);
                    if (uriError.response?.status === 403) {
                        try {
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const retryResponse = await axios.get(metadataUri, {
                                timeout: 3000,
                                responseType: 'json',
                                headers: {
                                    'Accept': '*/*',
                                    'User-Agent': 'curl/7.68.0'
                                }
                            });

                            if (retryResponse.data && retryResponse.data.image) {
                                logoURI = normalizeImageUrl(retryResponse.data.image);
                                console.log(`[${new Date().toISOString()}] ✅ Found logo on retry for mint ${mint}: ${logoURI}`);
                            }
                        } catch (retryError) {
                            console.warn(`[${new Date().toISOString()}] Retry also failed for mint ${mint}:`, retryError.message);
                        }
                    }
                }
            }

            const tokenData = {
                address: mint,
                symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
                name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
                decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 0,
                logoURI: logoURI || null,
            };

            await redis.set(`token:${mint}`, JSON.stringify(tokenData), 'EX', TOKEN_CACHE_TTL);
            return tokenData;
        }

        console.warn(`[${new Date().toISOString()}] No metadata found for mint ${mint} in Helius API`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Helius API error for mint ${mint}:`, e.response?.data || e.message);
    }

    const onChainData = await fetchOnChainMetadata(mint, connection);
    const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
    await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
    return data;
}

async function fetchTokenMetadata(mint, connection) {
    // СНАЧАЛА ПРОВЕРЯЕМ КЕШИ для моментального ответа
    const cachedToken = await redis.get(`token:${mint}`);
    if (cachedToken) {
        console.log(`[${new Date().toISOString()}] ⚡ Fast cache hit for mint ${mint}`);
        return JSON.parse(cachedToken);
    }

    return new Promise((resolve, reject) => {
        const requestId = uuidv4();
        console.log(`[${new Date().toISOString()}] Enqueued Helius request ${requestId} for mint ${mint}`);

        promiseStore.set(requestId, { resolve, reject });

        redis.lpush('helius:queue', JSON.stringify({
            requestId,
            mint,
            connection: connection.rpcEndpoint,
        }), (err) => {
            if (err) {
                console.error(`[${new Date().toISOString()}] Error enqueuing request ${requestId}:`, err.message);
                promiseStore.delete(requestId);
                reject(err);
                return;
            }

            if (!isProcessingQueue) {
                setImmediate(processQueue);
            }
        });

        setTimeout(() => {
            if (promiseStore.has(requestId)) {
                console.warn(`[${new Date().toISOString()}] Cleaning up stale promise for request ${requestId}`);
                promiseStore.delete(requestId);
                reject(new Error(`Request ${requestId} timed out`));
            }
        }, PROMISE_TTL * 1000);
    });
}

async function fetchHistoricalSolPrice(timestamp) {
    const cacheKey = `solprice:${timestamp.toISOString().slice(0, 16)}`;
    const cachedPrice = await redis.get(cacheKey);
    if (cachedPrice) {
        console.log(`[${new Date().toISOString()}] ⚡ Fast SOL price cache hit for ${cacheKey}: $${cachedPrice}`);
        return parseFloat(cachedPrice);
    }

    const time_now = Date.now();
    if (time_now - lastPriceRequest < PRICE_REQUEST_DELAY) {
        await new Promise(resolve => setTimeout(resolve, PRICE_REQUEST_DELAY));
    }
    lastPriceRequest = Date.now();

    try {
        const time = timestamp.getTime();
        console.log(`[${new Date().toISOString()}] Fetching historical SOL price for ${cacheKey}`);
        
        // ПАРАЛЛЕЛЬНО запрашиваем текущую и историческую цены
        const [historicalResponse, currentResponse] = await Promise.allSettled([
            axios.get(
                `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime=${time}&endTime=${time + 60000}`,
                { timeout: 5000 }
            ),
            axios.get(
                `https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT`,
                { timeout: 5000 }
            )
        ]);

        let price = null;

        if (historicalResponse.status === 'fulfilled' && 
            historicalResponse.value.data && 
            historicalResponse.value.data.length > 0) {
            price = parseFloat(historicalResponse.value.data[0][4]);
            console.log(`[${new Date().toISOString()}] ✅ Got historical SOL price: $${price}`);
        } else if (currentResponse.status === 'fulfilled' && currentResponse.value.data) {
            price = parseFloat(currentResponse.value.data.price);
            console.log(`[${new Date().toISOString()}] ✅ Using current SOL price: $${price}`);
        }

        if (price) {
            await redis.set(cacheKey, price, 'EX', PRICE_CACHE_TTL);
            return price;
        }

        console.warn(`[${new Date().toISOString()}] No price data available for ${cacheKey}`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Error fetching SOL price for ${cacheKey}:`, e.message);
    }

    console.warn(`[${new Date().toISOString()}] Using fallback price for ${cacheKey}`);
    const fallbackPrice = 180;
    await redis.set(cacheKey, fallbackPrice, 'EX', PRICE_CACHE_TTL);
    return fallbackPrice;
}

async function fetchOnChainMetadata(mint, connection) {
    try {
        const metaplex = new Metaplex(connection);
        const mintPubkey = new PublicKey(mint);
        const metadataAccount = await metaplex.nfts().findByMint({ mintAddress: mintPubkey });
        if (metadataAccount && metadataAccount.data) {
            return {
                address: mint,
                symbol: metadataAccount.data.symbol || 'Unknown',
                name: metadataAccount.data.name || 'Unknown Token',
                logoURI: metadataAccount.data.uri || null,
                decimals: metadataAccount.mint.decimals || 0,
            };
        }
        console.warn(`[${new Date().toISOString()}] No on-chain metadata found for mint ${mint}`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Error fetching on-chain metadata for mint ${mint}:`, e.message);
    }
    return null;
}

function normalizeImageUrl(imageUrl) {
    if (!imageUrl) return null;
    if (imageUrl.startsWith('ipfs://')) {
        return imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }
    return imageUrl;
}

async function getPurchasesTransactions(walletAddress, connection) {
    const pubkey = new PublicKey(walletAddress);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 });
    const purchasesTxs = [];
    const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

    for (const sig of signatures) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] Skipping invalid signature: ${sig.signature || 'unknown'} - missing blockTime`);
                continue;
            }

            const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] Skipping transaction ${sig.signature} - invalid or missing metadata`);
                continue;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            if (solChange >= 0) continue;

            const tokenChangesRaw = [];
            (tx.meta.postTokenBalances || []).forEach((post, i) => {
                const pre = tx.meta.preTokenBalances?.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
                if (!pre) {
                    console.warn(`[${new Date().toISOString()}] No pre-balance for post ${i}:`, post);
                    return;
                }
                const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount); 
                const uiChange = Number(post.uiTokenAmount.uiAmount) - Number(pre.uiTokenAmount.uiAmount);
                console.log(`[${new Date().toISOString()}] Mint ${post.mint}: pre=${pre.uiTokenAmount.uiAmount}, post=${post.uiTokenAmount.uiAmount}, uiChange=${uiChange}, rawChange=${rawChange}`);
                if (uiChange <= 0) return;
                if (post.mint === WRAPPED_SOL_MINT) return;
                tokenChangesRaw.push({
                    mint: post.mint,
                    rawChange: rawChange,
                    uiChange: uiChange,  
                    decimals: post.uiTokenAmount.decimals,
                });
            });

            if (tokenChangesRaw.length === 0) continue;

            const tokensBought = [];
            for (const t of tokenChangesRaw) {
                const tokenInfo = await fetchTokenMetadata(t.mint, connection);
                if (!tokenInfo) {
                    console.warn(`[${new Date().toISOString()}] Skipping token ${t.mint} - no metadata available, using fallback`);
                    tokensBought.push({
                        mint: t.mint,
                        symbol: 'Unknown',
                        name: 'Unknown Token',
                        logoURI: null,
                        amount: t.uiChange, 
                        decimals: t.decimals,
                    });
                    continue;
                }
                if (tokenInfo.decimals !== t.decimals) {
                    console.warn(`[${new Date().toISOString()}] Decimals mismatch for ${t.mint}: tokenInfo=${tokenInfo.decimals}, raw=${t.decimals}`);
                }
                tokensBought.push({
                    mint: t.mint,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    logoURI: tokenInfo.logoURI,
                    amount: t.uiChange, 
                    decimals: tokenInfo.decimals,
                });
            }

            if (tokensBought.length === 0) {
                console.warn(`[${new Date().toISOString()}] Skipping transaction ${sig.signature} - no valid tokens bought`);
                continue;
            }

            let solPrice;
            try {
                solPrice = await fetchHistoricalSolPrice(new Date(sig.blockTime * 1000));
            } catch (error) {
                console.warn(`[${new Date().toISOString()}] Using fallback SOL price for transaction ${sig.signature}`);
                solPrice = 180; 
            }
            
            const spentSOL = +(-solChange).toFixed(6);
            const spentUSD = +(solPrice * spentSOL).toFixed(2);

            purchasesTxs.push({
                signature: sig.signature,
                time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
                spentSOL,
                spentUSD,
                tokensBought,
            });
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Error fetching tx ${sig.signature || 'unknown'}:`, e.message);
        }
        await new Promise((res) => setTimeout(res, 300));
    }
    return purchasesTxs;
}

async function getWalletData(address, publicKey, connection) {
    const balanceLamports = await connection.getBalance(publicKey);
    const balanceSol = balanceLamports / 1e9;
    const purchases = await getPurchasesTransactions(address, connection);

    return {
        address,
        balance: Number(balanceSol).toLocaleString(undefined, { maximumFractionDigits: 6 }),
        purchases: purchases || [],
    };
}

module.exports = {
    fetchHistoricalSolPrice,
    fetchOnChainMetadata,
    normalizeImageUrl,
    fetchTokenMetadata,
    getPurchasesTransactions,
    getWalletData,
    redis,
};