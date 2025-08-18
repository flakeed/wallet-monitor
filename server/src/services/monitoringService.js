const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

const redisClient = redis.createClient({ url: process.env.REDIS_URL });

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.isMonitoring = false;
        this.processedSignatures = new Set();
        this.recentlyProcessed = new Set(); // Добавляем кэш для предотвращения дубликатов
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0,
            startTime: Date.now(),
        };
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.isProcessingQueue = false;
        this.queueKey = 'webhook:queue';
        this.batchSize = 400;
        console.log(`[${new Date().toISOString()}] 🔧 MonitoringService initialized`);
    }

    startMonitoring() {
        console.log('⚠️ Legacy monitoring is deprecated. Use WebSocket service instead.');
        this.isMonitoring = false;
    }

    stopMonitoring() {
        this.isMonitoring = false;
        console.log('⏹️ Legacy monitoring stopped');
    }

    async getUsdcToSolRate() {
        const cacheKey = 'usdc_to_sol_rate';
        const cachedRate = await redisClient.get(cacheKey);
        if (cachedRate) return parseFloat(cachedRate);
      
        try {
          const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd');
          const solPriceInUsd = response.data.solana.usd;
          const usdcPriceInUsd = response.data['usd-coin'].usd;
          const rate = usdcPriceInUsd / solPriceInUsd;
          await redisClient.setEx(cacheKey, 600, rate.toString()); // Кэш на 10 минут
          return rate;
        } catch (error) {
          console.error('Error fetching USDC/SOL rate:', error);
          return 0.02; // Fallback-курс
        }
      }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
    
        while (true) {
            const requestData = await this.redis.lpop(this.queueKey, this.batchSize);
            if (!requestData || requestData.length === 0) break;
    
            const requests = requestData.map((data) => {
                try {
                    return JSON.parse(data);
                } catch (error) {
                    console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, error.message);
                    return null;
                }
            }).filter((req) => req !== null);
    
            if (requests.length === 0) continue;
    
            console.log(`[${new Date().toISOString()}] 🔄 Processing batch of ${requests.length} signatures`);
    
            const batchResults = await Promise.all(
                requests.map(async (request) => {
                    const { signature, walletAddress, blockTime } = request;
                    try {
                        const wallet = await this.db.getWalletByAddress(walletAddress);
                        if (!wallet) {
                            console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
                            return null;
                        }
    
                        const txData = await this.processTransaction({ signature, blockTime }, wallet);
                        if (txData) {
                            console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature}`);
                            return {
                                signature,
                                walletAddress,
                                walletName: wallet.name,
                                groupId: wallet.group_id,
                                groupName: wallet.group_name,
                                transactionType: txData.type,
                                solAmount: txData.solAmount,
                                tokens: txData.tokensChanged.map((tc) => ({
                                    mint: tc.mint,
                                    amount: tc.rawChange / Math.pow(10, tc.decimals),
                                    symbol: tc.symbol,
                                    name: tc.name,
                                })),
                                timestamp: new Date(blockTime * 1000).toISOString(),
                            };
                        }
                        return null;
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${signature}:`, error.message);
                        return null;
                    }
                })
            );
    
            const successfulTxs = batchResults.filter((tx) => tx !== null);
            if (successfulTxs.length > 0) {
                const pipeline = this.redis.pipeline();
                successfulTxs.forEach((tx) => {
                    pipeline.publish('transactions', JSON.stringify(tx));
                });
                await pipeline.exec();
            }
        }
    
        this.isProcessingQueue = false;
        const queueLength = await this.redis.llen(this.queueKey);
        if (queueLength > 0) {
            setImmediate(() => this.processQueue());
        }
    }

    async processWebhookMessage(message) {
        const { signature, walletAddress, blockTime } = message;
        const requestId = require('uuid').v4();
        await this.redis.lpush(this.queueKey, JSON.stringify({
            requestId,
            signature,
            walletAddress,
            blockTime,
            timestamp: Date.now(),
        }));
        console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature}`);

        if (!this.isProcessingQueue) {
            setImmediate(() => this.processQueue());
        }
    }

    async fetchTransactionWithRetry(signature, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[${new Date().toISOString()}] 🔄 Fetching transaction ${signature} (attempt ${attempt}/${maxRetries})`);
                
                // Пробуем разные уровни commitment и версии
                const options = {
                    maxSupportedTransactionVersion: 0, // Поддержка versioned transactions
                    commitment: 'confirmed',
                };
    
                const tx = await this.connection.getParsedTransaction(signature, options);
                
                if (!tx) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Transaction ${signature} not found (attempt ${attempt})`);
                    if (attempt < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                        continue;
                    }
                    return null;
                }
    
                // Проверяем успешность транзакции
                if (tx.meta?.err) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Transaction ${signature} failed:`, tx.meta.err);
                    return null;
                }
    
                console.log(`[${new Date().toISOString()}] ✅ Successfully fetched transaction ${signature}`);
                console.log(`[${new Date().toISOString()}] 📊 Transaction info:`);
                console.log(`  - Version: ${tx.version || 'legacy'}`);
                console.log(`  - Status: ${tx.meta?.err ? 'Failed' : 'Success'}`);
                console.log(`  - Fee: ${(tx.meta?.fee || 0) / 1e9} SOL`);
                console.log(`  - Account keys: ${tx.transaction?.message?.accountKeys?.length || 0}`);
                console.log(`  - Instructions: ${tx.transaction?.message?.instructions?.length || 0}`);
                console.log(`  - Pre-token balances: ${tx.meta?.preTokenBalances?.length || 0}`);
                console.log(`  - Post-token balances: ${tx.meta?.postTokenBalances?.length || 0}`);
    
                return tx;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error fetching transaction ${signature} (attempt ${attempt}):`, error.message);
                
                if (attempt < maxRetries) {
                    console.log(`[${new Date().toISOString()}] ⏳ Waiting before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                }
            }
        }
        
        console.error(`[${new Date().toISOString()}] ❌ Failed to fetch transaction ${signature} after ${maxRetries} attempts`);
        return null;
    }

    async fetchSolPrice() {
        try {
            const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const bestPair = data.pairs.reduce((prev, current) =>
                    (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                );
                return parseFloat(bestPair.priceUsd || 150);
            }
            return 150; // Fallback price
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error fetching SOL price:`, error.message);
            return 150; // Fallback price
        }
    }

    async processTransaction(wallet, sig, connection) {
        try {
          const transaction = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });
      
          if (!transaction) {
            console.warn(`Transaction ${sig.signature} not found or not parsed`);
            return;
          }
      
          const { meta, transaction: tx } = transaction;
          if (!meta || !tx) return;
      
          const preBalances = meta.preBalances;
          const postBalances = meta.postBalances;
          const accountKeys = tx.message.accountKeys.map((key) => key.pubkey.toBase58());
      
          let solChange = null;
          let tokenChange = null;
          let isUsdcTransaction = false;
          let transactionType = null;
      
          // Определяем индекс кошелька в accountKeys
          const walletIndex = accountKeys.findIndex((key) => key === wallet.address);
          if (walletIndex === -1) return;
      
          // Проверяем изменение баланса SOL
          const solPreBalance = preBalances[walletIndex] || 0;
          const solPostBalance = postBalances[walletIndex] || 0;
          if (solPreBalance !== solPostBalance) {
            solChange = {
              preBalance: solPreBalance,
              postBalance: solPostBalance,
            };
          }
      
          // Проверяем изменение токенов (включая USDC)
          const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const tokenChanges = [];
      
          for (const account of meta.preTokenBalances.concat(meta.postTokenBalances)) {
            if (account.owner === wallet.address) {
              const mint = account.mint;
              const preBalance = meta.preTokenBalances.find(
                (tb) => tb.mint === mint && tb.owner === wallet.address
              )?.uiTokenAmount.uiAmount || 0;
              const postBalance = meta.postTokenBalances.find(
                (tb) => tb.mint === mint && tb.owner === wallet.address
              )?.uiTokenAmount.uiAmount || 0;
      
              if (preBalance !== postBalance) {
                tokenChanges.push({
                  mint,
                  amount: Math.abs(postBalance - preBalance),
                  decimals: meta.preTokenBalances.find((tb) => tb.mint === mint)?.uiTokenAmount.decimals || 6,
                  symbol: mint === usdcMint ? 'USDC' : 'Unknown',
                  name: mint === usdcMint ? 'USD Coin' : 'Unknown Token',
                });
                if (mint === usdcMint) {
                  isUsdcTransaction = true;
                }
              }
            }
          }
      
          // Определяем тип транзакции (buy/sell)
          if (solChange && tokenChanges.length > 0) {
            transactionType = solChange.postBalance < solChange.preBalance ? 'buy' : 'sell';
          } else if (isUsdcTransaction && tokenChanges.length > 0) {
            transactionType = tokenChanges.some((tc) => tc.amount > 0 && tc.mint !== usdcMint) ? 'buy' : 'sell';
          }
      
          if (!transactionType) return;
      
          // Конвертация USDC в SOL
          let solAmount = 0;
          const usdcToSolRate = await getUsdcToSolRate();
      
          if (isUsdcTransaction) {
            const usdcToken = tokenChanges.find((tc) => tc.mint === usdcMint);
            if (usdcToken) {
              solAmount = (usdcToken.amount / Math.pow(10, usdcToken.decimals)) * usdcToSolRate;
            }
          } else if (solChange) {
            solAmount = Math.abs(solChange.postBalance - solChange.preBalance) / 1e9;
          }
      
          // Сохранение транзакции
          const query = `
            INSERT INTO transactions (
              wallet_id, signature, time, operation_type,
              sol_spent, sol_received
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (signature) DO NOTHING
            RETURNING id;
          `;
          const result = await client.query(query, [
            wallet.id,
            sig.signature,
            new Date(sig.blockTime * 1000).toISOString(),
            transactionType,
            transactionType === 'buy' ? solAmount : 0,
            transactionType === 'sell' ? solAmount : 0,
          ]);
      
          if (result.rows.length === 0) return;
      
          const transactionId = result.rows[0].id;
      
          // Сохранение операций с токенами
          for (const token of tokenChanges.filter((tc) => tc.mint !== usdcMint)) {
            const tokenQuery = `
              INSERT INTO token_operations (
                transaction_id, token_mint, symbol, name, decimals,
                tokens_bought, tokens_sold
              ) VALUES ($1, $2, $3, $4, $5, $6, $7);
            `;
            await client.query(tokenQuery, [
              transactionId,
              token.mint,
              token.symbol,
              token.name,
              token.decimals,
              transactionType === 'buy' ? token.amount : 0,
              transactionType === 'sell' ? token.amount : 0,
            ]);
          }
        } catch (error) {
          console.error(`Error processing transaction ${sig.signature}:`, error);
        }
      }

    async analyzeTokenChanges(meta, transactionType, walletAddress) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const tokenChanges = [];
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing token changes for ${transactionType} transaction`);
        console.log(`Pre-token balances: ${meta.preTokenBalances?.length || 0}, Post-token balances: ${meta.postTokenBalances?.length || 0}`);
    
        const allBalanceChanges = new Map();
        for (const pre of meta.preTokenBalances || []) {
            const key = `${pre.mint}-${pre.accountIndex}`;
            allBalanceChanges.set(key, {
                mint: pre.mint,
                accountIndex: pre.accountIndex,
                owner: pre.owner,
                preAmount: pre.uiTokenAmount.amount,
                preUiAmount: pre.uiTokenAmount.uiAmount,
                postAmount: '0',
                postUiAmount: 0,
                decimals: pre.uiTokenAmount.decimals
            });
        }
    
        for (const post of meta.postTokenBalances || []) {
            const key = `${post.mint}-${post.accountIndex}`;
            if (allBalanceChanges.has(key)) {
                const existing = allBalanceChanges.get(key);
                existing.postAmount = post.uiTokenAmount.amount;
                existing.postUiAmount = post.uiTokenAmount.uiAmount;
            } else {
                allBalanceChanges.set(key, {
                    mint: post.mint,
                    accountIndex: post.accountIndex,
                    owner: post.owner,
                    preAmount: '0',
                    preUiAmount: 0,
                    postAmount: post.uiTokenAmount.amount,
                    postUiAmount: post.uiTokenAmount.uiAmount,
                    decimals: post.uiTokenAmount.decimals
                });
            }
        }
    
        console.log(`[${new Date().toISOString()}] 📊 Found ${allBalanceChanges.size} balance changes to analyze`);
    
        const mintChanges = new Map();
        for (const [key, change] of allBalanceChanges) {
            if (change.mint === WRAPPED_SOL_MINT || change.mint === USDC_MINT) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping ${change.mint === WRAPPED_SOL_MINT ? 'WSOL' : 'USDC'}`);
                continue;
            }
    
            if (change.owner !== walletAddress) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping token ${change.mint} - not owned by wallet ${walletAddress}`);
                continue;
            }
    
            const rawChange = Number(change.postAmount) - Number(change.preAmount);
            const uiChange = Number(change.postUiAmount) - Number(change.preUiAmount);
    
            console.log(`[${new Date().toISOString()}] 🪙 Token ${change.mint}:`);
            console.log(`  - Account Index: ${change.accountIndex}`);
            console.log(`  - Owner: ${change.owner}`);
            console.log(`  - Raw change: ${rawChange}`);
            console.log(`  - UI change: ${uiChange}`);
            console.log(`  - Decimals: ${change.decimals}`);
    
            let isValidChange = false;
            if (transactionType === 'buy' && rawChange > 0) {
                isValidChange = true;
                console.log(`[${new Date().toISOString()}] ✅ Valid BUY: token balance increased by ${rawChange} raw units`);
            } else if (transactionType === 'sell' && rawChange < 0) {
                isValidChange = true;
                console.log(`[${new Date().toISOString()}] ✅ Valid SELL: token balance decreased by ${Math.abs(rawChange)} raw units`);
            } else {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping token ${change.mint} - balance change doesn't match transaction type`);
                continue;
            }
    
            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += Math.abs(rawChange);
                    console.log(`[${new Date().toISOString()}] 📈 Aggregating change for ${change.mint}: ${existing.totalRawChange} total`);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: Math.abs(rawChange)
                    });
                    console.log(`[${new Date().toISOString()}] 🆕 New mint change: ${change.mint} = ${Math.abs(rawChange)}`);
                }
            }
        }
    
        if (mintChanges.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found for ${transactionType} transaction`);
            return [];
        }
    
        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mintChanges.size} unique tokens`);
    
        const mints = Array.from(mintChanges.keys());
        const tokenInfos = await this.batchFetchTokenMetadata(mints);
    
        for (const [mint, aggregatedChange] of mintChanges) {
            const tokenInfo = tokenInfos.get(mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: aggregatedChange.decimals,
            };
    
            tokenChanges.push({
                mint: mint,
                rawChange: aggregatedChange.totalRawChange,
                decimals: aggregatedChange.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} total raw units)`);
        }
    
        console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} unique token changes`);
        return tokenChanges;
    }

    async analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing token changes for ${transactionType} transaction`);
        console.log(`Pre-token balances: ${meta.preTokenBalances?.length || 0}, Post-token balances: ${meta.postTokenBalances?.length || 0}`);
    
        // Создаем карту изменений по mint + accountIndex
        const allBalanceChanges = new Map();
    
        // Инициализируем с pre-balances
        for (const pre of meta.preTokenBalances || []) {
            const key = `${pre.mint}-${pre.accountIndex}`;
            allBalanceChanges.set(key, {
                mint: pre.mint,
                accountIndex: pre.accountIndex,
                owner: pre.owner,
                preAmount: pre.uiTokenAmount.amount,
                preUiAmount: pre.uiTokenAmount.uiAmount,
                postAmount: '0',
                postUiAmount: 0,
                decimals: pre.uiTokenAmount.decimals
            });
        }
    
        // Обновляем/добавляем post-balances
        for (const post of meta.postTokenBalances || []) {
            const key = `${post.mint}-${post.accountIndex}`;
            if (allBalanceChanges.has(key)) {
                const existing = allBalanceChanges.get(key);
                existing.postAmount = post.uiTokenAmount.amount;
                existing.postUiAmount = post.uiTokenAmount.uiAmount;
            } else {
                allBalanceChanges.set(key, {
                    mint: post.mint,
                    accountIndex: post.accountIndex,
                    owner: post.owner,
                    preAmount: '0',
                    preUiAmount: 0,
                    postAmount: post.uiTokenAmount.amount,
                    postUiAmount: post.uiTokenAmount.uiAmount,
                    decimals: post.uiTokenAmount.decimals
                });
            }
        }
    
        console.log(`[${new Date().toISOString()}] 📊 Found ${allBalanceChanges.size} balance changes to analyze`);
    
        // ГРУППИРУЕМ ПО MINT И СУММИРУЕМ ИЗМЕНЕНИЯ
        const mintChanges = new Map();
    
        // Анализируем каждое изменение и группируем по mint
        for (const [key, change] of allBalanceChanges) {
            if (change.mint === WRAPPED_SOL_MINT) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping WSOL`);
                continue;
            }
    
            const rawChange = Number(change.postAmount) - Number(change.preAmount);
            const uiChange = Number(change.postUiAmount) - Number(change.preUiAmount);
            
            console.log(`[${new Date().toISOString()}] 🪙 Token ${change.mint}:`);
            console.log(`  - Account Index: ${change.accountIndex}`);
            console.log(`  - Owner: ${change.owner}`);
            console.log(`  - Raw change: ${rawChange}`);
            console.log(`  - UI change: ${uiChange}`);
            console.log(`  - Decimals: ${change.decimals}`);
    
            // ИСПРАВЛЕННАЯ ЛОГИКА: проверяем правильное направление изменений
            let isValidChange = false;
            
            if (transactionType === 'buy') {
                // При покупке баланс токенов должен УВЕЛИЧИТЬСЯ (rawChange > 0)
                if (rawChange > 0) {
                    isValidChange = true;
                    console.log(`[${new Date().toISOString()}] ✅ Valid BUY: token balance increased by ${rawChange} raw units`);
                } else {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping buy token ${change.mint} - balance decreased or unchanged (${rawChange})`);
                }
            } else if (transactionType === 'sell') {
                // При продаже баланс токенов должен УМЕНЬШИТЬСЯ (rawChange < 0)
                if (rawChange < 0) {
                    isValidChange = true;
                    console.log(`[${new Date().toISOString()}] ✅ Valid SELL: token balance decreased by ${Math.abs(rawChange)} raw units`);
                } else {
                    console.log(`[${new Date().toISOString()}] ⏭️ Skipping sell token ${change.mint} - balance increased or unchanged (${rawChange})`);
                }
            }
    
            // АГРЕГИРУЕМ ПО MINT
            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += Math.abs(rawChange);
                    console.log(`[${new Date().toISOString()}] 📈 Aggregating change for ${change.mint}: ${existing.totalRawChange} total`);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: Math.abs(rawChange)
                    });
                    console.log(`[${new Date().toISOString()}] 🆕 New mint change: ${change.mint} = ${Math.abs(rawChange)}`);
                }
            }
        }
    
        if (mintChanges.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found for ${transactionType} transaction`);
            
            // Дополнительная диагностика
            console.log(`[${new Date().toISOString()}] 🔍 Debug: All balance changes:`);
            for (const [key, change] of allBalanceChanges) {
                const rawChange = Number(change.postAmount) - Number(change.preAmount);
                console.log(`  - ${change.mint}: ${rawChange} (${change.mint === WRAPPED_SOL_MINT ? 'WSOL' : 'TOKEN'})`);
            }
            
            return [];
        }
    
        console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mintChanges.size} unique tokens`);
    
        // Получаем метаданные токенов
        const mints = Array.from(mintChanges.keys());
        const tokenInfos = await this.batchFetchTokenMetadata(mints);
    
        // Создаем финальный список изменений токенов - ОДИН НА MINT
        for (const [mint, aggregatedChange] of mintChanges) {
            const tokenInfo = tokenInfos.get(mint) || {
                symbol: 'Unknown',
                name: 'Unknown Token',
                decimals: aggregatedChange.decimals,
            };
    
            tokenChanges.push({
                mint: mint,
                rawChange: aggregatedChange.totalRawChange, // Суммарное изменение
                decimals: aggregatedChange.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} total raw units)`);
        }
    
        console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} unique token changes`);
        return tokenChanges;
    }

    async batchFetchTokenMetadata(mints) {
        const tokenInfos = new Map();
        const uncachedMints = [];
        const pipeline = this.redis.pipeline();

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
            const batchSize = 10;
            for (let i = 0; i < uncachedMints.length; i += batchSize) {
                const batch = uncachedMints.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(async (mint) => {
                        const tokenInfo = await fetchTokenMetadata(mint, this.connection);
                        return { mint, tokenInfo };
                    })
                );
                const pipeline = this.redis.pipeline();
                batchResults.forEach(({ mint, tokenInfo }) => {
                    if (tokenInfo) {
                        tokenInfos.set(mint, tokenInfo);
                        pipeline.set(`token:${mint}`, JSON.stringify(tokenInfo), 'EX', 24 * 60 * 60);
                    }
                });
                await pipeline.exec();
            }
        }

        return tokenInfos;
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
            if (!tokenInfo) {
                console.warn(`[${new Date().toISOString()}] ⚠️ No metadata for token ${tokenChange.mint}`);
                return;
            }

            const tokenUpsertQuery = `
                INSERT INTO tokens (mint, symbol, name, decimals) 
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;
            const tokenResult = await client.query(tokenUpsertQuery, [
                tokenChange.mint,
                tokenInfo.symbol,
                tokenInfo.name,
                tokenInfo.decimals,
            ]);

            const tokenId = tokenResult.rows[0].id;
            const amount = tokenChange.rawChange / Math.pow(10, tokenChange.decimals);

            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error saving token operation:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null, groupId = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name, groupId);
            console.log(`[${new Date().toISOString()}] ✅ Added wallet: ${name || address.slice(0, 8)}... to group ${groupId || 'none'}`);
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (wallet) {
                const transactions = await this.db.getRecentTransactions(24 * 7);
                const walletSignatures = transactions
                    .filter((tx) => tx.wallet_address === address)
                    .map((tx) => tx.signature);
                walletSignatures.forEach((sig) => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet: ${address.slice(0, 8)}...`);
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    async removeAllWallets(groupId = null) {
        try {
            console.log(`[${new Date().toISOString()}] 🗑️ Removing all wallets from monitoring service${groupId ? ` for group ${groupId}` : ''}`);
            const transactions = await this.db.getRecentTransactions(24 * 7, 400, null, groupId);
            const allSignatures = transactions.map((tx) => tx.signature);
            allSignatures.forEach((sig) => this.processedSignatures.delete(sig));
            if (!groupId) {
                this.processedSignatures.clear();
                this.recentlyProcessed.clear(); // Очищаем кэш недавно обработанных
            }
            await this.db.removeAllWallets(groupId);
            console.log(`[${new Date().toISOString()}] ✅ All wallets removed from monitoring service${groupId ? ` for group ${groupId}` : ''}`);
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error removing all wallets from monitoring service:`, error.message);
            throw error;
        }
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            processedSignatures: this.processedSignatures.size,
            rpcEndpoint: this.connection.rpcEndpoint,
            stats: {
                ...this.stats,
                uptime: Date.now() - this.stats.startTime,
            },
        };
    }

    async getDetailedStats(groupId = null) {
        try {
            const dbStats = await this.db.getMonitoringStats(groupId);
            const topTokens = await this.db.getTopTokens(5, null, groupId);
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens,
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async close() {
        this.stopMonitoring();
        await this.redis.quit();
        await this.db.close();
        console.log(`[${new Date().toISOString()}] ✅ Monitoring service closed`);
    }
}

module.exports = WalletMonitoringService;