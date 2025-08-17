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
            RossettaCode: 0,
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
                                stablecoinAmount: txData.stablecoinAmount || 0,
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
                console.log(`  - Post-token balances: ${ getPostTokenBalancesLength(tx) }`);
    
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

    // Helper function to safely get postTokenBalances length
    getPostTokenBalancesLength(tx) {
        if (!tx.meta) return 0;
        if (Array.isArray(tx.meta.postTokenBalances)) {
            return tx.meta.postTokenBalances.length;
        }
        // Handle versioned transactions with different structure
        if (tx.meta.postTokenBalances && typeof tx.meta.postTokenBalances === 'object') {
            return Object.keys(tx.meta.postTokenBalances).length;
        }
        return 0;
    }

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
                return null;
            }

            const existingTx = await this.db.pool.query(
                'SELECT id FROM transactions WHERE signature = $1 AND wallet_id = $2',
                [sig.signature, wallet.id]
            );
            if (existingTx.rows.length > 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed for wallet ${wallet.address}`);
                return null;
            }

            const processedKey = `${sig.signature}-${wallet.id}`;
            if (this.recentlyProcessed.has(processedKey)) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} recently processed for wallet ${wallet.address}`);
                return null;
            }

            this.recentlyProcessed.add(processedKey);

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

            const walletPubkey = wallet.address;
            let walletIndex = -1;
            
            if (tx.transaction.message.accountKeys) {
                if (Array.isArray(tx.transaction.message.accountKeys)) {
                    walletIndex = tx.transaction.message.accountKeys.findIndex(
                        (key) => key.pubkey ? key.pubkey.toString() === walletPubkey : key.toString() === walletPubkey
                    );
                } else if (tx.transaction.message.staticAccountKeys) {
                    walletIndex = tx.transaction.message.staticAccountKeys.findIndex(
                        (key) => key.toString() === walletPubkey
                    );
                }

                if (walletIndex === -1 && tx.transaction.message.addressTableLookups) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Versioned transaction with address table lookups not fully supported yet`);
                    return null;
                }
            }

            if (walletIndex === -1) {
                console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletPubkey} not found in transaction ${sig.signature}`);
                return null;
            }

            // Analyze SOL balance change
            const preBalance = tx.meta.preBalances[walletIndex] || 0;
            const postBalance = tx.meta.postBalances[walletIndex] || 0;
            const solChange = (postBalance - preBalance) / 1e9;

            console.log(`[${new Date().toISOString()}] 💰 SOL balance change for ${walletPubkey}:`);
            console.log(`  - Pre: ${(preBalance / 1e9).toFixed(6)} SOL`);
            console.log(`  - Post: ${(postBalance / 1e9).toFixed(6)} SOL`);
            console.log(`  - Change: ${solChange.toFixed(6)} SOL`);

            let transactionType, solAmount, stablecoinAmount;
            const STABLECOIN_MINTS = {
                USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KHa7BipbFuVvLzo5v6jV',
                // Add other stablecoin mints as needed
            };

            // Analyze token changes first to determine transaction type
            let tokenChanges = [];
            if (tx.version === 0 || tx.version === null || tx.version === undefined) {
                tokenChanges = await this.analyzeTokenChanges(tx.meta, walletPubkey);
            } else {
                tokenChanges = await this.analyzeTokenChangesVersioned(tx.meta, walletPubkey, tx.transaction.message.accountKeys);
            }

            // Determine transaction type based on token changes and SOL/stablecoin movements
            const hasValidTokenChanges = tokenChanges.some(change => 
                change.isValid && change.mint !== STABLECOIN_MINTS.USDC && change.mint !== STABLECOIN_MINTS.USDT
            );

            if (!hasValidTokenChanges) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no valid token changes detected`);
                return null;
            }

            // Check for stablecoin-based transactions
            const stablecoinChanges = tokenChanges.filter(change => 
                change.mint === STABLECOIN_MINTS.USDC || change.mint === STABLECOIN_MINTS.USDT
            );

            const nonStablecoinChanges = tokenChanges.filter(change => 
                change.mint !== STABLECOIN_MINTS.USDC && change.mint !== STABLECOIN_MINTS.USDT
            );

            if (stablecoinChanges.length > 0 && nonStablecoinChanges.length > 0) {
                // Stablecoin-based swap detected
                const stablecoinChange = stablecoinChanges.reduce((sum, change) => sum + change.rawChange, 0);
                const tokenChange = nonStablecoinChanges.reduce((sum, change) => sum + change.rawChange, 0);

                if (stablecoinChange < 0 && tokenChange > 0) {
                    transactionType = 'buy';
                    stablecoinAmount = Math.abs(stablecoinChange) / 1e6; // Assuming 6 decimals for USDC/USDT
                    solAmount = 0;
                    console.log(`[${new Date().toISOString()}] 🛒 Detected STABLECOIN BUY: spent ${stablecoinAmount.toFixed(6)} stablecoin`);
                } else if (stablecoinChange > 0 && tokenChange < 0) {
                    transactionType = 'sell';
                    stablecoinAmount = stablecoinChange / 1e6;
                    solAmount = 0;
                    console.log(`[${new Date().toISOString()}] 💸 Detected STABLECOIN SELL: received ${stablecoinAmount.toFixed(6)} stablecoin`);
                } else {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - inconsistent stablecoin/token changes`);
                    return null;
                }
            } else {
                // SOL-based transaction
                const FEE_THRESHOLD = 0.01;
                if (solChange < -FEE_THRESHOLD) {
                    transactionType = 'buy';
                    solAmount = Math.abs(solChange);
                    stablecoinAmount = 0;
                    console.log(`[${new Date().toISOString()}] 🛒 Detected SOL BUY: spent ${solAmount.toFixed(6)} SOL`);
                } else if (solChange > 0.001) {
                    transactionType = 'sell';
                    solAmount = solChange;
                    stablecoinAmount = 0;
                    console.log(`[${new Date().toISOString()}] 💸 Detected SOL SELL: received ${solAmount.toFixed(6)} SOL`);
                } else {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange.toFixed(6)} (likely just fees)`);
                    return null;
                }
            }

            if (tokenChanges.length === 0) {
                console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
                console.log(`[${new Date().toISOString()}] 🔍 Enhanced debug info for ${sig.signature}:`);
                console.log(`  - Transaction version: ${tx.version}`);
                console.log(`  - Pre-token balances: ${JSON.stringify(tx.meta.preTokenBalances?.map(b => ({mint: b.mint, amount: b.uiTokenAmount.uiAmount})) || [])}`);
                console.log(`  - Post-token balances: ${JSON.stringify(tx.meta.postTokenBalances?.map(b => ({mint: b.mint, amount: b.uiTokenAmount.uiAmount})) || [])}`);
                console.log(`  - Instructions count: ${tx.transaction.message.instructions?.length || 0}`);
                console.log(`  - Inner instructions: ${tx.meta.innerInstructions?.length || 0}`);
                
                if (tx.transaction.message.instructions) {
                    tx.transaction.message.instructions.forEach((instruction, index) => {
                        const programIdIndex = instruction.programIdIndex;
                        let programId = 'Unknown';
                        if (tx.transaction.message.accountKeys && tx.transaction.message.accountKeys[programIdIndex]) {
                            programId = tx.transaction.message.accountKeys[programIdIndex].pubkey?.toString() || tx.transaction.message.accountKeys[programIdIndex].toString();
                        }
                        console.log(`  - Instruction ${index}: Program ${programId}`);
                    });
                }
                
                return null;
            }

            console.log(`[${new Date().toISOString()}] ✅ Found ${tokenChanges.length} token changes, saving transaction`);

            return await this.db.withTransaction(async (client) => {
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
                        sol_spent, sol_received, stablecoin_spent, stablecoin_received
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id, signature, transaction_type
                `;
                const result = await client.query(query, [
                    wallet.id,
                    sig.signature,
                    new Date(sig.blockTime * 1000).toISOString(),
                    transactionType,
                    transactionType === 'buy' ? solAmount : 0,
                    transactionType === 'sell' ? solAmount : 0,
                    transactionType === 'buy' ? stablecoinAmount : 0,
                    transactionType === 'sell' ? stablecoinAmount : 0,
                ]);

                if (result.rows.length === 0) {
                    console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} was already inserted by another process`);
                    return null;
                }

                const transaction = result.rows[0];
                
                const tokenSavePromises = tokenChanges
                    .filter(change => change.isValid && change.mint !== STABLECOIN_MINTS.USDC && change.mint !== STABLECOIN_MINTS.USDT)
                    .map((tokenChange) =>
                        this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
                    );
                await Promise.all(tokenSavePromises);

                console.log(`[${new Date().toISOString()}] ✅ Successfully saved transaction ${sig.signature} with ${tokenChanges.length} token operations`);

                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    stablecoinAmount,
                    tokensChanged: tokenChanges.filter(change => 
                        change.isValid && change.mint !== STABLECOIN_MINTS.USDC && change.mint !== STABLECOIN_MINTS.USDT
                    ),
                };
            });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing transaction ${sig.signature}:`, error.message);
            console.error(`[${new Date().toISOString()}] ❌ Stack trace:`, error.stack);
            return null;
        }
    }

    async analyzeTokenChangesVersioned(meta, walletPubkey, accountKeys) {
        const STABLECOIN_MINTS = {
            USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KHa7BipbFuVvLzo5v6jV',
        };
        const tokenChanges = [];
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing versioned transaction token changes`);
        
        if (!meta.preTokenBalances || !meta.postTokenBalances) {
            console.log(`[${new Date().toISOString()}] ⚠️ No token balance data in transaction`);
            return [];
        }
    
        const mintChanges = new Map();
        const allBalanceChanges = new Map();
    
        for (const preBalance of meta.preTokenBalances) {
            const key = `${preBalance.mint}-${preBalance.accountIndex}`;
            allBalanceChanges.set(key, {
                mint: preBalance.mint,
                accountIndex: preBalance.accountIndex,
                owner: preBalance.owner,
                preAmount: preBalance.uiTokenAmount.amount,
                preUiAmount: preBalance.uiTokenAmount.uiAmount,
                decimals: preBalance.uiTokenAmount.decimals,
                postAmount: '0',
                postUiAmount: 0
            });
        }
    
        for (const postBalance of meta.postTokenBalances) {
            const key = `${postBalance.mint}-${postBalance.accountIndex}`;
            if (!allBalanceChanges.has(key)) {
                allBalanceChanges.set(key, {
                    mint: postBalance.mint,
                    accountIndex: postBalance.accountIndex,
                    owner: postBalance.owner,
                    preAmount: '0',
                    preUiAmount: 0,
                    decimals: postBalance.uiTokenAmount.decimals,
                    postAmount: postBalance.uiTokenAmount.amount,
                    postUiAmount: postBalance.uiTokenAmount.uiAmount
                });
            } else {
                const existing = allBalanceChanges.get(key);
                existing.postAmount = postBalance.uiTokenAmount.amount;
                existing.postUiAmount = postBalance.uiTokenAmount.uiAmount;
            }
        }
    
        console.log(`[${new Date().toISOString()}] 📊 Found ${allBalanceChanges.size} token balance changes`);
    
        for (const [key, change] of allBalanceChanges) {
            if (change.owner !== walletPubkey) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping change for non-wallet owner: ${change.owner}`);
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
    
            let isValidChange = rawChange !== 0;
            
            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += Math.abs(rawChange);
                    console.log(`[${new Date().toISOString()}] 📈 Aggregating change for ${change.mint}: ${existing.totalRawChange} total`);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: rawChange,
                        isValid: true
                    });
                    console.log(`[${new Date().toISOString()}] 🆕 New mint change: ${change.mint} = ${rawChange}`);
                }
            }
        }
    
        if (mintChanges.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found`);
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
                isValid: aggregatedChange.isValid
            });
    
            console.log(`[${new Date().toISOString()}] ✅ Added token change: ${tokenInfo.symbol} (${aggregatedChange.totalRawChange} total raw units)`);
        }
    
        console.log(`[${new Date().toISOString()}] 🎯 Final result: ${tokenChanges.length} unique token changes`);
        return tokenChanges;
    }

    async analyzeTokenChanges(meta, walletPubkey) {
        const STABLECOIN_MINTS = {
            USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KHa7BipbFuVvLzo5v6jV',
        };
        const tokenChanges = [];
    
        console.log(`[${new Date().toISOString()}] 🔍 Analyzing token changes for wallet ${walletPubkey}`);
    
        if (!meta.preTokenBalances || !meta.postTokenBalances) {
            console.log(`[${new Date().toISOString()}] ⚠️ No token balance data in transaction`);
            return [];
        }
    
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
            if (change.owner !== walletPubkey) {
                console.log(`[${new Date().toISOString()}] ⏭️ Skipping change for non-wallet owner: ${change.owner}`);
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
    
            let isValidChange = rawChange !== 0;
            
            if (isValidChange) {
                if (mintChanges.has(change.mint)) {
                    const existing = mintChanges.get(change.mint);
                    existing.totalRawChange += rawChange;
                    console.log(`[${new Date().toISOString()}] 📈 Aggregating change for ${change.mint}: ${existing.totalRawChange} total`);
                } else {
                    mintChanges.set(change.mint, {
                        mint: change.mint,
                        decimals: change.decimals,
                        totalRawChange: rawChange,
                        isValid: true
                    });
                    console.log(`[${new Date().toISOString()}] 🆕 New mint change: ${change.mint} = ${rawChange}`);
                }
            }
        }
    
        if (mintChanges.size === 0) {
            console.log(`[${new Date().toISOString()}] ⚠️ No valid token changes found`);
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
                isValid: aggregatedChange.isValid
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
                this.recentlyProcessed.clear();
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