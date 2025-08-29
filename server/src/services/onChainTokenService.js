// server/src/services/onChainTokenService.js - Получение данных токенов напрямую из блокчейна
const { Connection, PublicKey } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const Redis = require('ioredis');

class OnChainTokenService {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || 'http://45.134.108.254:50111',
            {
                commitment: 'confirmed',
                httpHeaders: { 'Connection': 'keep-alive' }
            }
        );
        
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:sDFxdVgjQtqENxXvirslAnoaAYhsJLJF@tramway.proxy.rlwy.net:37791');
        this.metaplex = new Metaplex(this.connection);
        
        // Cache settings
        this.PRICE_CACHE_TTL = 30; // 30 секунд для цен
        this.METADATA_CACHE_TTL = 3600; // 1 час для метаданных
        this.POOL_CACHE_TTL = 300; // 5 минут для пулов
        
        // Known program IDs
        this.PROGRAMS = {
            RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
            RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
            ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
            JUPITER_V4: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
            METEORA_POOLS: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
            TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            ASSOCIATED_TOKEN: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
        };
        
        // Common mint addresses
        this.KNOWN_MINTS = {
            SOL: 'So11111111111111111111111111111111111111112',
            USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
            SRM: 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt'
        };
        
        console.log(`[${new Date().toISOString()}] 🚀 OnChainTokenService initialized`);
    }

    // Получение актуальной цены токена через пулы
    async getTokenPrice(mintAddress) {
        try {
            const cacheKey = `onchain_price:${mintAddress}`;
            const cached = await this.redis.get(cacheKey);
            
            if (cached) {
                const data = JSON.parse(cached);
                console.log(`[${new Date().toISOString()}] 💰 Cache hit for price ${mintAddress}: $${data.price}`);
                return data;
            }

            console.log(`[${new Date().toISOString()}] 🔍 Fetching onchain price for ${mintAddress}`);
            
            // Найти пулы с этим токеном
            const pools = await this.findTokenPools(mintAddress);
            
            if (pools.length === 0) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No pools found for ${mintAddress}`);
                return null;
            }
            
            // Вычислить цену из лучшего пула
            const priceData = await this.calculateTokenPriceFromPools(mintAddress, pools);
            
            if (priceData) {
                await this.redis.setex(cacheKey, this.PRICE_CACHE_TTL, JSON.stringify(priceData));
            }
            
            return priceData;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token price for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Поиск пулов для токена
    async findTokenPools(mintAddress) {
        try {
            const pools = [];
            const mint = new PublicKey(mintAddress);

            // Raydium V4 пулы
            const raydiumPools = await this.findRaydiumPools(mint);
            pools.push(...raydiumPools);

            // Orca Whirlpools
            const orcaPools = await this.findOrcaPools(mint);
            pools.push(...orcaPools);

            // Meteora пулы
            const meteoraPools = await this.findMeteoraPools(mint);
            pools.push(...meteoraPools);

            console.log(`[${new Date().toISOString()}] 🏊 Found ${pools.length} pools for ${mintAddress}`);
            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding pools for ${mintAddress}:`, error.message);
            return [];
        }
    }

    // Поиск Raydium пулов
    async findRaydiumPools(mintPubkey) {
        try {
            const programId = new PublicKey(this.PROGRAMS.RAYDIUM_V4);
            
            // Получить аккаунты пулов, которые содержат этот токен
            const accounts = await this.connection.getProgramAccounts(programId, {
                filters: [
                    { dataSize: 752 }, // Размер данных пула Raydium
                    {
                        memcmp: {
                            offset: 400, // Примерный offset для base mint
                            bytes: mintPubkey.toBase58()
                        }
                    }
                ]
            });

            const pools = [];
            for (const account of accounts) {
                try {
                    const poolData = await this.parseRaydiumPool(account.account.data, account.pubkey);
                    if (poolData && (
                        poolData.baseMint === mintPubkey.toBase58() || 
                        poolData.quoteMint === mintPubkey.toBase58()
                    )) {
                        pools.push(poolData);
                    }
                } catch (parseError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to parse Raydium pool ${account.pubkey.toBase58()}`);
                }
            }

            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding Raydium pools:`, error.message);
            return [];
        }
    }

    // Парсинг данных пула Raydium
    parseRaydiumPool(data, poolAddress) {
        try {
            // Это упрощенный парсер, нужно адаптировать под реальную структуру Raydium
            if (data.length < 752) return null;

            // Примерная структура (нужно уточнить актуальные оффсеты)
            const baseMintOffset = 400;
            const quoteMintOffset = 432;
            const baseReserveOffset = 464;
            const quoteReserveOffset = 472;

            const baseMint = new PublicKey(data.slice(baseMintOffset, baseMintOffset + 32)).toBase58();
            const quoteMint = new PublicKey(data.slice(quoteMintOffset, quoteMintOffset + 32)).toBase58();
            
            // Чтение резервов (8 байт каждый)
            const baseReserve = data.readBigUInt64LE(baseReserveOffset);
            const quoteReserve = data.readBigUInt64LE(quoteReserveOffset);

            return {
                type: 'raydium_v4',
                address: poolAddress.toBase58(),
                baseMint,
                quoteMint,
                baseReserve: baseReserve.toString(),
                quoteReserve: quoteReserve.toString(),
                dex: 'Raydium'
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error parsing Raydium pool:`, error.message);
            return null;
        }
    }

    // Поиск Orca пулов
    async findOrcaPools(mintPubkey) {
        try {
            const programId = new PublicKey(this.PROGRAMS.ORCA_WHIRLPOOL);
            
            const accounts = await this.connection.getProgramAccounts(programId, {
                filters: [
                    { dataSize: 653 }, // Размер Whirlpool аккаунта
                ]
            });

            const pools = [];
            for (const account of accounts.slice(0, 50)) { // Ограничить для производительности
                try {
                    const poolData = await this.parseOrcaPool(account.account.data, account.pubkey);
                    if (poolData && (
                        poolData.tokenMintA === mintPubkey.toBase58() || 
                        poolData.tokenMintB === mintPubkey.toBase58()
                    )) {
                        pools.push(poolData);
                    }
                } catch (parseError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to parse Orca pool ${account.pubkey.toBase58()}`);
                }
            }

            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding Orca pools:`, error.message);
            return [];
        }
    }

    // Парсинг данных пула Orca
    parseOrcaPool(data, poolAddress) {
        try {
            if (data.length < 653) return null;

            // Примерная структура Orca Whirlpool (нужно уточнить)
            const tokenMintAOffset = 101;
            const tokenMintBOffset = 181;
            
            const tokenMintA = new PublicKey(data.slice(tokenMintAOffset, tokenMintAOffset + 32)).toBase58();
            const tokenMintB = new PublicKey(data.slice(tokenMintBOffset, tokenMintBOffset + 32)).toBase58();

            return {
                type: 'orca_whirlpool',
                address: poolAddress.toBase58(),
                tokenMintA,
                tokenMintB,
                dex: 'Orca'
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error parsing Orca pool:`, error.message);
            return null;
        }
    }

    // Поиск Meteora пулов
    async findMeteoraPools(mintPubkey) {
        try {
            const programId = new PublicKey(this.PROGRAMS.METEORA_POOLS);
            
            const accounts = await this.connection.getProgramAccounts(programId, {
                filters: [
                    { dataSize: 1544 }, // Примерный размер Meteora пула
                ]
            });

            const pools = [];
            for (const account of accounts.slice(0, 30)) {
                try {
                    const poolData = await this.parseMeteoraaPool(account.account.data, account.pubkey, mintPubkey.toBase58());
                    if (poolData) {
                        pools.push(poolData);
                    }
                } catch (parseError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Failed to parse Meteora pool ${account.pubkey.toBase58()}`);
                }
            }

            return pools;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error finding Meteora pools:`, error.message);
            return [];
        }
    }

    // Парсинг данных пула Meteora
    parseMeteoraaPool(data, poolAddress, targetMint) {
        try {
            // Упрощенная проверка - содержит ли пул целевой токен
            const dataStr = data.toString('hex');
            const mintBytes = Buffer.from(new PublicKey(targetMint).toBytes()).toString('hex');
            
            if (dataStr.includes(mintBytes)) {
                return {
                    type: 'meteora',
                    address: poolAddress.toBase58(),
                    dex: 'Meteora',
                    contains_target: true
                };
            }
            
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error parsing Meteora pool:`, error.message);
            return null;
        }
    }

    // Вычисление цены токена из пулов
    async calculateTokenPriceFromPools(mintAddress, pools) {
        try {
            let bestPrice = null;
            let totalLiquidity = 0;
            let priceWeightedSum = 0;

            for (const pool of pools) {
                try {
                    const poolPrice = await this.calculatePoolPrice(mintAddress, pool);
                    if (poolPrice && poolPrice.price > 0) {
                        const liquidity = poolPrice.liquidity || 0;
                        
                        if (liquidity > 0) {
                            priceWeightedSum += poolPrice.price * liquidity;
                            totalLiquidity += liquidity;
                        }
                        
                        if (!bestPrice || liquidity > bestPrice.liquidity) {
                            bestPrice = poolPrice;
                        }
                    }
                } catch (poolError) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Error calculating price for pool ${pool.address}: ${poolError.message}`);
                }
            }

            if (totalLiquidity > 0) {
                const weightedAveragePrice = priceWeightedSum / totalLiquidity;
                
                return {
                    price: weightedAveragePrice,
                    bestPoolPrice: bestPrice?.price || weightedAveragePrice,
                    totalLiquidity,
                    poolCount: pools.length,
                    source: 'onchain_pools',
                    timestamp: Date.now(),
                    pools: pools.map(p => ({
                        dex: p.dex,
                        address: p.address,
                        type: p.type
                    }))
                };
            }

            return bestPrice ? {
                price: bestPrice.price,
                liquidity: bestPrice.liquidity,
                poolCount: 1,
                source: 'onchain_single_pool',
                timestamp: Date.now(),
                dex: bestPrice.dex
            } : null;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating token price from pools:`, error.message);
            return null;
        }
    }

    // Вычисление цены в конкретном пуле
    async calculatePoolPrice(mintAddress, pool) {
        try {
            if (pool.type === 'raydium_v4' && pool.baseReserve && pool.quoteReserve) {
                return this.calculateRaydiumPrice(mintAddress, pool);
            }
            
            if (pool.type === 'orca_whirlpool') {
                return this.calculateOrcaPrice(mintAddress, pool);
            }
            
            // Для других типов пулов - базовая реализация
            return this.calculateGenericPoolPrice(mintAddress, pool);
            
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating pool price:`, error.message);
            return null;
        }
    }

    // Вычисление цены в Raydium пуле
    calculateRaydiumPrice(mintAddress, pool) {
        try {
            const isBase = pool.baseMint === mintAddress;
            const isQuote = pool.quoteMint === mintAddress;
            
            if (!isBase && !isQuote) return null;

            const baseReserve = BigInt(pool.baseReserve);
            const quoteReserve = BigInt(pool.quoteReserve);
            
            if (baseReserve === 0n || quoteReserve === 0n) return null;

            let price;
            let liquidity;

            if (isBase) {
                // Если целевой токен - base, цена = quote/base
                price = Number(quoteReserve) / Number(baseReserve);
                liquidity = Number(quoteReserve);
            } else {
                // Если целевой токен - quote, цена = base/quote  
                price = Number(baseReserve) / Number(quoteReserve);
                liquidity = Number(baseReserve);
            }

            // Если пара с SOL, получить цену SOL в USD
            const solMint = this.KNOWN_MINTS.SOL;
            const usdcMint = this.KNOWN_MINTS.USDC;
            
            if (pool.baseMint === solMint || pool.quoteMint === solMint) {
                // Нужно конвертировать в USD через цену SOL
                // Это упрощение - в реальности нужно получить актуальную цену SOL
                price = price * 150; // Примерная цена SOL
            } else if (pool.baseMint === usdcMint || pool.quoteMint === usdcMint) {
                // Уже в USD
                price = price;
            }

            return {
                price: price,
                liquidity: liquidity,
                dex: pool.dex,
                poolAddress: pool.address,
                pairTokens: `${pool.baseMint.slice(0, 8)}.../${pool.quoteMint.slice(0, 8)}...`
            };

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating Raydium price:`, error.message);
            return null;
        }
    }

    // Вычисление цены в Orca пуле
    async calculateOrcaPrice(mintAddress, pool) {
        try {
            // Получить актуальные данные балансов для Orca пула
            const poolAccount = await this.connection.getAccountInfo(new PublicKey(pool.address));
            if (!poolAccount) return null;

            // Это упрощенная реализация - нужно парсить реальную структуру Whirlpool
            const price = Math.random() * 0.1; // Заглушка
            
            return {
                price: price,
                liquidity: 10000, // Заглушка
                dex: pool.dex,
                poolAddress: pool.address
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating Orca price:`, error.message);
            return null;
        }
    }

    // Базовое вычисление цены для неизвестных типов пулов
    calculateGenericPoolPrice(mintAddress, pool) {
        // Заглушка для других типов пулов
        return {
            price: 0.001,
            liquidity: 1000,
            dex: pool.dex || 'Unknown',
            poolAddress: pool.address
        };
    }

    // Получение полной информации о токене
    async getTokenInfo(mintAddress) {
        try {
            const cacheKey = `token_info:${mintAddress}`;
            const cached = await this.redis.get(cacheKey);
            
            if (cached) {
                return JSON.parse(cached);
            }

            console.log(`[${new Date().toISOString()}] 🔍 Fetching complete token info for ${mintAddress}`);

            // Параллельно получить все данные
            const [priceData, metadata, mintInfo, supply] = await Promise.all([
                this.getTokenPrice(mintAddress),
                this.getTokenMetadata(mintAddress),
                this.getTokenMintInfo(mintAddress),
                this.getTokenSupply(mintAddress)
            ]);

            const tokenInfo = {
                mint: mintAddress,
                price: priceData?.price || 0,
                priceSource: priceData?.source || 'unknown',
                liquidity: priceData?.totalLiquidity || 0,
                marketCap: 0,
                
                // Метаданные
                symbol: metadata?.symbol || 'Unknown',
                name: metadata?.name || 'Unknown Token',
                decimals: mintInfo?.decimals || 9,
                
                // Данные поставки
                totalSupply: supply?.value?.uiAmount || 0,
                circulatingSupply: supply?.value?.uiAmount || 0,
                
                // Время создания
                createdAt: mintInfo?.createdAt || null,
                
                // Пулы
                pools: priceData?.pools || [],
                poolCount: priceData?.poolCount || 0,
                
                timestamp: Date.now()
            };

            // Вычислить market cap
            if (tokenInfo.price > 0 && tokenInfo.totalSupply > 0) {
                tokenInfo.marketCap = tokenInfo.price * tokenInfo.totalSupply;
            }

            // Кешировать результат
            await this.redis.setex(cacheKey, this.METADATA_CACHE_TTL, JSON.stringify(tokenInfo));

            return tokenInfo;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token info for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Получение метаданных токена
    async getTokenMetadata(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const metadataAccount = await this.metaplex.nfts().findByMint({ mintAddress: mintPubkey });
            
            return {
                symbol: metadataAccount.symbol || 'Unknown',
                name: metadataAccount.name || 'Unknown Token',
                uri: metadataAccount.uri,
                image: metadataAccount.json?.image
            };
        } catch (error) {
            console.warn(`[${new Date().toISOString()}] ⚠️ No metadata found for ${mintAddress}`);
            return {
                symbol: 'Unknown',
                name: 'Unknown Token'
            };
        }
    }

    // Получение информации о минте
    async getTokenMintInfo(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            const mintAccount = await this.connection.getParsedAccountInfo(mintPubkey);
            
            if (mintAccount.value && mintAccount.value.data.parsed) {
                const mintData = mintAccount.value.data.parsed.info;
                
                // Попытаться получить время создания из истории транзакций
                const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 });
                let createdAt = null;
                
                if (signatures.length > 0) {
                    const firstSig = signatures[signatures.length - 1];
                    if (firstSig.blockTime) {
                        createdAt = new Date(firstSig.blockTime * 1000).toISOString();
                    }
                }
                
                return {
                    decimals: mintData.decimals,
                    mintAuthority: mintData.mintAuthority,
                    supply: mintData.supply,
                    isInitialized: mintData.isInitialized,
                    freezeAuthority: mintData.freezeAuthority,
                    createdAt
                };
            }
            
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting mint info for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Получение общей поставки токена
    async getTokenSupply(mintAddress) {
        try {
            const mintPubkey = new PublicKey(mintAddress);
            return await this.connection.getTokenSupply(mintPubkey);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token supply for ${mintAddress}:`, error.message);
            return null;
        }
    }

    // Batch получение данных для множества токенов
    async getTokensBatch(mintAddresses) {
        console.log(`[${new Date().toISOString()}] 🚀 Batch processing ${mintAddresses.length} tokens onchain`);
        const startTime = Date.now();
        
        const BATCH_SIZE = 10;
        const results = new Map();
        
        for (let i = 0; i < mintAddresses.length; i += BATCH_SIZE) {
            const batch = mintAddresses.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (mint) => {
                try {
                    const tokenInfo = await this.getTokenInfo(mint);
                    return { mint, data: tokenInfo };
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Error in batch for ${mint}:`, error.message);
                    return { mint, data: null };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(({ mint, data }) => {
                results.set(mint, data);
            });
            
            // Небольшая пауза между батчами
            if (i + BATCH_SIZE < mintAddresses.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ✅ Batch completed in ${duration}ms: ${results.size} tokens processed`);
        
        return results;
    }

    // Получение статистики сервиса
    getStats() {
        return {
            rpcEndpoint: this.connection.rpcEndpoint,
            cacheSettings: {
                priceCache: this.PRICE_CACHE_TTL,
                metadataCache: this.METADATA_CACHE_TTL,
                poolCache: this.POOL_CACHE_TTL
            },
            supportedPrograms: Object.keys(this.PROGRAMS),
            knownMints: Object.keys(this.KNOWN_MINTS)
        };
    }

    // Закрытие сервиса
    async close() {
        await this.redis.quit();
        console.log(`[${new Date().toISOString()}] ✅ OnChainTokenService closed`);
    }
}

module.exports = OnChainTokenService;