const { Connection, PublicKey } = require('@solana/web3.js');
const { TokenListProvider } = require('@solana/spl-token-registry');
const axios = require('axios');
const { Metaplex } = require('@metaplex-foundation/js');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const { default: pLimit } = require('p-limit');


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
const TOKEN_CACHE_TTL = 7 * 24 * 60 * 60; 
const PROMISE_TTL = 60;
const RPS_LIMIT = 10; 
const limit = pLimit(RPS_LIMIT); 
const BATCH_SIZE = 500; 

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
        const requestData = await redis.lpop('helius:queue', BATCH_SIZE);
        if (!requestData || requestData.length === 0) break;

        const requests = requestData
            .map((data) => {
                try {
                    return JSON.parse(data);
                } catch (e) {
                    console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, e.message);
                    return null;
                }
            })
            .filter((req) => req !== null);

        const subBatchSize = Math.floor(1000 / RPS_LIMIT);
        for (let i = 0; i < requests.length; i += subBatchSize) {
            const subBatch = requests.slice(i, i + subBatchSize);
            await Promise.allSettled(
                subBatch.map((request) =>
                    limit(async () => {
                        const { requestId, mint, connection: rpcEndpoint } = request;
                        const connection = new Connection(rpcEndpoint, 'confirmed');
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
                    })
                )
            );
            await new Promise((resolve) => setTimeout(resolve, 1000 / RPS_LIMIT));
        }
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY));
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
        console.log(`[${new Date().toISOString()}] Using Redis cached metadata for mint ${mint}`);
        return JSON.parse(cachedToken);
    }

    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    if (!HELIUS_API_KEY) {
        console.warn(`[${new Date().toISOString()}] HELIUS_API_KEY not set — trying on-chain metadata`);
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', decimals: 0 };
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
            const tokenData = {
                address: mint,
                symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
                name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
                decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 0,
            };

            await redis.set(`token:${mint}`, JSON.stringify(tokenData), 'EX', TOKEN_CACHE_TTL);
            return tokenData;
        }

        console.warn(`[${new Date().toISOString()}] No metadata found for mint ${mint} in Helius API`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Helius API error for mint ${mint}:`, e.response?.data || e.message);
    }

    const onChainData = await fetchOnChainMetadata(mint, connection);
    const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', decimals: 0 };
    await redis.set(`token:${mint}`, JSON.stringify(data), 'EX', TOKEN_CACHE_TTL);
    return data;
}

async function fetchTokenMetadata(mint, connection) {
    const cachedToken = await redis.get(`token:${mint}`);
    if (cachedToken) {
        console.log(`[${new Date().toISOString()}] ⚡ Fast cache hit for mint ${mint}`);
        return JSON.parse(cachedToken);
    }

    return new Promise((resolve, reject) => {
        const requestId = uuidv4();
        const requestKey = `request:${requestId}`;
        redis.get(requestKey).then(async (exists) => {
            if (exists) {
                console.log(`[${new Date().toISOString()}] Skipping duplicate request ${requestId} for mint ${mint}`);
                reject(new Error('Duplicate request'));
                return;
            }

            await redis.set(requestKey, '1', 'EX', 60);
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
    });
}

async function getParsedTransactionCached(signature, connection) {
    const cacheKey = `tx:${signature}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log(`[${new Date().toISOString()}] ⚡ Fast transaction cache hit for ${signature}`);
        return JSON.parse(cached);
    }

    const tx = await limit(() =>
        connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        })
    );
    if (tx) {
        await redis.set(cacheKey, JSON.stringify(tx), 'EX', 3600);
    }
    return tx;
}

