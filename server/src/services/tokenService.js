const { Connection, PublicKey } = require('@solana/web3.js');
const { TokenListProvider } = require('@solana/spl-token-registry');
const axios = require('axios');
const { Metaplex } = require('@metaplex-foundation/js');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const zlib = require('zlib');
const util = require('util');
const pLimit = require('p-limit');

const compress = util.promisify(zlib.deflate);
const decompress = util.promisify(zlib.inflate);

const redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
const limit = pLimit(10); // Ограничение на 10 параллельных задач
const TOKEN_CACHE_TTL = 24 * 60 * 60;
const PRICE_CACHE_TTL = 24 * 60 * 60;
const PROMISE_TTL = 2 * 60;
let lastPriceRequest = 0;
const PRICE_REQUEST_DELAY = 200;

redis.on('connect', () => {
  console.log(`[${new Date().toISOString()}] ✅ Connected to Redis`);
});
redis.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ Redis connection error:`, err.message);
});

const promiseStore = new Map();
let isProcessingQueue = false;

(async () => {
  try {
    const tokens = await new TokenListProvider().resolve();
    const tokenList = tokens.filterByChainId(101).getList();
    console.log(`[${new Date().toISOString()}] ✅ Loaded ${tokenList.length} tokens from registry`);

    const pipeline = redis.pipeline();
    for (const token of tokenList) {
      const data = JSON.stringify(token);
      const compressed = await compress(data);
      pipeline.set(`token:${token.address}`, compressed, 'EX', TOKEN_CACHE_TTL);
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

    const { requestId, mints, connection: rpcEndpoint } = request;
    const connection = new Connection(rpcEndpoint || process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', 'confirmed');
    console.log(`[${new Date().toISOString()}] Processing Helius request ${requestId} for ${mints.length} mints`);

    try {
      const result = await processHeliusRequest(mints, connection);
      const promise = promiseStore.get(requestId);
      if (promise) {
        promise.resolve(result);
      } else {
        console.warn(`[${new Date().toISOString()}] No promise found for request ${requestId}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing Helius request ${requestId}:`, error.message);
      const promise = promiseStore.get(requestId);
      if (promise) {
        promise.reject(error);
      }
    }

    promiseStore.delete(requestId);
    await new Promise(resolve => setTimeout(resolve, 100));
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

async function processHeliusRequest(mints, connection) {
  const cachedTokens = {};
  const uncachedMints = [];

  for (const mint of mints) {
    const cached = await redis.getBuffer(`token:${mint}`);
    if (cached) {
      const decompressed = await decompress(cached);
      cachedTokens[mint] = JSON.parse(decompressed.toString());
      console.log(`[${new Date().toISOString()}] Using Redis cached metadata for mint ${mint}`);
    } else {
      uncachedMints.push(mint);
    }
  }

  if (uncachedMints.length === 0) return cachedTokens;

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_API_KEY) {
    console.warn(`[${new Date().toISOString()}] HELIUS_API_KEY not set — trying on-chain metadata`);
    await Promise.all(uncachedMints.map(mint =>
      limit(async () => {
        const onChainData = await fetchOnChainMetadata(mint, connection);
        cachedTokens[mint] = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
        const data = JSON.stringify(cachedTokens[mint]);
        const compressed = await compress(data);
        await redis.set(`token:${mint}`, compressed, 'EX', TOKEN_CACHE_TTL);
      })
    ));
    return cachedTokens;
  }

  try {
    console.log(`[${new Date().toISOString()}] Fetching metadata for ${uncachedMints.length} mints`);
    const response = await axios.post(
      `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
      { mintAccounts: uncachedMints },
      { timeout: 10000 }
    );

    await Promise.all(response.data.map(meta =>
      limit(async () => {
        const mint = meta.account;
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

        cachedTokens[mint] = {
          address: mint,
          symbol: meta.onChainMetadata?.metadata?.data?.symbol || 'Unknown',
          name: meta.onChainMetadata?.metadata?.data?.name || 'Unknown Token',
          decimals: meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info?.decimals || 0,
          logoURI: logoURI || null,
        };

        const data = JSON.stringify(cachedTokens[mint]);
        const compressed = await compress(data);
        await redis.set(`token:${mint}`, compressed, 'EX', TOKEN_CACHE_TTL);
      })
    ));
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Helius API error:`, e.response?.data || e.message);
    await Promise.all(uncachedMints.map(mint =>
      limit(async () => {
        const onChainData = await fetchOnChainMetadata(mint, connection);
        cachedTokens[mint] = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
        const data = JSON.stringify(cachedTokens[mint]);
        const compressed = await compress(data);
        await redis.set(`token:${mint}`, compressed, 'EX', TOKEN_CACHE_TTL);
      })
    ));
  }

  return cachedTokens;
}

async function fetchTokenMetadata(mints, connection) {
  const cachedTokens = await processHeliusRequest(mints, connection);
  if (Object.keys(cachedTokens).length === mints.length) {
    console.log(`[${new Date().toISOString()}] ⚡ Fast cache hit for all ${mints.length} mints`);
    return cachedTokens;
  }

  return new Promise((resolve, reject) => {
    const requestId = uuidv4();
    console.log(`[${new Date().toISOString()}] Enqueued Helius request ${requestId} for ${mints.length} mints`);

    promiseStore.set(requestId, { resolve, reject });

    redis.lpush('helius:queue', JSON.stringify({
      requestId,
      mints,
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

async function fetchHistoricalSolPrice(timestamps) {
  const results = {};
  const uncachedTimestamps = [];

  for (const timestamp of timestamps) {
    const cacheKey = `solprice:${timestamp.toISOString().slice(0, 16)}`;
    const cachedPrice = await redis.get(cacheKey);
    if (cachedPrice) {
      console.log(`[${new Date().toISOString()}] ⚡ Fast SOL price cache hit for ${cacheKey}: $${cachedPrice}`);
      results[timestamp.getTime()] = parseFloat(cachedPrice);
    } else {
      uncachedTimestamps.push(timestamp);
    }
  }

  if (uncachedTimestamps.length === 0) return results;

  try {
    const now = Date.now();
    if (now - lastPriceRequest < PRICE_REQUEST_DELAY) {
      await new Promise(resolve => setTimeout(resolve, PRICE_REQUEST_DELAY));
    }
    lastPriceRequest = Date.now();

    const requests = uncachedTimestamps.map(ts =>
      limit(() =>
        axios.get(
          `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime=${ts.getTime()}&endTime=${ts.getTime() + 60000}`,
          { timeout: 5000 }
        )
      )
    );
    const responses = await Promise.allSettled(requests);

    await Promise.all(uncachedTimestamps.map(async (ts, i) => {
      const cacheKey = `solprice:${ts.toISOString().slice(0, 16)}`;
      let price = 180; // Fallback price
      if (responses[i].status === 'fulfilled' && responses[i].value.data?.length > 0) {
        price = parseFloat(responses[i].value.data[0][4]);
        console.log(`[${new Date().toISOString()}] ✅ Got historical SOL price: $${price}`);
      } else {
        console.warn(`[${new Date().toISOString()}] No price data from Binance for ${cacheKey}, trying CoinGecko`);
        try {
          const date = ts.toISOString().slice(0, 10);
          const response = await axios.get(
            `https://api.coingecko.com/api/v3/coins/solana/history?date=${date.replace(/-/g, '-')}`,
            { timeout: 5000 }
          );
          price = response.data.market_data.current_price.usd;
          console.log(`[${new Date().toISOString()}] ✅ Got CoinGecko price: $${price}`);
        } catch (cgError) {
          console.warn(`[${new Date().toISOString()}] CoinGecko fallback failed for ${cacheKey}:`, cgError.message);
        }
      }
      results[ts.getTime()] = price;
      await redis.set(cacheKey, price, 'EX', PRICE_CACHE_TTL);
    }));
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Error fetching SOL prices:`, e.message);
    for (const ts of uncachedTimestamps) {
      results[ts.getTime()] = 180;
      await redis.set(`solprice:${ts.toISOString().slice(0, 16)}`, 180, 'EX', PRICE_CACHE_TTL);
    }
  }

  return results;
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

  const timestamps = signatures
    .filter(sig => sig.blockTime)
    .map(sig => new Date(sig.blockTime * 1000));
  const solPrices = await fetchHistoricalSolPrice(timestamps);

  await Promise.all(signatures.map(async (sig) => {
    try {
      if (!sig.signature || !sig.blockTime) {
        console.warn(`[${new Date().toISOString()}] Skipping invalid signature: ${sig.signature || 'unknown'}`);
        return;
      }

      const cacheKey = `tx:${sig.signature}`;
      const cachedTx = await redis.getBuffer(cacheKey);
      if (cachedTx) {
        const decompressed = await decompress(cachedTx);
        purchasesTxs.push(JSON.parse(decompressed.toString()));
        return;
      }

      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
        console.warn(`[${new Date().toISOString()}] Skipping transaction ${sig.signature} - invalid or missing metadata`);
        return;
      }

      const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
      if (solChange >= 0) return;

      const tokenChangesRaw = [];
      (tx.meta.postTokenBalances || []).forEach((post, i) => {
        const pre = tx.meta.preTokenBalances?.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
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

      if (tokenChangesRaw.length === 0) return;

      const tokenMints = tokenChangesRaw.map(t => t.mint);
      const tokenInfoMap = await fetchTokenMetadata(tokenMints, connection);

      const tokensBought = tokenChangesRaw.map(t => {
        const tokenInfo = tokenInfoMap[t.mint] || {
          address: t.mint,
          symbol: 'Unknown',
          name: 'Unknown Token',
          logoURI: null,
          decimals: t.decimals,
        };
        return {
          mint: t.mint,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          logoURI: tokenInfo.logoURI,
          amount: t.uiChange,
          decimals: tokenInfo.decimals,
        };
      });

      const spentSOL = +(-solChange).toFixed(6);
      const solPrice = solPrices[sig.blockTime * 1000] || 180;
      const spentUSD = +(solPrice * spentSOL).toFixed(2);

      const txData = {
        signature: sig.signature,
        time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
        spentSOL,
        spentUSD,
        tokensBought,
      };

      const compressed = await compress(JSON.stringify(txData));
      await redis.set(cacheKey, compressed, 'EX', 3600);
      purchasesTxs.push(txData);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error fetching tx ${sig.signature || 'unknown'}:`, e.message);
    }
  }));

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