#!/bin/bash
# simple-jupiter-test.sh - Quick curl tests for Jupiter API

echo "🚀 Testing Jupiter Price API v6 with curl..."
echo ""

# Test 1: SOL price
echo "1️⃣ Testing SOL price:"
curl -s -w "HTTP Status: %{http_code}, Time: %{time_total}s\n" \
     -H "Accept: application/json" \
     -H "User-Agent: CurlTest/1.0" \
     "https://price.jup.ag/v6/price?ids=SOL" | jq '.'
echo ""

# Test 2: Multiple tokens
echo "2️⃣ Testing multiple tokens (SOL, USDC, JUP):"
curl -s -w "HTTP Status: %{http_code}, Time: %{time_total}s\n" \
     -H "Accept: application/json" \
     "https://price.jup.ag/v6/price?ids=SOL,USDC,JUP" | jq '.'
echo ""

# Test 3: Popular meme tokens
echo "3️⃣ Testing meme tokens (BONK, WIF):"
curl -s -w "HTTP Status: %{http_code}, Time: %{time_total}s\n" \
     -H "Accept: application/json" \
     "https://price.jup.ag/v6/price?ids=BONK,WIF" | jq '.'
echo ""

# Test 4: With mint addresses
echo "4️⃣ Testing with mint addresses:"
curl -s -w "HTTP Status: %{http_code}, Time: %{time_total}s\n" \
     -H "Accept: application/json" \
     "https://price.jup.ag/v6/price?ids=So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" | jq '.'
echo ""

# Test 5: With extra info
echo "5️⃣ Testing with extra info:"
curl -s -w "HTTP Status: %{http_code}, Time: %{time_total}s\n" \
     -H "Accept: application/json" \
     "https://price.jup.ag/v6/price?ids=SOL&showExtraInfo=true" | jq '.'
echo ""

# Test 6: Speed test
echo "6️⃣ Speed test (time only):"
time curl -s "https://price.jup.ag/v6/price?ids=SOL" > /dev/null
echo ""

echo "✅ Jupiter API curl testing completed!"
echo ""
echo "If these work but Node.js doesn't, the issue is likely:"
echo "- Node.js TLS/SSL configuration"
echo "- Corporate firewall blocking Node.js requests" 
echo "- Missing Node.js packages (node-fetch, axios)"
echo ""
echo "Quick fixes to try:"
echo "1. NODE_TLS_REJECT_UNAUTHORIZED=0 node your-script.js"
echo "2. npm install node-fetch@2 axios"
echo "3. Update Node.js to latest LTS"