async function batchFetchTokenMetadata(mints) {
    const tokenInfos = new Map();
    const uncachedMints = [];
    const pipeline = redis.pipeline();

    for (const mint of mints) {
        pipeline.get(`token:${mint}`);
    }
    const results = await pipeline.exec();

    results.forEach(([err, cachedToken], index) => {
        if (!err && cachedToken) {
            tokenInfos.set(mints[index], JSON.parse(cachedToken));
        } else {
            uncachedMints.push(mints[index]);
        }
    });

    if (uncachedMints.length > 0) {
        const batchSize = 50; 
        for (let i = 0; i < uncachedMints.length; i += batchSize) {
            const batch = uncachedMints.slice(i, i + batchSize);
            try {
                const batchResults = await axios.post(
                    `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_API_KEY}`,
                    { mintAccounts: batch },
                    { timeout: 5000 }
                );
                const batchTokens = batchResults.data.map((meta) => ({
                    address: meta.account,
                    symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
                    name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
                    decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 0,
                }));

                const pipeline = redis.pipeline();
                batchTokens.forEach((tokenInfo) => {
                    tokenInfos.set(tokenInfo.address, tokenInfo);
                    pipeline.set(`token:${tokenInfo.address}`, JSON.stringify(tokenInfo), 'EX', TOKEN_CACHE_TTL);
                });
                await pipeline.exec();
            } catch (e) {
                console.error(`[${new Date().toISOString()}] Error fetching batch metadata:`, e.message);
                await Promise.all(
                    batch.map(async (mint) => {
                        const tokenInfo = await fetchTokenMetadata(mint, this.connection);
                        if (tokenInfo) {
                            tokenInfos.set(mint, tokenInfo);
                        }
                    })
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 1000 / RPS_LIMIT));
        }
    }

    return tokenInfos;
}

async function getPurchasesTransactions(walletAddress, connection) {
    const pubkey = new PublicKey(walletAddress);
    const signatures = await limit(() =>
        connection.getSignaturesForAddress(pubkey, { limit: 20 })
    );
    const purchasesTxs = [];
    const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

    const signatureList = signatures.map((sig) => sig.signature);
    const transactionBatches = [];
    for (let i = 0; i < signatureList.length; i += RPS_LIMIT) {
        transactionBatches.push(signatureList.slice(i, i + RPS_LIMIT));
    }

    for (const batch of transactionBatches) {
        const transactions = await limit(() =>
            connection.getParsedTransactions(batch, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
            })
        );

        const pipeline = redis.pipeline();
        transactions.forEach((tx, index) => {
            if (tx) {
                pipeline.set(`tx:${batch[index]}`, JSON.stringify(tx), 'EX', 3600);
            }
        });
        await pipeline.exec();

        for (const [index, tx] of transactions.entries()) {
            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] Skipping transaction ${batch[index]} - invalid or missing metadata`);
                continue;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            if (solChange >= 0) continue;

            const tokenChangesRaw = [];
            (tx.meta.postTokenBalances || []).forEach((post, i) => {
                const pre = tx.meta.preTokenBalances?.find((p) => p.mint === post.mint && p.accountIndex === post.accountIndex);
                if (!pre) return;
                const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
                const uiChange = Number(post.uiTokenAmount.uiAmount) - Number(pre.uiTokenAmount.uiAmount);
                if (uiChange <= 0 || post.mint === WRAPPED_SOL_MINT) return;
                tokenChangesRaw.push({
                    mint: post.mint,
                    rawChange,
                    uiChange,
                    decimals: post.uiTokenAmount.decimals,
                });
            });

            if (tokenChangesRaw.length === 0) continue;

            const tokensBought = [];
            const mints = tokenChangesRaw.map((t) => t.mint);
            const tokenInfos = await batchFetchTokenMetadata(mints);
            for (const t of tokenChangesRaw) {
                const tokenInfo = tokenInfos.get(t.mint) || {
                    mint: t.mint,
                    symbol: 'Unknown',
                    name: 'Unknown Token',
                    decimals: t.decimals,
                };
                tokensBought.push({
                    mint: t.mint,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    amount: t.uiChange,
                    decimals: tokenInfo.decimals,
                });
            }

            if (tokensBought.length === 0) {
                console.warn(`[${new Date().toISOString()}] Skipping transaction ${batch[index]} - no valid tokens bought`);
                continue;
            }

            const spentSOL = +(-solChange).toFixed(6);

            purchasesTxs.push({
                signature: batch[index],
                time: signatures[index].blockTime ? new Date(signatures[index].blockTime * 1000).toISOString() : null,
                spentSOL,
                tokensBought,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 / RPS_LIMIT));
    }

    return purchasesTxs;
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
                decimals: metadataAccount.mint.decimals || 0,
            };
        }
        console.warn(`[${new Date().toISOString()}] No on-chain metadata found for mint ${mint}`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Error fetching on-chain metadata for mint ${mint}:`, e.message);
    }
    return null;
}

module.exports = {
    fetchOnChainMetadata,
    fetchTokenMetadata,
    getPurchasesTransactions,
    redis,
    batchFetchTokenMetadata,
};