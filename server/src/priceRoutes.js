const express = require('express');
const router = express.Router();
const PriceService = require('./services/priceService');

router.post('/prices', async (req, res) => {
  const { mints } = req.body;
  if (!mints || !Array.isArray(mints)) {
    return res.status(400).json({ success: false, error: 'Invalid mints array' });
  }

  try {
    const priceData = await PriceService.getTokenPrices(mints);
    res.json(priceData);
  } catch (error) {
    console.error('[PriceRoutes] Error fetching prices:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch prices' });
  }
});

module.exports = router;