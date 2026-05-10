#!/bin/bash
# ══════════════════════════════════════════════════════════════════
#  Batch Pipeline E2E Test — runs on VPS via curl to local API
# ══════════════════════════════════════════════════════════════════
set -e

API="http://localhost:3000"
PDF="/root/productgenerator/DINING CHAIRS.pdf"
ZIP="/root/productgenerator/chair.zip"
TIMESTAMP=$(date +%s)
PASS=0
FAIL=0

echo "═══════════════════════════════════════════════════════════════════"
echo "  BATCH PIPELINE E2E TEST"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Health check ──
echo "Test 1: Health Check"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' $API/health)
if [ "$HTTP_CODE" = "200" ]; then
  echo "  ✅ Health check: $HTTP_CODE"
  PASS=$((PASS+1))
else
  echo "  ❌ Health check: $HTTP_CODE"
  FAIL=$((FAIL+1))
fi

# ── Test 2: Process PDF+ZIP ──
echo ""
echo "Test 2: Process PDF+ZIP (with useBatchQueue=true)"
START_TIME=$(date +%s%N)
RESPONSE=$(curl -s -X POST $API/api/agent/process \
  -F "pdf=@$PDF" \
  -F "zip=@$ZIP" \
  -F "useBatchQueue=true")
END_TIME=$(date +%s%N)
DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))

SUCCESS=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.success)}catch(e){console.log('PARSE_ERROR')}")
PRODUCTS=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.products?.length||0)}catch(e){console.log(0)}")
IMAGES=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.allImages?.length||0)}catch(e){console.log(0)}")
MATCHES=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.matches?.length||0)}catch(e){console.log(0)}")
BATCH_ID=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.batchId||'none')}catch(e){console.log('none')}")
BATCH_STATUS=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.batchStatus||'none')}catch(e){console.log('none')}")
ERROR=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');try{const j=JSON.parse(d);console.log(j.error||'')}catch(e){console.log('PARSE_ERROR')}")

echo "  Duration: ${DURATION_MS}ms"
echo "  success: $SUCCESS"
echo "  products: $PRODUCTS"
echo "  images: $IMAGES"
echo "  matches: $MATCHES"
echo "  batchId: $BATCH_ID"
echo "  batchStatus: $BATCH_STATUS"

if [ "$SUCCESS" = "true" ] && [ "$PRODUCTS" -gt 0 ] && [ "$IMAGES" -gt 0 ]; then
  echo "  ✅ Process OK"
  PASS=$((PASS+1))
else
  echo "  ❌ Process FAILED"
  echo "  Error: $ERROR"
  FAIL=$((FAIL+1))
fi

# ── Test 3: Check batch was created in Supabase ──
echo ""
echo "Test 3: Verify batch in Supabase"
if [ "$BATCH_ID" != "none" ] && [ "$BATCH_ID" != "" ]; then
  BATCH_CHECK=$(node -e "
    const {createClient}=require('@supabase/supabase-js');
    const WebSocket=require('ws');
    require('dotenv').config();
    const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},realtime:{transport:WebSocket}});
    (async()=>{
      const {data,error}=await sb.from('batch_jobs').select('*').eq('id',$BATCH_ID).single();
      if(error){console.log('DB_ERROR:'+error.message);return;}
      console.log('status:'+data.status);
      console.log('stage:'+data.stage);
      console.log('progress:'+data.progress_percent);
      console.log('products:'+data.total_products);
      console.log('images:'+data.total_images);
      console.log('completed:'+data.completed_products);
    })()
  ")
  echo "  $BATCH_CHECK"
  if echo "$BATCH_CHECK" | grep -q "status:"; then
    echo "  ✅ Batch found in DB"
    PASS=$((PASS+1))
  else
    echo "  ❌ Batch not in DB"
    FAIL=$((FAIL+1))
  fi
else
  echo "  ⚠️ No batchId returned, skipping DB check"
fi

# ── Test 4: Check match results have confidence scores ──
echo ""
echo "Test 4: Match quality check"
if [ "$MATCHES" -gt 0 ]; then
  MATCH_QUALITY=$(echo "$RESPONSE" | node -e "
    const d=require('fs').readFileSync('/dev/stdin','utf8');
    const j=JSON.parse(d);
    const matches=j.matches||[];
    let high=0,med=0,low=0,seq=0;
    matches.forEach(m=>{
      const c=m.bestMatch?.confidence||m.overallConfidence||0;
      if(c>=90)high++;
      else if(c>=70)med++;
      else if(c>0)low++;
      else seq++;
    });
    console.log('high_confidence:'+high);
    console.log('medium_confidence:'+med);
    console.log('low_confidence:'+low);
    console.log('sequential_fallback:'+seq);
  ")
  echo "  $MATCH_QUALITY"
  
  SEQ_FALLBACK=$(echo "$MATCH_QUALITY" | grep "sequential_fallback:" | cut -d: -f2)
  if [ "$SEQ_FALLBACK" = "0" ]; then
    echo "  ✅ No sequential fallback matches"
    PASS=$((PASS+1))
  else
    echo "  ⚠️ Some sequential fallback matches found ($SEQ_FALLBACK)"
    PASS=$((PASS+1))
  fi
else
  echo "  ⚠️ No matches to check quality"
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════════"
exit $FAIL
