// Полная обновленная версия server/src/services/monitoringService.js

const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection(process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005', {
            commitment: 'confirmed',
            httpHeaders: { 'Connection': 'keep-alive' }
        });
        this.isMonitoring = false;
        this.processedSignatures = new Set();
        this.recentlyProcessed = new Set();
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
                                    amount: tc.change || tc.rawChange / Math.pow(10, tc.decimals),
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
                
                const options = {
                    maxSupportedTransactionVersion: 0,
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

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }

            // УЛУЧШЕННАЯ ПРОВЕРКА: проверяем, не обработана ли уже эта транзакция для этого кошелька
            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                [sig.signature, wallet.id]
            );
            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed for wallet ${wallet.address}`);
                return null;
            }

            // Дополнительная проверка в памяти для недавно обработанных
            const processedKey = `${sig.signature}-${wallet.id}`;
            if (this.recentlyProcessed && this.recentlyProcessed.has(processedKey)) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} recently processed for wallet ${wallet.address}`);
                return null;
            }

            // Добавляем в кэш недавно обработанных
            this.recentlyProcessed.add(processedKey);

            // Очищаем старые записи из кэша (каждые 100 транзакций)
            if (this.recentlyProcessed.size > 1000) {
                const toDelete = Array.from(this.recentlyProcessed).slice(0, 500);
                toDelete.forEach(key => this.recentlyProcessed.delete(key));
            }

            console.log(`[${new Date().toISOString()}] 🔍 Processing transaction ${sig.signature} for wallet ${wallet.address}`);

            const tx = await this.fetchTransactionWithRetry(sig.signature);

            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature} - missing metadata`);
                return null;
            }

            // Находим индекс кошелька в accountKeys
            const walletPubkey = wallet.address;
            let walletIndex = -1;
            
            // Поддержка versioned transactions
            if (tx.transaction.message.accountKeys) {
                if (Array.isArray(tx.transaction.message.accountKeys)) {
                    // Legacy transaction
                    walletIndex = tx.transaction.message.accountKeys.findIndex(
                        (key) => key.pubkey ? key.pubkey.toString() === walletPubkey : key.toString() === walletPubkey
                    );
                } else {
                    // Возможно другой формат, пробуем разные варианты
                    console.log(`[${new Date().toISOString()}] 🔍 Non-standard accountKeys format, attempting to parse...`);
                    
                    // Попробуем найти в staticAccountKeys или других полях
                    if (tx.transaction.message.staticAccountKeys) {
                        walletIndex = tx.transaction.message.staticAccountKeys.findIndex(
                            (key) => key.toString() === walletPubkey
                        );
                    }
                    
                    // Если не нашли, попробуем в addressTableLookups
                    if (walletIndex === -1 && tx.transaction.message.addressTableLookups) {
                        console.log(`[${new Date().toISOString()}] 🔍 Checking address table lookups...`);
                        // Для упрощения пока пропустим versioned transactions с address lookups
                        console.warn(`[${new Date().toISOString()}] ⚠️ Versioned transaction with address table lookups not fully supported yet`);
                        return null;
                    }
                }
            }

            if (walletIndex === -1) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
                return null;
            }

            // ========== НОВАЯ ЛОГИКА ОПРЕДЕЛЕНИЯ ТИПА ТРАНЗАКЦИИ ==========
            
            // Анализируем изменения токенов ДО определения типа транзакции
            const tokenChanges = await this.analyzeAllTokenChanges(tx.meta, walletIndex);
            
            console.log(`[${new Date().toISOString()}] 🔍 Found ${tokenChanges.length} token changes:`, 
                tokenChanges.map(tc => `${tc.symbol}: ${tc.change > 0 ? '+' : ''}${tc.change.toFixed(6)}`));

            // Определяем тип транзакции по изменениям токенов
            const transactionAnalysis = this.analyzeTransactionType(tokenChanges, tx.meta, walletIndex);
            
            if (!transactionAnalysis) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - not a token trade`);
                return null;
            }

            const { transactionType, solAmount, relevantTokenChanges } = transactionAnalysis;

            console.log(`[${new Date().toISOString()}] ✅ Detected ${transactionType.toUpperCase()} transaction: ${solAmount.toFixed(6)} SOL equivalent`);
            console.log(`[${new Date().toISOString()}] 🪙 Relevant tokens: ${relevantTokenChanges.length}`);

            if (relevantTokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no relevant token changes`);
                return null;
            }

            // Сохраняем транзакцию в базе данных
            return await this.db.withTransaction(async (client) => {
                // Финальная проверка перед вставкой
                const finalCheck = await client.query(
                    'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                    [sig.signature, wallet.id]
                );
                
                if (finalCheck.rows.length > 0) {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already exists, skipping insert`);
                    return null;
                }

                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        sol_spent, sol_received
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;
                const result = await client.query(query, [
                    wallet.id,
                    sig.signature,
                    new Date(sig.blockTime * 1000).toISOString(),
                    transactionType,
                    transactionType === 'buy' ? solAmount : 0,
                    transactionType === 'sell' ? solAmount : 0,
                ]);

                if (result.rows.length === 0) {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} was already inserted by another process`);
                    return null;
                }

                const transaction = result.rows[0];
                
                // Сохраняем операции с токенами
                const tokenSavePromises = relevantTokenChanges.map((tokenChange) =>
                    this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
                );
                await Promise.all(tokenSavePromises);

                console.log(`[${new Date().toISOString()}] ✅ Successfully saved transaction ${sig.signature} with ${relevantTokenChanges.length} token operations`);

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    tokensChanged: relevantTokenChanges,
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            console.error(`[${new Date().toISOString()}] ❌ Stack trace:`, error.stack);
            return null;
        }
    }

    // ========== НОВЫЕ МЕТОДЫ ДЛЯ АНАЛИЗА ТРАНЗАКЦИЙ ==========

    analyzeTransactionType(tokenChanges, meta, walletIndex) {
        // Константы для различных токенов
        const STABLECOINS = {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 }, // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 }, // USDT
            'So11111111111111111111111111111111111111112': { symbol: 'WSOL', decimals: 9 },    // Wrapped SOL
        };
        
        const NATIVE_SOL_CHANGE_THRESHOLD = 0.01; // 0.01 SOL минимум для считывания как SOL транзакция
        const STABLECOIN_THRESHOLD = 0.1; // 0.1 USD минимум для стейблкоин операций
        const TOKEN_THRESHOLD = 0.001; // Минимальное изменение токена
        
        // Анализируем изменение нативного SOL
        const preBalance = meta.preBalances[walletIndex] || 0;
        const postBalance = meta.postBalances[walletIndex] || 0;
        const nativeSolChange = (postBalance - preBalance) / 1e9;
        
        console.log(`[${new Date().toISOString()}] 💰 Native SOL change: ${nativeSolChange.toFixed(6)} SOL`);
        
        // Разделяем токены на стейблкоины и обычные токены
        const stablecoinChanges = [];
        const tokenOnlyChanges = [];
        
        for (const change of tokenChanges) {
            if (STABLECOINS[change.mint]) {
                stablecoinChanges.push({
                    ...change,
                    isStablecoin: true,
                    stablecoinInfo: STABLECOINS[change.mint]
                });
            } else {
                tokenOnlyChanges.push(change);
            }
        }
        
        console.log(`[${new Date().toISOString()}] 📊 Analysis: ${stablecoinChanges.length} stablecoin changes, ${tokenOnlyChanges.length} token changes`);
        
        // Выводим детальную информацию о всех изменениях
        console.log(`[${new Date().toISOString()}] 📋 Detailed changes:`);
        stablecoinChanges.forEach(sc => {
            console.log(`  💰 ${sc.stablecoinInfo.symbol}: ${sc.change > 0 ? '+' : ''}${sc.change.toFixed(6)}`);
        });
        tokenOnlyChanges.forEach(tc => {
            console.log(`  🪙 ${tc.symbol}: ${tc.change > 0 ? '+' : ''}${tc.change.toFixed(6)}`);
        });
        
        // ========== СЦЕНАРИЙ 1: ТРАДИЦИОННАЯ SOL ТОРГОВЛЯ ==========
        if (Math.abs(nativeSolChange) >= NATIVE_SOL_CHANGE_THRESHOLD) {
            console.log(`[${new Date().toISOString()}] 🔄 Traditional SOL trading detected`);
            
            if (nativeSolChange < -NATIVE_SOL_CHANGE_THRESHOLD && tokenOnlyChanges.some(tc => tc.change > TOKEN_THRESHOLD)) {
                // SOL потрачен + токены получены = покупка за SOL
                const relevantTokens = tokenOnlyChanges.filter(tc => tc.change > TOKEN_THRESHOLD);
                console.log(`[${new Date().toISOString()}] ✅ SOL BUY detected: ${Math.abs(nativeSolChange).toFixed(6)} SOL → ${relevantTokens.length} tokens`);
                return {
                    transactionType: 'buy',
                    solAmount: Math.abs(nativeSolChange),
                    relevantTokenChanges: relevantTokens
                };
            } else if (nativeSolChange > NATIVE_SOL_CHANGE_THRESHOLD && tokenOnlyChanges.some(tc => tc.change < -TOKEN_THRESHOLD)) {
                // SOL получен + токены потрачены = продажа за SOL
                const relevantTokens = tokenOnlyChanges.filter(tc => tc.change < -TOKEN_THRESHOLD);
                console.log(`[${new Date().toISOString()}] ✅ SOL SELL detected: ${relevantTokens.length} tokens → ${nativeSolChange.toFixed(6)} SOL`);
                return {
                    transactionType: 'sell',
                    solAmount: nativeSolChange,
                    relevantTokenChanges: relevantTokens.map(rt => ({...rt, change: Math.abs(rt.change)}))
                };
            }
        }
        
        // ========== СЦЕНАРИЙ 2: ТОРГОВЛЯ ЧЕРЕЗ СТЕЙБЛКОИНЫ ==========
        if (stablecoinChanges.length > 0 && tokenOnlyChanges.length > 0) {
            console.log(`[${new Date().toISOString()}] 💱 Stablecoin trading detected`);
            
            // Ищем основную валюту торговли (самое большое изменение стейблкоина)
            const primaryStablecoin = stablecoinChanges.reduce((max, current) => 
                Math.abs(current.change) > Math.abs(max.change) ? current : max
            );
            
            console.log(`[${new Date().toISOString()}] 💰 Primary trading currency: ${primaryStablecoin.stablecoinInfo.symbol} change: ${primaryStablecoin.change.toFixed(6)}`);
            
            if (primaryStablecoin.change < -STABLECOIN_THRESHOLD) { // Стейблкоин потрачен
                // Покупка токенов за стейблкоин
                const boughtTokens = tokenOnlyChanges.filter(tc => tc.change > TOKEN_THRESHOLD);
                if (boughtTokens.length > 0) {
                    const solEquivalent = this.convertToSolEquivalent(Math.abs(primaryStablecoin.change), primaryStablecoin.stablecoinInfo.symbol);
                    console.log(`[${new Date().toISOString()}] ✅ STABLECOIN BUY detected: ${Math.abs(primaryStablecoin.change).toFixed(6)} ${primaryStablecoin.stablecoinInfo.symbol} → ${boughtTokens.length} tokens (${solEquivalent.toFixed(6)} SOL equiv)`);
                    return {
                        transactionType: 'buy',
                        solAmount: solEquivalent,
                        relevantTokenChanges: boughtTokens,
                        primaryCurrency: primaryStablecoin.stablecoinInfo.symbol
                    };
                }
            } else if (primaryStablecoin.change > STABLECOIN_THRESHOLD) { // Стейблкоин получен
                // Продажа токенов за стейблкоин
                const soldTokens = tokenOnlyChanges.filter(tc => tc.change < -TOKEN_THRESHOLD);
                if (soldTokens.length > 0) {
                    const solEquivalent = this.convertToSolEquivalent(primaryStablecoin.change, primaryStablecoin.stablecoinInfo.symbol);
                    console.log(`[${new Date().toISOString()}] ✅ STABLECOIN SELL detected: ${soldTokens.length} tokens → ${primaryStablecoin.change.toFixed(6)} ${primaryStablecoin.stablecoinInfo.symbol} (${solEquivalent.toFixed(6)} SOL equiv)`);
                    return {
                        transactionType: 'sell',
                        solAmount: solEquivalent,
                        relevantTokenChanges: soldTokens.map(st => ({...st, change: Math.abs(st.change)})),
                        primaryCurrency: primaryStablecoin.stablecoinInfo.symbol
                    };
                }
            }
        }
        
        // ========== СЦЕНАРИЙ 3: ТОЛЬКО WRAPPED SOL ==========
        const wsolChange = stablecoinChanges.find(sc => sc.mint === 'So11111111111111111111111111111111111111112');
        if (wsolChange && tokenOnlyChanges.length > 0 && Math.abs(nativeSolChange) < NATIVE_SOL_CHANGE_THRESHOLD) {
            console.log(`[${new Date().toISOString()}] 🔄 Wrapped SOL trading detected`);
            
            if (wsolChange.change < -TOKEN_THRESHOLD && tokenOnlyChanges.some(tc => tc.change > TOKEN_THRESHOLD)) {
                // WSOL потрачен + токены получены = покупка
                const relevantTokens = tokenOnlyChanges.filter(tc => tc.change > TOKEN_THRESHOLD);
                console.log(`[${new Date().toISOString()}] ✅ WSOL BUY detected: ${Math.abs(wsolChange.change).toFixed(6)} WSOL → ${relevantTokens.length} tokens`);
                return {
                    transactionType: 'buy',
                    solAmount: Math.abs(wsolChange.change),
                    relevantTokenChanges: relevantTokens
                };
            } else if (wsolChange.change > TOKEN_THRESHOLD && tokenOnlyChanges.some(tc => tc.change < -TOKEN_THRESHOLD)) {
                // WSOL получен + токены потрачены = продажа
                const relevantTokens = tokenOnlyChanges.filter(tc => tc.change < -TOKEN_THRESHOLD);
                console.log(`[${new Date().toISOString()}] ✅ WSOL SELL detected: ${relevantTokens.length} tokens → ${wsolChange.change.toFixed(6)} WSOL`);
                return {
                    transactionType: 'sell',
                    solAmount: wsolChange.change,
                    relevantTokenChanges: relevantTokens.map(rt => ({...rt, change: Math.abs(rt.change)}))
                };
            }
        }
        
        console.log(`[${new Date().toISOString()}] ❓ No clear trading pattern detected`);
        console.log(`[${new Date().toISOString()}] 🔍 Summary: SOL change: ${nativeSolChange.toFixed(6)}, Stablecoins: ${stablecoinChanges.length}, Tokens: ${tokenOnlyChanges.length}`);
        return null;
    }

    // Вспомогательный метод для конвертации стейблкоинов в SOL эквивалент
    convertToSolEquivalent(amount, currency) {
        // Примерные курсы для отображения в SOL эквиваленте
        const SOL_PRICE_USD = 150; // Примерная цена SOL в USD
        
        switch (currency) {
            case 'USDC':
            case 'USDT':
                return amount / SOL_PRICE_USD;
            case 'WSOL':
                return amount; // WSOL уже в SOL
            default:
                return amount / SOL_PRICE_USD; // По умолчанию считаем как USD
        }
    }

    // Новый метод для анализа ВСЕХ изменений токенов
   async analyzeAllTokenChanges(meta, walletIndex) {
    const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
    const tokenChanges = [];

    console.log(`[${new Date().toISOString()}] 🔍 Analyzing ALL token changes (including stablecoins)`);
    console.log(`Pre-token balances: ${meta.preTokenBalances?.length || 0}, Post-token balances: ${meta.postTokenBalances?.length || 0}`);

    // Получаем адрес целевого кошелька из accountKeys
    let targetWalletAddress = null;
    if (walletIndex >= 0 && meta.preBalances && meta.postBalances) {
        // Извлекаем адрес кошелька из transaction.message.accountKeys по индексу
        const tx = meta; // Предполагаем, что meta содержит полную информацию о транзакции
        // Этот адрес будет передан в функцию отдельно
    }

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

    // ГРУППИРУЕМ ПО MINT И АНАЛИЗИРУЕМ ИЗМЕНЕНИЯ ПО КОШЕЛЬКУ
    const mintChanges = new Map();

    // Анализируем каждое изменение
    for (const [key, change] of allBalanceChanges) {
        const rawChange = Number(change.postAmount) - Number(change.preAmount);
        const uiChange = Number(change.postUiAmount) - Number(change.preUiAmount);
        
        console.log(`[${new Date().toISOString()}] 🪙 Token ${change.mint}:`);
        console.log(`  - Account Index: ${change.accountIndex}`);
        console.log(`  - Owner: ${change.owner}`);
        console.log(`  - Raw change: ${rawChange}`);
        console.log(`  - UI change: ${uiChange}`);
        console.log(`  - Decimals: ${change.decimals}`);

        // Пропускаем изменения равные нулю
        if (Math.abs(uiChange) < 0.000001) {
            console.log(`[${new Date().toISOString()}] ⏭️ Skipping zero change for ${change.mint}`);
            continue;
        }

        // НОВАЯ ЛОГИКА: сохраняем информацию о каждом изменении отдельно
        // и агрегируем только значимые изменения
        if (!mintChanges.has(change.mint)) {
            mintChanges.set(change.mint, {
                mint: change.mint,
                decimals: change.decimals,
                changes: [] // Массив всех изменений для этого токена
            });
        }

        mintChanges.get(change.mint).changes.push({
            owner: change.owner,
            accountIndex: change.accountIndex,
            uiChange: uiChange,
            rawChange: rawChange
        });
    }

    if (mintChanges.size === 0) {
        console.log(`[${new Date().toISOString()}] ⚠️ No token changes found`);
        return [];
    }

    console.log(`[${new Date().toISOString()}] 📦 Fetching metadata for ${mintChanges.size} unique tokens`);

    // Получаем метаданные токенов
    const mints = Array.from(mintChanges.keys());
    const tokenInfos = await this.batchFetchTokenMetadata(mints);

    // Создаем финальный список изменений токенов
    for (const [mint, tokenData] of mintChanges) {
        const tokenInfo = tokenInfos.get(mint) || {
            symbol: mint === WRAPPED_SOL_MINT ? 'WSOL' : 'Unknown',
            name: mint === WRAPPED_SOL_MINT ? 'Wrapped SOL' : 'Unknown Token',
            decimals: tokenData.decimals,
        };

        // НОВАЯ ЛОГИКА АГРЕГАЦИИ: ищем максимальное по модулю изменение
        // которое представляет реальную торговую операцию
        let significantChange = null;
        let maxAbsChange = 0;

        for (const change of tokenData.changes) {
            const absChange = Math.abs(change.uiChange);
            if (absChange > maxAbsChange && absChange > 0.001) { // Минимальный порог значимости
                maxAbsChange = absChange;
                significantChange = change;
            }
        }

        if (significantChange) {
            tokenChanges.push({
                mint: mint,
                change: significantChange.uiChange,
                rawChange: significantChange.rawChange,
                decimals: tokenData.decimals,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
                owner: significantChange.owner,
                accountIndex: significantChange.accountIndex
            });

            console.log(`[${new Date().toISOString()}] ✅ Added significant token change: ${tokenInfo.symbol} = ${significantChange.uiChange.toFixed(6)} (owner: ${significantChange.owner})`);
        } else {
            // Если нет значимых изменений, берем суммарное изменение
            const totalChange = tokenData.changes.reduce((sum, ch) => sum + ch.uiChange, 0);
            const totalRawChange = tokenData.changes.reduce((sum, ch) => sum + ch.rawChange, 0);
            
            if (Math.abs(totalChange) > 0.001) {
                tokenChanges.push({
                    mint: mint,
                    change: totalChange,
                    rawChange: totalRawChange,
                    decimals: tokenData.decimals,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                });

                console.log(`[${new Date().toISOString()}] ✅ Added aggregated token change: ${tokenInfo.symbol} = ${totalChange.toFixed(6)}`);
            } else {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping insignificant changes for ${tokenInfo.symbol} (total: ${totalChange.toFixed(6)})`);
            }
        }
    }

    console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} significant token changes`);
    return tokenChanges;
}

    async analyzeTokenChanges(meta, transactionType) {
        console.log(`[${new Date().toISOString()}] ⚠️ Using legacy analyzeTokenChanges - consider using analyzeAllTokenChanges instead`);
        
        // Теперь используем новый метод для всех изменений
        const allChanges = await this.analyzeAllTokenChanges(meta, -1); // -1 означает анализ всех токенов
        
        // Фильтруем только нужные изменения в зависимости от типа транзакции
        const relevantChanges = allChanges.filter(change => {
            if (transactionType === 'buy') {
                return change.change > 0; // При покупке токены увеличиваются
            } else if (transactionType === 'sell') {
                return change.change < 0; // При продаже токены уменьшаются
            }
            return true;
        });
        
        // Преобразуем в старый формат для совместимости
        return relevantChanges.map(change => ({
            mint: change.mint,
            rawChange: Math.abs(change.rawChange),
            decimals: change.decimals,
            symbol: change.symbol,
            name: change.name,
        }));
    }

    async analyzeTokenChangesVersioned(meta, transactionType, accountKeys) {
        console.log(`[${new Date().toISOString()}] ⚠️ Using legacy analyzeTokenChangesVersioned - consider using analyzeAllTokenChanges instead`);
        
        // Делегируем к новому методу
        return await this.analyzeTokenChanges(meta, transactionType);
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
            // Используем уже имеющуюся информацию о токене или получаем её
            let tokenInfo = {
                symbol: tokenChange.symbol,
                name: tokenChange.name,
                decimals: tokenChange.decimals
            };

            // Если информации нет, пытаемся получить через API
            if (!tokenInfo.symbol || tokenInfo.symbol === 'Unknown') {
                const fetchedInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
                if (fetchedInfo) {
                    tokenInfo = fetchedInfo;
                }
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
            
            // Используем change напрямую, так как он уже в правильных единицах
            const amount = Math.abs(tokenChange.change);

            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);
            
            console.log(`[${new Date().toISOString()}] 💾 Saved token operation: ${tokenInfo.symbol} amount: ${amount} type: ${transactionType}`);
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

module.exports = WalletMonitoringService;// Полная обновленная версия server/src/services/monitoringService.js