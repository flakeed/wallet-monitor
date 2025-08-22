// client/src/utils/pricePreloader.js - Price preloading utility

class PricePreloader {
    constructor() {
      this.preloadingTokens = new Set();
      this.preloadQueue = [];
      this.isProcessing = false;
      this.batchSize = 10;
      this.debounceTimeout = null;
    }
  
    // Helper function to get auth headers
    getAuthHeaders() {
      const sessionToken = localStorage.getItem('sessionToken');
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`
      };
    }
  
    // Add tokens to preload queue with debouncing
    requestPreload(mints) {
      if (!mints || mints.length === 0) return;
  
      // Add new mints to queue (avoid duplicates)
      const newMints = mints.filter(mint => !this.preloadingTokens.has(mint));
      this.preloadQueue.push(...newMints);
      newMints.forEach(mint => this.preloadingTokens.add(mint));
  
      // Debounce processing to batch requests
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = setTimeout(() => {
        this.processQueue();
      }, 200); // 200ms debounce
    }
  
    // Process the preload queue
    async processQueue() {
      if (this.isProcessing || this.preloadQueue.length === 0) return;
  
      this.isProcessing = true;
      console.log(`[PricePreloader] Processing queue with ${this.preloadQueue.length} tokens`);
  
      try {
        // Take a batch from the queue
        const batch = this.preloadQueue.splice(0, this.batchSize);
        
        if (batch.length > 0) {
          await this.preloadBatch(batch);
        }
  
        // Continue processing if there are more items
        if (this.preloadQueue.length > 0) {
          setTimeout(() => {
            this.isProcessing = false;
            this.processQueue();
          }, 100); // Small delay between batches
        } else {
          this.isProcessing = false;
        }
      } catch (error) {
        console.error('[PricePreloader] Error processing queue:', error);
        this.isProcessing = false;
      }
    }
  
    // Preload a batch of token prices
    async preloadBatch(mints) {
      try {
        const response = await fetch('/api/tokens/preload-prices', {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({ mints })
        });
  
        if (response.ok) {
          const result = await response.json();
          console.log(`[PricePreloader] Started preloading ${result.preloading} tokens`);
        } else {
          console.warn('[PricePreloader] Preload request failed:', response.status);
        }
      } catch (error) {
        console.error('[PricePreloader] Preload batch failed:', error);
      } finally {
        // Remove processed tokens from tracking set
        mints.forEach(mint => this.preloadingTokens.delete(mint));
      }
    }
  
    // Get current status
    getStatus() {
      return {
        queueLength: this.preloadQueue.length,
        preloadingCount: this.preloadingTokens.size,
        isProcessing: this.isProcessing
      };
    }
  
    // Clear queue and reset
    reset() {
      this.preloadQueue = [];
      this.preloadingTokens.clear();
      this.isProcessing = false;
      clearTimeout(this.debounceTimeout);
    }
  }
  
  // Create singleton instance
  const pricePreloader = new PricePreloader();
  
  export default pricePreloader;