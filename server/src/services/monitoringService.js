const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');
const Redis = require('ioredis');

class WalletMonitoringService {
    constructor() {
        this.db = new Database();
        this.connection = new Connection('http://45.134.108.167:5005', 'confirmed');
        this.isMonitoring = true;
        this.processedSignatures = new Set();
        this.stats = {
            totalScans: 0,
            totalWallets: 0,
            totalBuyTransactions: 0,
            totalSellTransactions: 0,
            errors: 0,
            lastScanDuration: 0
        };
        this.redis = new Redis(process.env.REDIS_URL || 'redis://default:CwBXeFAGuARpNfwwziJyFttVApFFFyGD@switchback.proxy.rlwy.net:25212');
        this.isProcessingQueue = false;
        this.queueKey = 'webhook:queue';
    }

    async startMonitoring() {
        this.isMonitoring = true;
        console.log('▶️ Monitoring started');
    }

    async stopMonitoring() {
        this.isMonitoring = false;
        console.log('⏹️ Monitoring stopped');
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;
        while (this.isMonitoring) {
            const requestData = await this.redis.rpop(this.queueKey);
            if (!requestData) break;
            let request;
            try {
                request = JSON.parse(requestData);
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Invalid queue entry:`, error.message);
                continue;
            }
            const { requestId, signature, walletAddress } = request;
            console.log(`[${new Date().toISOString()}] 🔄 Processing queued signature ${signature} (requestId: ${requestId})`);
            try {
                const wallet = await this.db.getWalletByAddress(walletAddress);
                if (!wallet) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
                    continue;
                }
                const sigStatus = await this.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
                if (!sigStatus.value || sigStatus.value.err) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ Invalid or failed transaction ${signature}`);
                    continue;
                }
                const blockTime = sigStatus.value.blockTime;
                if (!blockTime) {
                    console.warn(`[${new Date().toISOString()}] ⚠️ No blockTime for signature ${signature}`);
                    continue;
                }
                const sigObject = { signature, blockTime };
                const txData = await this.processTransaction(sigObject, wallet);
                if (txData) {
                    console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature} for wallet ${walletAddress}`);
                    // Emit transaction to frontend via WebSocket
                    await this.redis.publish('transactions', JSON.stringify({
                        ...txData,
                        wallet: { address: wallet.address, name: wallet.name }
                    }));
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${signature}:`, error.message);
                this.stats.errors++;
            }
            await new Promise(resolve => setTimeout(resolve, 50)); // Reduced delay for faster processing
        }
        this.isProcessingQueue = false;
        const queueLength = await this.redis.llen(this.queueKey);
        if (queueLength > 0) {
            setImmediate(() => this.processQueue());
        }
    }

    async processWebhookMessage(message) {
        if (!this.isMonitoring) return;
        const { signature, walletAddress } = message;
        const requestId = require('uuid').v4();
        await this.redis.lpush(this.queueKey, JSON.stringify({
            requestId,
            signature,
            walletAddress,
            timestamp: Date.now()
        }));
        console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature} with requestId ${requestId}`);
        if (!this.isProcessingQueue) {
            setImmediate(() => this.processQueue());
        }
    }

    async processTransaction(sig, wallet) {
        try {
            if (!sig.signature || !sig.blockTime) return null;
            const tx = await this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0
            });
            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) return null;
            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            let transactionType, solAmount;
            if (solChange < 0) {
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
            } else if (solChange > 0.001) {
                transactionType = 'sell';
                solAmount = solChange;
            } else {
                return null;
            }
            const tokenChanges = this.analyzeTokenChanges(tx.meta, transactionType);
            if (tokenChanges.length === 0) return null;
            return await this.db.withTransaction(async (client) => {
                const solPrice = await fetchHistoricalSolPrice(new Date(sig.blockTime * 1000));
                const usdAmount = solPrice * solAmount;
                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        ${transactionType === 'buy' ? 'sol_spent, usd_spent' : 'sol_received, usd_received'}
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (signature) DO NOTHING
                    RETURNING id, signature, transaction_type
                `;
                let result;
                try {
                    result = await client.query(query, [
                        wallet.id,
                        sig.signature,
                        new Date(sig.blockTime * 1000).toISOString(),
                        transactionType,
                        solAmount,
                        usdAmount
                    ]);
                } catch (error) {
                    if (error.code === '23505') return null;
                    throw error;
                }
                const transaction = result.rows[0];
                if (!transaction) return null;
                for (const tokenChange of tokenChanges) {
                    await this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType);
                }
                return {
                    signature: sig.signature,
                    type: transactionType,
                    solAmount,
                    usdAmount,
                    tokensChanged: tokenChanges.length
                };
            });
        } catch (error) {
            console.error(`❌ Error processing transaction ${sig.signature}:`, error.message);
            return null;
        }
    }

    analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];
        (meta.postTokenBalances || []).forEach((post) => {
            const pre = meta.preTokenBalances?.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
            if (!pre) return;
            if (post.mint === WRAPPED_SOL_MINT) return;
            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            if (transactionType === 'buy' && rawChange <= 0) return;
            if (transactionType === 'sell' && rawChange >= 0) return;
            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange),
                decimals: post.uiTokenAmount.decimals
            });
        });
        return tokenChanges;
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.connection);
            if (!tokenInfo) return;
            const tokenUpsertQuery = `
                INSERT INTO tokens (mint, symbol, name, logo_uri, decimals) 
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (mint) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    logo_uri = EXCLUDED.logo_uri,
                    decimals = EXCLUDED.decimals,
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
            `;
            const tokenResult = await client.query(tokenUpsertQuery, [
                tokenChange.mint,
                tokenInfo.symbol,
                tokenInfo.name,
                tokenInfo.logoURI,
                tokenInfo.decimals
            ]);
            const tokenId = tokenResult.rows[0].id;
            const amount = tokenChange.rawChange / Math.pow(10, tokenChange.decimals);
            const operationQuery = `
                INSERT INTO token_operations (transaction_id, token_id, amount, operation_type) 
                VALUES ($1, $2, $3, $4)
            `;
            await client.query(operationQuery, [transactionId, tokenId, amount, transactionType]);
        } catch (error) {
            console.error(`❌ Error saving token operation for ${tokenChange.mint}:`, error.message);
            throw error;
        }
    }

    async addWallet(address, name = null) {
        try {
            new PublicKey(address);
            const wallet = await this.db.addWallet(address, name);
            console.log(`✅ Added wallet for monitoring: ${name || address.slice(0, 8)}...`);
            // Subscribe to wallet transactions via WebSocket
            await this.redis.publish('wallet:subscribe', JSON.stringify({ address }));
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
                    .filter(tx => tx.wallet_address === address)
                    .map(tx => tx.signature);
                walletSignatures.forEach(sig => this.processedSignatures.delete(sig));
                await this.db.removeWallet(address);
                console.log(`🗑️ Removed wallet and associated data: ${address.slice(0, 8)}...`);
                // Unsubscribe from wallet transactions
                await this.redis.publish('wallet:unsubscribe', JSON.stringify({ address }));
            } else {
                throw new Error('Wallet not found');
            }
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            processedSignatures: this.processedSignatures.size,
            stats: {
                ...this.stats,
                uptime: this.isMonitoring ? Date.now() - (this.stats.startTime || Date.now()) : 0
            }
        };
    }

    async close() {
        this.stopMonitoring();
        await this.redis.quit();
        await this.db.close();
    }
}

module.exports = WalletMonitoringService;