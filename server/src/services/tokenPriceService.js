// server/src/services/tokenPriceService.js
const { Connection, PublicKey } = require('@solana/web3.js');
const Redis = require('ioredis');
const { fetchTokenMetadata } = require('./tokenService');

class TokenPriceService {
    constructor() {
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            wsEndpoint: process.env.SOLANA_WS_URL
        });
        
        this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
        this.priceCache = new Map();
        this.CACHE_TTL = 30; // 30 секунд кэш для цен
        this.RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
        this.JUPITER_PRICE_API = 'https://price.jup.ag/v4/price';
        
        // Запускаем периодическое обновление цен
        this.startPriceUpdater();
    }

    async startPriceUpdater() {
        // Обновляем цены каждые 10 секунд для активных токенов
        setInterval(async () => {
            try {
                const activeTokens = await this.getActiveTokens();
                if (activeTokens.length > 0) {
                    await this.batchUpdatePrices(activeTokens);
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error updating prices:`, error);
            }
        }, 10000);
    }

    async getActiveTokens() {
        // Получаем список активных токенов из Redis
        const keys = await this.redis.keys('active_token:*');
        return keys.map(key => key.replace('active_token:', ''));
    }

    async markTokenActive(tokenMint) {
        // Помечаем токен как активный на 5 минут
        await this.redis.set(`active_token:${tokenMint}`, '1', 'EX', 300);
    }

    async getTokenPrice(tokenMint) {
        try {
            // Проверяем кэш
            const cached = await this.redis.get(`price:${tokenMint}`);
            if (cached) {
                return JSON.parse(cached);
            }

            // Получаем цену через Jupiter API
            const priceData = await this.fetchJupiterPrice(tokenMint);
            if (priceData) {
                await this.redis.set(`price:${tokenMint}`, JSON.stringify(priceData), 'EX', this.CACHE_TTL);
                return priceData;
            }

            // Если Jupiter не вернул цену, пробуем получить через Raydium pools
            const raydiumPrice = await this.fetchRaydiumPrice(tokenMint);
            if (raydiumPrice) {
                await this.redis.set(`price:${tokenMint}`, JSON.stringify(raydiumPrice), 'EX', this.CACHE_TTL);
                return raydiumPrice;
            }

            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching price for ${tokenMint}:`, error);
            return null;
        }
    }

    async fetchJupiterPrice(tokenMint) {
        try {
            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=${tokenMint}`);
            if (!response.ok) return null;
            
            const data = await response.json();
            if (data.data && data.data[tokenMint]) {
                const price = data.data[tokenMint].price;
                return {
                    priceInSOL: price / data.data['So11111111111111111111111111111111111111112']?.price || 0,
                    priceInUSD: price,
                    source: 'jupiter',
                    timestamp: Date.now()
                };
            }
            return null;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Jupiter API error:`, error);
            return null;
        }
    }

    async fetchRaydiumPrice(tokenMint) {
        try {
            // Получаем аккаунты пулов Raydium для токена
            const filters = [
                { dataSize: 752 },
                { memcmp: { offset: 400, bytes: tokenMint } }
            ];
            
            const poolAccounts = await this.connection.getProgramAccounts(
                this.RAYDIUM_V4,
                { filters }
            );

            if (poolAccounts.length === 0) {
                // Пробуем найти пул где токен - quote
                const altFilters = [
                    { dataSize: 752 },
                    { memcmp: { offset: 432, bytes: tokenMint } }
                ];
                const altPools = await this.connection.getProgramAccounts(
                    this.RAYDIUM_V4,
                    { filters: altFilters }
                );
                if (altPools.length > 0) {
                    poolAccounts.push(...altPools);
                }
            }

            if (poolAccounts.length === 0) return null;

            // Берем первый найденный пул
            const poolData = poolAccounts[0].account.data;
            
            // Парсим данные пула (упрощенная версия)
            const baseVault = new PublicKey(poolData.slice(64, 96));
            const quoteVault = new PublicKey(poolData.slice(96, 128));
            
            // Получаем балансы
            const [baseBalance, quoteBalance] = await Promise.all([
                this.connection.getTokenAccountBalance(baseVault),
                this.connection.getTokenAccountBalance(quoteVault)
            ]);

            const baseAmount = parseFloat(baseBalance.value.uiAmount || 0);
            const quoteAmount = parseFloat(quoteBalance.value.uiAmount || 0);

            if (baseAmount === 0) return null;

            // Считаем цену в SOL (предполагаем что quote - это SOL)
            const priceInSOL = quoteAmount / baseAmount;

            return {
                priceInSOL,
                priceInUSD: priceInSOL * (await this.getSOLPrice()),
                source: 'raydium',
                timestamp: Date.now()
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Raydium price fetch error:`, error);
            return null;
        }
    }

    async getSOLPrice() {
        try {
            const cached = await this.redis.get('price:SOL');
            if (cached) {
                return parseFloat(cached);
            }

            const response = await fetch(`${this.JUPITER_PRICE_API}?ids=So11111111111111111111111111111111111111112`);
            const data = await response.json();
            const solPrice = data.data['So11111111111111111111111111111111111111112']?.price || 150;
            
            await this.redis.set('price:SOL', solPrice.toString(), 'EX', 60);
            return solPrice;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error);
            return 150; // Fallback price
        }
    }

    async batchUpdatePrices(tokenMints) {
        const prices = new Map();
        
        // Разбиваем на батчи по 100 токенов
        const batchSize = 100;
        for (let i = 0; i < tokenMints.length; i += batchSize) {
            const batch = tokenMints.slice(i, i + batchSize);
            const batchPrices = await Promise.all(
                batch.map(mint => this.getTokenPrice(mint))
            );
            
            batch.forEach((mint, index) => {
                if (batchPrices[index]) {
                    prices.set(mint, batchPrices[index]);
                }
            });
        }
        
        return prices;
    }

    async getTokenBalance(walletAddress, tokenMint) {
        try {
            const walletPubkey = new PublicKey(walletAddress);
            const mintPubkey = new PublicKey(tokenMint);
            
            // Получаем все токен-аккаунты кошелька
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPubkey,
                { mint: mintPubkey }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            // Суммируем балансы всех аккаунтов
            let totalBalance = 0;
            for (const account of tokenAccounts.value) {
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;
                totalBalance += balance || 0;
            }

            return totalBalance;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error getting token balance:`, error);
            return 0;
        }
    }

    async calculateUnrealizedPnL(walletAddress, tokenMint, spent, bought) {
        try {
            // Получаем текущий баланс токенов
            const currentBalance = await this.getTokenBalance(walletAddress, tokenMint);
            
            // Получаем текущую цену
            const priceData = await this.getTokenPrice(tokenMint);
            if (!priceData) {
                return {
                    currentBalance,
                    currentValueSOL: 0,
                    unrealizedPnL: -spent,
                    percentChange: -100,
                    pricePerToken: 0
                };
            }

            // Рассчитываем текущую стоимость
            const currentValueSOL = currentBalance * priceData.priceInSOL;
            
            // Рассчитываем нереализованный PnL
            const unrealizedPnL = currentValueSOL - spent;
            const percentChange = spent > 0 ? ((unrealizedPnL / spent) * 100) : 0;

            return {
                currentBalance,
                currentValueSOL,
                unrealizedPnL,
                percentChange,
                pricePerToken: priceData.priceInSOL,
                priceSource: priceData.source,
                priceTimestamp: priceData.timestamp
            };
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error calculating unrealized PnL:`, error);
            return {
                currentBalance: 0,
                currentValueSOL: 0,
                unrealizedPnL: -spent,
                percentChange: -100,
                pricePerToken: 0
            };
        }
    }

    async enrichTokenDataWithPnL(tokenData) {
        const enrichedData = { ...tokenData };
        
        // Помечаем токен как активный для отслеживания цены
        await this.markTokenActive(tokenData.mint);
        
        // Получаем цену токена
        const priceData = await this.getTokenPrice(tokenData.mint);
        enrichedData.currentPrice = priceData;
        
        // Обогащаем данные каждого кошелька
        enrichedData.wallets = await Promise.all(
            tokenData.wallets.map(async (wallet) => {
                const pnlData = await this.calculateUnrealizedPnL(
                    wallet.address,
                    tokenData.mint,
                    wallet.solSpent,
                    wallet.tokensBought
                );
                
                return {
                    ...wallet,
                    currentBalance: pnlData.currentBalance,
                    currentValueSOL: pnlData.currentValueSOL,
                    unrealizedPnL: pnlData.unrealizedPnL,
                    totalPnL: wallet.pnlSol + pnlData.unrealizedPnL,
                    percentChange: pnlData.percentChange,
                    remainingTokens: pnlData.currentBalance
                };
            })
        );
        
        // Обновляем общую статистику
        const totalUnrealizedPnL = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.unrealizedPnL || 0), 0
        );
        const totalCurrentValue = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.currentValueSOL || 0), 0
        );
        const totalRemainingTokens = enrichedData.wallets.reduce(
            (sum, w) => sum + (w.remainingTokens || 0), 0
        );
        
        enrichedData.summary = {
            ...enrichedData.summary,
            totalUnrealizedPnL,
            totalPnL: enrichedData.summary.netSOL + totalUnrealizedPnL,
            totalCurrentValueSOL: totalCurrentValue,
            totalRemainingTokens,
            avgEntryPrice: enrichedData.summary.totalSpentSOL / 
                (enrichedData.summary.totalBuys > 0 ? enrichedData.summary.totalBuys : 1)
        };
        
        return enrichedData;
    }

    async shutdown() {
        await this.redis.quit();
    }
}

module.exports = TokenPriceService;