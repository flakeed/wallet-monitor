// server/src/services/priceBackfillService.js - Service to backfill historical prices

const Database = require('../database/connection');
const PriceService = require('./priceService');

class PriceBackfillService {
    constructor() {
        this.db = new Database();
        this.priceService = new PriceService();
        this.isRunning = false;
        this.processedCount = 0;
        this.errorCount = 0;
    }

    // Start the backfill process
    async start() {
        if (this.isRunning) {
            console.log(`[${new Date().toISOString()}] 🔄 Price backfill already running`);
            return;
        }

        this.isRunning = true;
        this.processedCount = 0;
        this.errorCount = 0;

        console.log(`[${new Date().toISOString()}] 🚀 Starting price backfill service...`);

        try {
            // Step 1: Backfill SOL prices for all transactions
            await this.backfillSolPrices();

            // Step 2: Backfill token prices for operations
            await this.backfillTokenPrices();

            // Step 3: Update missing SOL amounts
            await this.updateMissingSolAmounts();

            console.log(`[${new Date().toISOString()}] ✅ Price backfill completed: ${this.processedCount} processed, ${this.errorCount} errors`);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Price backfill failed:`, error);
        } finally {
            this.isRunning = false;
        }
    }

    // Backfill SOL prices for transactions
    async backfillSolPrices() {
        console.log(`[${new Date().toISOString()}] 💰 Backfilling SOL prices...`);
        
        try {
            // Get current SOL price as fallback
            const solPriceData = await this.priceService.getSolPrice();
            const currentSolPrice = solPriceData.price || 150;

            // Update all token operations without SOL price
            const query = `
                UPDATE token_operations 
                SET 
                    sol_price_usd = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE sol_price_usd IS NULL
                RETURNING id
            `;

            const result = await this.db.pool.query(query, [currentSolPrice]);
            
            console.log(`[${new Date().toISOString()}] ✅ Updated SOL price for ${result.rowCount} token operations`);
            this.processedCount += result.rowCount;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error backfilling SOL prices:`, error);
            this.errorCount++;
        }
    }

    // Backfill token prices for recent operations
    async backfillTokenPrices() {
        console.log(`[${new Date().toISOString()}] 🪙 Backfilling token prices...`);

        try {
            // Get tokens with missing prices (last 7 days)
            const tokensToProcess = await this.db.getTokensWithMissingPrices(50);
            
            console.log(`[${new Date().toISOString()}] 📋 Found ${tokensToProcess.length} tokens needing price data`);

            const batchSize = 10;
            for (let i = 0; i < tokensToProcess.length; i += batchSize) {
                const batch = tokensToProcess.slice(i, i + batchSize);
                
                await Promise.all(batch.map(async (tokenInfo) => {
                    try {
                        await this.backfillTokenPrice(tokenInfo);
                    } catch (error) {
                        console.error(`[${new Date().toISOString()}] ❌ Error backfilling ${tokenInfo.symbol}:`, error.message);
                        this.errorCount++;
                    }
                }));

                // Small delay between batches
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error in token price backfill:`, error);
            this.errorCount++;
        }
    }

    // Backfill price for a specific token
    async backfillTokenPrice(tokenInfo) {
        const { mint, symbol, operations_without_price } = tokenInfo;
        
        try {
            console.log(`[${new Date().toISOString()}] 🔍 Processing ${symbol} (${operations_without_price} operations)`);

            // Try to get current price from price service
            const prices = await this.priceService.getTokenPrices([mint]);
            const priceData = prices.get(mint);

            let tokenPriceUsd = 0;
            if (priceData && priceData.price > 0) {
                tokenPriceUsd = priceData.price;
                console.log(`[${new Date().toISOString()}] 💲 Found current price for ${symbol}: $${tokenPriceUsd}`);
            } else {
                // Try alternative price lookup methods
                tokenPriceUsd = await this.getAlternativeTokenPrice(mint, symbol);
                
                if (tokenPriceUsd === 0) {
                    console.log(`[${new Date().toISOString()}] ⚠️ No price found for ${symbol}, using $0`);
                }
            }

            // Update token operations with the price
            const updateCount = await this.db.updateHistoricalPricesForToken(mint, tokenPriceUsd);
            
            if (updateCount > 0) {
                console.log(`[${new Date().toISOString()}] ✅ Updated ${updateCount} operations for ${symbol}`);
                this.processedCount += updateCount;
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error processing ${symbol}:`, error.message);
            throw error;
        }
    }

    // Alternative price lookup methods
    async getAlternativeTokenPrice(mint, symbol) {
        try {
            // Method 1: Try DexScreener API directly
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
                timeout: 10000
            });

            if (response.ok) {
                const data = await response.json();
                if (data.pairs && data.pairs.length > 0) {
                    const bestPair = data.pairs.reduce((prev, current) =>
                        (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
                    );
                    
                    const price = parseFloat(bestPair.priceUsd || 0);
                    if (price > 0) {
                        console.log(`[${new Date().toISOString()}] 🎯 Alternative price for ${symbol}: $${price}`);
                        return price;
                    }
                }
            }

            // Method 2: Try Jupiter price API
            try {
                const jupiterResponse = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`, {
                    timeout: 10000
                });
                
                if (jupiterResponse.ok) {
                    const jupiterData = await jupiterResponse.json();
                    if (jupiterData.data && jupiterData.data[mint] && jupiterData.data[mint].price > 0) {
                        const price = jupiterData.data[mint].price;
                        console.log(`[${new Date().toISOString()}] 🪐 Jupiter price for ${symbol}: $${price}`);
                        return price;
                    }
                }
            } catch (jupiterError) {
                console.log(`[${new Date().toISOString()}] ⚠️ Jupiter price lookup failed for ${symbol}`);
            }

            return 0;
        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Alternative price lookup failed for ${symbol}:`, error.message);
            return 0;
        }
    }

    // Update missing SOL amounts in token operations
    async updateMissingSolAmounts() {
        console.log(`[${new Date().toISOString()}] 🔧 Updating missing SOL amounts...`);

        try {
            const query = `
                UPDATE token_operations 
                SET sol_amount = CASE 
                    WHEN operation_type = 'buy' THEN 
                        (SELECT t.sol_spent FROM transactions t WHERE t.id = token_operations.transaction_id)
                    WHEN operation_type = 'sell' THEN 
                        (SELECT t.sol_received FROM transactions t WHERE t.id = token_operations.transaction_id)
                    ELSE 0
                END
                WHERE sol_amount IS NULL
                RETURNING id
            `;

            const result = await this.db.pool.query(query);
            
            console.log(`[${new Date().toISOString()}] ✅ Updated SOL amounts for ${result.rowCount} token operations`);
            this.processedCount += result.rowCount;

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error updating SOL amounts:`, error);
            this.errorCount++;
        }
    }

    // Get backfill status
    getStatus() {
        return {
            isRunning: this.isRunning,
            processedCount: this.processedCount,
            errorCount: this.errorCount,
            successRate: this.processedCount + this.errorCount > 0 ? 
                (this.processedCount / (this.processedCount + this.errorCount)) * 100 : 0
        };
    }

    // Clean up old price cache
    async cleanupPriceCache() {
        try {
            const query = `
                DELETE FROM token_operations 
                WHERE updated_at < NOW() - INTERVAL '30 days'
                AND token_price_usd = 0
                AND sol_amount = 0
            `;

            const result = await this.db.pool.query(query);
            console.log(`[${new Date().toISOString()}] 🧹 Cleaned up ${result.rowCount} stale price records`);

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Error cleaning price cache:`, error);
        }
    }

    // Schedule regular price updates
    scheduleRegularUpdates() {
        console.log(`[${new Date().toISOString()}] ⏰ Scheduling regular price updates...`);

        // Update prices every 6 hours
        setInterval(async () => {
            if (!this.isRunning) {
                console.log(`[${new Date().toISOString()}] 🔄 Starting scheduled price backfill...`);
                await this.start();
            }
        }, 6 * 60 * 60 * 1000); // 6 hours

        // Cleanup old data weekly
        setInterval(async () => {
            await this.cleanupPriceCache();
        }, 7 * 24 * 60 * 60 * 1000); // 7 days
    }

    async close() {
        this.isRunning = false;
        await this.priceService.close();
        await this.db.close();
        console.log(`[${new Date().toISOString()}] ✅ Price backfill service closed`);
    }
}

module.exports = PriceBackfillService;