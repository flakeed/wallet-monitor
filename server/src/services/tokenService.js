const { Connection, PublicKey } = require('@solana/web3.js');
const { TokenListProvider } = require('@solana/spl-token-registry');
const axios = require('axios');
const { Metaplex } = require('@metaplex-foundation/js');
const { v4: uuidv4 } = require('uuid');

let tokenMap = new Map();
let solPriceCache = new Map();
let lastPriceRequest = 0;
const PRICE_REQUEST_DELAY = 1000; 

const requestQueue = [];
let isProcessingQueue = false;

(async () => {
    try {
        const tokens = await new TokenListProvider().resolve();
        const tokenList = tokens.filterByChainId(101).getList();
        tokenMap = new Map(tokenList.map((t) => [t.address, t]));
        console.log(`✅ Loaded ${tokenMap.size} tokens from registry`);
    } catch (e) {
        console.error('Failed to load token registry:', e.message);
    }
})();

async function processQueue() {
    if (isProcessingQueue || requestQueue.length === 0) return;

    isProcessingQueue = true;
    while (requestQueue.length > 0) {
        const { requestId, mint, connection, resolve, reject } = requestQueue.shift();
        console.log(`[${new Date().toISOString()}] Processing Helius request ${requestId} for mint ${mint}`);

        try {
            const result = await processHeliusRequest(mint, connection);
            resolve(result);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error processing Helius request ${requestId} for mint ${mint}:`, error.message);
            reject(error);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }
    isProcessingQueue = false;
}

async function processHeliusRequest(mint, connection) {
    if (tokenMap.has(mint)) {
        console.log(`[${new Date().toISOString()}] Using cached metadata for mint ${mint}`);
        return tokenMap.get(mint);
    }

    const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
    if (!HELIUS_API_KEY) {
        console.warn('HELIUS_API_KEY not set — trying on-chain metadata');
        const onChainData = await fetchOnChainMetadata(mint, connection);
        const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
        tokenMap.set(mint, data);
        return data;
    }

    try {
        console.log(`[${new Date().toISOString()}] Fetching metadata for mint: ${mint}`);
        const response = await axios.post(
            `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`,
            { mintAccounts: [mint] },
            { timeout: 10000 }
        );

        if (response.data && response.data.length > 0) {
            const meta = response.data[0];
            let logoURI = null;
            const metadataUri = meta?.onChainMetadata?.metadata?.data?.uri;

            if (metadataUri) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const uriResponse = await axios.get(metadataUri, {
                        timeout: 8000,
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
                            await new Promise(resolve => setTimeout(resolve, 500));
                            const retryResponse = await axios.get(metadataUri, {
                                timeout: 8000,
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

            tokenMap.set(mint, tokenData);
            return tokenData;
        }

        console.warn(`[${new Date().toISOString()}] No metadata found for mint ${mint} in Helius API`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Helius API error for mint ${mint}:`, e.response?.data || e.message);
    }

    const onChainData = await fetchOnChainMetadata(mint, connection);
    const data = onChainData || { address: mint, symbol: 'Unknown', name: 'Unknown Token', logoURI: null, decimals: 0 };
    tokenMap.set(mint, data);
    return data;
}

async function fetchTokenMetadata(mint, connection) {
    return new Promise((resolve, reject) => {
        const requestId = uuidv4();
        console.log(`[${new Date().toISOString()}] Enqueued Helius request ${requestId} for mint ${mint}`);
        requestQueue.push({ requestId, mint, connection, resolve, reject });
        processQueue();
    });
}

async function fetchHistoricalSolPrice(timestamp) {
    const cacheKey = timestamp.toISOString().slice(0, 16);
    if (solPriceCache.has(cacheKey)) {
        return solPriceCache.get(cacheKey);
    }

    const time_now = Date.now();
    if (time_now - lastPriceRequest < PRICE_REQUEST_DELAY) {
        await new Promise(resolve => setTimeout(resolve, PRICE_REQUEST_DELAY));
    }
    lastPriceRequest = Date.now();

    try {
        const time = timestamp.getTime();
        console.log(`[${new Date().toISOString()}] Fetching historical SOL price for ${cacheKey}`);
        const response = await axios.get(
            `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime=${time}&endTime=${time + 60000}`,
            { timeout: 10000 }
        );

        if (response.data && response.data.length > 0) {
            const price = parseFloat(response.data[0][4]);
            solPriceCache.set(cacheKey, price);
            console.log(`[${new Date().toISOString()}] ✅ Fetched historical SOL price for ${cacheKey}: $${price}`);
            return price;
        }

        console.warn(`[${new Date().toISOString()}] No historical price data for ${cacheKey}, trying current price`);
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Error fetching historical SOL price for ${cacheKey}:`, e.response?.data || e.message);
    }

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (timestamp >= oneDayAgo) {
        try {
            console.log(`[${new Date().toISOString()}] Fetching current SOL price for ${cacheKey}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            const response = await axios.get(
                `https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT`,
                { timeout: 10000 }
            );

            const price = parseFloat(response.data.price);
            solPriceCache.set(cacheKey, price);
            console.log(`[${new Date().toISOString()}] ✅ Fetched current SOL price for ${cacheKey}: $${price}`);
            return price;
        } catch (e) {
            console.error(`[${new Date().toISOString()}] Error fetching current SOL price for ${cacheKey}:`, e.response?.data || e.message);
        }
    }

    console.warn(`[${new Date().toISOString()}] Using fallback price for ${cacheKey}`);
    const fallbackPrice = 180;
    solPriceCache.set(cacheKey, fallbackPrice);
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
};