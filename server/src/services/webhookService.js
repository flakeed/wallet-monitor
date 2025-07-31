const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, fetchHistoricalSolPrice } = require('./tokenService');
const Database = require('../database/connection');

class WebhookService {
    constructor() {
        this.db = new Database();
        this.heliusConnection = new Connection(process.env.HELIUS_RPC_URL, 'confirmed');
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.processedSignatures = new Set();
        this.stats = {
            totalWebhooks: 0,
            totalProcessed: 0,
            totalErrors: 0,
            lastWebhookTime: null,
            connectionTime: null
        };
        this.activeWallets = new Set();
        this.nodeBaseUrl = 'http://45.134.108.167:5005';
        this.wsUrl = 'ws://45.134.108.167:5006/ws';
    }

    async initialize() {
        try {
            await this.loadActiveWallets();
            
            await this.connect();
            
            console.log('🚀 Webhook service initialized successfully');
        } catch (error) {
            console.error('❌ Failed to initialize webhook service:', error.message);
            throw error;
        }
    }

    async loadActiveWallets() {
        try {
            const wallets = await this.db.getActiveWallets();
            this.activeWallets.clear();
            
            for (const wallet of wallets) {
                this.activeWallets.add(wallet.address);
            }
            
            console.log(`📋 Loaded ${this.activeWallets.size} active wallets for monitoring`);
        } catch (error) {
            console.error('❌ Error loading active wallets:', error.message);
            throw error;
        }
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                console.log(`🔌 Connecting to webhook node: ${this.wsUrl}`);
                
                this.ws = new WebSocket(this.wsUrl);
                
                this.ws.on('open', () => {
                    console.log('✅ Connected to webhook node');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.stats.connectionTime = new Date();
                    
                    this.subscribeToWallets();
                    resolve();
                });

                this.ws.on('message', async (data) => {
                    await this.handleWebhook(data);
                });

                this.ws.on('close', (code, reason) => {
                    console.log(`🔌 WebSocket connection closed: ${code} - ${reason}`);
                    this.isConnected = false;
                    this.scheduleReconnect();
                });

                this.ws.on('error', (error) => {
                    console.error('❌ WebSocket error:', error.message);
                    this.isConnected = false;
                    
                    if (this.reconnectAttempts === 0) {
                        reject(error);
                    }
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    subscribeToWallets() {
        if (!this.isConnected || !this.ws) {
            console.warn('⚠️ Cannot subscribe - not connected to webhook node');
            return;
        }

        const subscribeMessage = {
            type: 'subscribe',
            wallets: Array.from(this.activeWallets)
        };

        try {
            this.ws.send(JSON.stringify(subscribeMessage));
            console.log(`📡 Subscribed to ${this.activeWallets.size} wallets`);
        } catch (error) {
            console.error('❌ Error subscribing to wallets:', error.message);
        }
    }

    async handleWebhook(data) {
        try {
            this.stats.totalWebhooks++;
            this.stats.lastWebhookTime = new Date();

            const webhook = JSON.parse(data.toString());
            
            if (!webhook.signature || !webhook.walletAddress) {
                console.warn('⚠️ Invalid webhook format:', webhook);
                return;
            }

            if (!this.activeWallets.has(webhook.walletAddress)) {
                console.log(`ℹ️ Ignoring webhook for non-monitored wallet: ${webhook.walletAddress}`);
                return;
            }

            if (this.processedSignatures.has(webhook.signature)) {
                console.log(`ℹ️ Transaction already processed: ${webhook.signature}`);
                return;
            }

            console.log(`📨 Processing webhook for wallet ${webhook.walletAddress.slice(0, 8)}... tx: ${webhook.signature.slice(0, 8)}...`);

            const txData = await this.processTransactionFromHelius(webhook);
            
            if (txData) {
                this.processedSignatures.add(webhook.signature);
                this.stats.totalProcessed++;
                console.log(`✅ Successfully processed transaction: ${webhook.signature.slice(0, 8)}...`);
            }

        } catch (error) {
            console.error('❌ Error handling webhook:', error.message);
            this.stats.totalErrors++;
        }
    }

    async processTransactionFromHelius(webhook) {
        try {
            const { signature, walletAddress, blockTime } = webhook;

            const tx = await this.heliusConnection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
                console.warn(`⚠️ Invalid transaction data for ${signature}`);
                return null;
            }

            const wallet = await this.db.getWalletByAddress(walletAddress);
            if (!wallet) {
                console.warn(`⚠️ Wallet not found in database: ${walletAddress}`);
                return null;
            }

            const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
            
            let transactionType, solAmount;
            if (solChange < -0.001) { 
                transactionType = 'buy';
                solAmount = Math.abs(solChange);
            } else if (solChange > 0.001) { 
                transactionType = 'sell';
                solAmount = solChange;
            } else {
                console.log(`ℹ️ No significant SOL change in transaction ${signature}`);
                return null;
            }

            const tokenChanges = this.analyzeTokenChanges(tx.meta, transactionType);
            if (tokenChanges.length === 0) {
                console.log(`ℹ️ No token changes detected in transaction ${signature}`);
                return null;
            }

            return await this.saveTransaction(
                wallet,
                signature,
                blockTime || tx.blockTime,
                transactionType,
                solAmount,
                tokenChanges
            );

        } catch (error) {
            console.error(`❌ Error processing transaction from Helius ${webhook.signature}:`, error.message);
            return null;
        }
    }

    analyzeTokenChanges(meta, transactionType) {
        const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
        const tokenChanges = [];

        (meta.postTokenBalances || []).forEach((post) => {
            const pre = meta.preTokenBalances?.find(p =>
                p.mint === post.mint && p.accountIndex === post.accountIndex
            );

            if (!pre) return;
            if (post.mint === WRAPPED_SOL_MINT) return;

            const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
            
            if (transactionType === 'buy' && rawChange <= 0) return;
            if (transactionType === 'sell' && rawChange >= 0) return;

            tokenChanges.push({
                mint: post.mint,
                rawChange: Math.abs(rawChange),
                decimals: post.uiTokenAmount.decimals,
            });
        });

        return tokenChanges;
    }

    async saveTransaction(wallet, signature, blockTime, transactionType, solAmount, tokenChanges) {
        try {
            return await this.db.withTransaction(async (client) => {
                const solPrice = await fetchHistoricalSolPrice(new Date(blockTime * 1000));
                const usdAmount = solPrice * solAmount;

                const query = `
                    INSERT INTO transactions (
                        wallet_id, signature, block_time, transaction_type,
                        ${transactionType === 'buy' ? 'sol_spent, usd_spent' : 'sol_received, usd_received'}
                    ) 
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, signature, transaction_type
                `;

                let result;
                try {
                    result = await client.query(query, [
                        wallet.id,
                        signature,
                        new Date(blockTime * 1000).toISOString(),
                        transactionType,
                        solAmount,
                        usdAmount
                    ]);
                } catch (error) {
                    if (error.code === '23505') {
                        console.log(`ℹ️ Transaction already exists: ${signature}`);
                        return null;
                    }
                    throw error;
                }

                const transaction = result.rows[0];

                for (const tokenChange of tokenChanges) {
                    await this.saveTokenOperationInTransaction(
                        client, 
                        transaction.id, 
                        tokenChange, 
                        transactionType
                    );
                }

                await this.db.updateWalletStats(wallet.id);

                console.log(`✅ Saved ${transactionType} transaction: ${signature.slice(0, 8)}... (${tokenChanges.length} tokens)`);

                return {
                    signature,
                    type: transactionType,
                    solAmount,
                    usdAmount,
                    tokensChanged: tokenChanges.length
                };
            });

        } catch (error) {
            console.error(`❌ Error saving transaction ${signature}:`, error.message);
            throw error;
        }
    }

    async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
        try {
            const tokenInfo = await fetchTokenMetadata(tokenChange.mint, this.heliusConnection);
            if (!tokenInfo) {
                console.warn(`⚠️ No metadata found for token: ${tokenChange.mint}`);
                return;
            }

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

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
            return;
        }

        this.reconnectAttempts++;
        console.log(`🔄 Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${this.reconnectDelay}ms`);

        setTimeout(async () => {
            try {
                await this.connect();
            } catch (error) {
                console.error(`❌ Reconnection attempt ${this.reconnectAttempts} failed:`, error.message);
            }
        }, this.reconnectDelay);
    }

    async addWallet(address, name = null) {
        try {
            const wallet = await this.db.addWallet(address, name);
            
            this.activeWallets.add(address);
            
            if (this.isConnected) {
                this.subscribeToWallets();
            }
            
            console.log(`✅ Added wallet for webhook monitoring: ${name || address.slice(0, 8)}...`);
            return wallet;
        } catch (error) {
            throw new Error(`Failed to add wallet: ${error.message}`);
        }
    }

    async removeWallet(address) {
        try {
            const wallet = await this.db.getWalletByAddress(address);
            if (!wallet) {
                throw new Error('Wallet not found');
            }

            await this.db.removeWallet(address);
            
            this.activeWallets.delete(address);
            
            if (this.isConnected) {
                this.subscribeToWallets();
            }
            
            const transactions = await this.db.getRecentTransactions(24 * 7);
            const walletSignatures = transactions
                .filter(tx => tx.wallet_address === address)
                .map(tx => tx.signature);
            walletSignatures.forEach(sig => this.processedSignatures.delete(sig));
            
            console.log(`🗑️ Removed wallet from webhook monitoring: ${address.slice(0, 8)}...`);
        } catch (error) {
            throw new Error(`Failed to remove wallet: ${error.message}`);
        }
    }

    getStatus() {
        return {
            isConnected: this.isConnected,
            activeWallets: this.activeWallets.size,
            processedSignatures: this.processedSignatures.size,
            reconnectAttempts: this.reconnectAttempts,
            stats: {
                ...this.stats,
                uptime: this.stats.connectionTime ? Date.now() - this.stats.connectionTime.getTime() : 0
            }
        };
    }

    async getDetailedStats() {
        try {
            const dbStats = await this.db.getMonitoringStats();
            const topTokens = await this.db.getTopTokens(5);
            return {
                ...this.getStatus(),
                database: dbStats,
                topTokens
            };
        } catch (error) {
            console.error('❌ Error getting detailed stats:', error.message);
            return this.getStatus();
        }
    }

    async close() {
        console.log('🛑 Closing webhook service...');
        
        if (this.ws) {
            this.ws.close();
        }
        
        await this.db.close();
    }

    async getWalletInfoFromNode(address) {
        try {
            const response = await fetch(`${this.nodeBaseUrl}/wallet/${address}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error(`❌ Error fetching wallet info from node for ${address}:`, error.message);
            throw error;
        }
    }

    async getNodeStats() {
        try {
            const response = await fetch(`${this.nodeBaseUrl}/stats`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('❌ Error fetching node stats:', error.message);
            throw error;
        }
    }
}

module.exports = WebhookService;