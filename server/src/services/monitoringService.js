const { Connection, PublicKey } = require('@solana/web3.js');
const { fetchTokenMetadata, fetchHistoricalSolPrice, redis } = require('./tokenService');
const Database = require('../database/connection');
const { Queue, Worker } = require('bullmq');
const pLimit = require('p-limit');
const zlib = require('zlib');
const util = require('util');
const prom = require('prom-client');

const compress = util.promisify(zlib.deflate);
const decompress = util.promisify(zlib.inflate);
const limit = pLimit(10);

class ConnectionPool {
  constructor() {
    this.rpcNodes = [
      process.env.SOLANA_RPC_URL || 'http://45.134.108.167:5005',
      'https://api.mainnet-beta.solana.com',
    ];
    this.connections = this.rpcNodes.map(url => new Connection(url, 'confirmed'));
    this.currentIndex = 0;
  }

  getConnection() {
    const conn = this.connections[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;
    return conn;
  }
}

class WalletMonitoringService {
  constructor() {
    this.db = new Database();
    this.connectionPool = new ConnectionPool();
    this.isMonitoring = false;
    this.stats = {
      totalScans: 0,
      totalWallets: 0,
      totalBuyTransactions: 0,
      totalSellTransactions: 0,
      errors: 0,
      lastScanDuration: 0,
      startTime: Date.now()
    };
    this.redis = redis;
    this.queue = new Queue('transactions', {
      connection: {
        host: 'switchback.proxy.rlwy.net',
        port: 25212,
        password: 'CwBXeFAGuARpNfwwziJyFttVApFFFyGD'
      }
    });
    this.worker = new Worker('transactions', async job => {
      const end = prom.Histogram.startTimer('transaction_process_duration_seconds');
      try {
        const { signature, walletAddress, blockTime } = job.data;
        const wallet = await this.db.getWalletByAddress(walletAddress);
        if (!wallet) {
          console.warn(`[${new Date().toISOString()}] ⚠️ Wallet ${walletAddress} not found`);
          return;
        }
        const txData = await this.processTransaction({ signature, blockTime }, wallet);
        if (txData) {
          console.log(`[${new Date().toISOString()}] ✅ Processed transaction ${signature}`);
          await this.redis.publish('transactions', JSON.stringify({
            signature,
            walletAddress,
            transactionType: txData.type,
            solAmount: txData.solAmount,
            usdAmount: txData.usdAmount,
            tokens: txData.tokensChanged.map(tc => ({
              mint: tc.mint,
              amount: tc.rawChange / Math.pow(10, tc.decimals),
              symbol: tc.symbol,
              name: tc.name,
              logoURI: tc.logoURI
            })),
            timestamp: new Date(blockTime * 1000).toISOString()
          }));
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error processing signature ${job.data.signature}:`, error.message);
      } finally {
        end();
      }
    }, {
      connection: {
        host: 'switchback.proxy.rlwy.net',
        port: 25212,
        password: 'CwBXeFAGuARpNfwwziJyFttVApFFFyGD'
      },
      concurrency: 10
    });
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

  async processWebhookMessage(message) {
    const { signature, walletAddress, blockTime } = message;
    await this.queue.add('process-tx', { signature, walletAddress, blockTime });
    console.log(`[${new Date().toISOString()}] 📤 Enqueued signature ${signature}`);
    const queueLen = await this.queue.getJobCounts();
    prom.Gauge.set('transaction_queue_length', queueLen.waiting + queueLen.active);
  }

  async processTransaction(sig, wallet) {
    return await limit(async () => {
      const cacheKey = `tx:${sig.signature}`;
      const cachedTx = await this.redis.getBuffer(cacheKey);
      if (cachedTx) {
        console.log(`[${new Date().toISOString()}] ⚡ Cache hit for transaction ${sig.signature}`);
        const decompressed = await decompress(cachedTx);
        return JSON.parse(decompressed.toString());
      }

      if (!sig.signature || !sig.blockTime) {
        console.warn(`[${new Date().toISOString()}] ⚠️ Invalid signature object:`, sig);
        return null;
      }

      const existingTx = await this.db.pool.query(
        'SELECT id FROM transactions WHERE signature = $1',
        [sig.signature]
      );
      if (existingTx.rows.length > 0) {
        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} already processed`);
        return null;
      }

      const connection = this.connectionPool.getConnection();
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || !tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) {
        console.warn(`[${new Date().toISOString()}] ⚠️ Invalid transaction ${sig.signature}`);
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
        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - SOL change too small: ${solChange}`);
        return null;
      }

      const tokenChanges = await this.analyzeTokenChanges(tx.meta, transactionType);
      if (tokenChanges.length === 0) {
        console.log(`[${new Date().toISOString()}] ℹ️ Transaction ${sig.signature} - no token changes detected`);
        return null;
      }

      return await this.db.withTransaction(async (client) => {
        const solPrices = await fetchHistoricalSolPrice([new Date(sig.blockTime * 1000)]);
        const solPrice = solPrices[sig.blockTime * 1000] || 180;
        const usdAmount = solPrice * solAmount;

        const query = `
          INSERT INTO transactions (
            wallet_id, signature, block_time, transaction_type,
            sol_spent, usd_spent, sol_received, usd_received
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
          transactionType === 'buy' ? usdAmount : 0,
          transactionType === 'sell' ? solAmount : 0,
          transactionType === 'sell' ? usdAmount : 0
        ]);

        const transaction = result.rows[0];
        const tokenSavePromises = tokenChanges.map(tokenChange => 
          this.saveTokenOperationInTransaction(client, transaction.id, tokenChange, transactionType)
        );
        await Promise.all(tokenSavePromises);

        const txData = {
          signature: sig.signature,
          type: transactionType,
          solAmount,
          usdAmount,
          tokensChanged: tokenChanges
        };

        const compressed = await compress(JSON.stringify(txData));
        await this.redis.set(cacheKey, compressed, 'EX', 3600);
        return txData;
      });
    });
  }

  async analyzeTokenChanges(meta, transactionType) {
    const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
    const tokenChanges = [];

    for (const post of meta.postTokenBalances || []) {
      const pre = meta.preTokenBalances?.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
      if (!pre || post.mint === WRAPPED_SOL_MINT) continue;

      const rawChange = Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount);
      if ((transactionType === 'buy' && rawChange <= 0) || (transactionType === 'sell' && rawChange >= 0)) continue;

      const tokenInfoMap = await fetchTokenMetadata([post.mint], this.connectionPool.getConnection());
      const tokenInfo = tokenInfoMap[post.mint];
      if (!tokenInfo) continue;

      tokenChanges.push({
        mint: post.mint,
        rawChange: Math.abs(rawChange),
        decimals: post.uiTokenAmount.decimals,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        logoURI: tokenInfo.logoURI
      });
    }

    return tokenChanges;
  }

  async saveTokenOperationInTransaction(client, transactionId, tokenChange, transactionType) {
    try {
      const tokenInfo = await fetchTokenMetadata([tokenChange.mint], this.connectionPool.getConnection());
      const tokenData = tokenInfo[tokenChange.mint];
      if (!tokenData) {
        console.warn(`[${new Date().toISOString()}] ⚠️ No metadata for token ${tokenChange.mint}`);
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
        tokenData.symbol,
        tokenData.name,
        tokenData.logoURI,
        tokenData.decimals
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

  async addWallet(address, name = null) {
    try {
      new PublicKey(address);
      const wallet = await this.db.addWallet(address, name);
      console.log(`[${new Date().toISOString()}] ✅ Added wallet: ${name || address.slice(0, 8)}...`);
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
        await this.db.removeWallet(address);
        console.log(`[${new Date().toISOString()}] 🗑️ Removed wallet: ${address.slice(0, 8)}...`);
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
      rpcEndpoint: this.connectionPool.rpcNodes,
      stats: {
        ...this.stats,
        uptime: Date.now() - this.stats.startTime
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
    this.stopMonitoring();
    await this.queue.close();
    await this.worker.close();
    await this.redis.quit();
    await this.db.close();
  }
}

module.exports = WalletMonitoringService;