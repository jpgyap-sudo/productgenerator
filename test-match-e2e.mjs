#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  MATCH FLOW E2E TEST
//  Tests the full match pipeline end-to-end:
//    1. Pattern matching (product-matcher.js) — deterministic
//    2. Match API endpoint (/api/agent/match) — with Gemini verification
//    3. Image data URL resolution — verifies images are accessible
//    4. Edge cases: no match, partial match, exact match
//    5. Response payload size — ensures dataUrl is stripped from response
// ══════════════════════════════════════════════════════════════════

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const SKIP_GEMINI = process.env.SKIP_GEMINI === 'true';

// ── Test data ──
// Tiny valid 1x1 pixel JPEG base64 (smallest possible valid JPEG)
const TINY_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA=';
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeDataUrl(mimeType, base64) {
  return `data:${mimeType};base64,${base64}`;
}

// ── Helpers ──
let passed = 0;
let failed = 0;
let warnings = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function warn(label) {
  console.log(`  ⚠️ ${label}`);
  warnings++;
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label} (${JSON.stringify(actual)})`);
    passed++;
  } else {
    console.error(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  ✅ ${label} (${actual})`);
    passed++;
  } else {
    console.error(`  ❌ ${label}: expected ~${expected}, got ${actual}`);
    failed++;
  }
}

// ── Test 1: Pattern matching (deterministic, no API calls) ──
async function testPatternMatching() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TEST 1: Pattern Matching (deterministic)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { matchProductsToImages, scoreMatch } = await import('./lib/product-matcher.js');

  // 1a. Exact match
  console.log('  1a. Exact match');
  const exactResult = scoreMatch('CH-005', 'CH-005.jpg');
  assertEqual(exactResult.score, 100, 'Exact match score = 100');
  assertEqual(exactResult.matchType, 'exact', 'Exact match type');

  // 1b. Code in filename
  console.log('\n  1b. Code in filename');
  const subResult = scoreMatch('CH-005', 'CH-005_front_view.jpg');
  assertEqual(subResult.score, 80, 'Code-in-filename score = 80');
  assertEqual(subResult.matchType, 'code-in-filename', 'Code-in-filename match type');

  // 1c. Filename in code
  console.log('\n  1c. Filename in code');
  const fnameResult = scoreMatch('HACH-005REXTRA', 'CH-005.jpg');
  assertEqual(fnameResult.score, 60, 'Filename-in-code score = 60');
  assertEqual(fnameResult.matchType, 'filename-in-code', 'Filename-in-code match type');

  // 1d. Token overlap
  console.log('\n  1d. Token overlap');
  const tokenResult = scoreMatch('HA-790', 'img_790_v1.png');
  // "790" is a common token between "ha" "790" and "img" "790" "v1"
  // Jaccard = 1/4 = 0.25, which is < 0.5 threshold, so falls to substring check
  // substringHits: "790" is in "790" -> 1 hit, ratio = 1/3 ~= 0.33, score = round(30 * 0.33) = 10
  assert(tokenResult.score >= 10, `Token overlap score >= 10 (got ${tokenResult.score})`);
  assert(tokenResult.matchType !== 'none', 'Token overlap has a match type');

  // 1e. No match
  console.log('\n  1e. No match');
  const noMatch = scoreMatch('ZZ-999', 'random_image_001.jpg');
  assertEqual(noMatch.score, 0, 'No match score = 0');
  assertEqual(noMatch.matchType, 'none', 'No match type');

  // 1f. Full matchProductsToImages
  console.log('\n  1f. Full matchProductsToImages');
  const products = [
    { productCode: 'CH-005', name: 'Chair 1' },
    { productCode: 'TB-003', name: 'Table 1' },
    { productCode: 'ZZ-999', name: 'Unknown' }
  ];
  const images = [
    { name: 'CH-005.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64) },
    { name: 'TB-003_v2.png', dataUrl: makeDataUrl('image/png', TINY_PNG_BASE64) },
    { name: 'random_001.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64) }
  ];

  const result = matchProductsToImages(products, images);
  assertEqual(result.matches.length, 3, '3 match results');
  assertEqual(result.matchStats.matched, 2, '2 products matched');
  assertEqual(result.matchStats.unmatched, 1, '1 product unmatched');
  assertEqual(result.unmatchedImages.length, 1, '1 unmatched image');

  // Verify matchedImage has dataUrl
  const match0 = result.matches[0];
  assert(match0.matchedImage !== null, 'CH-005 has a matched image');
  if (match0.matchedImage) {
    assert(match0.matchedImage.dataUrl !== undefined, 'matchedImage has dataUrl');
    assert(match0.matchedImage.dataUrl !== null, 'matchedImage dataUrl is not null');
    assert(match0.matchedImage.dataUrl.startsWith('data:'), 'matchedImage dataUrl starts with data:');
  }

  // Verify unmatched product has no matchedImage
  const match2 = result.matches[2];
  assert(match2.matchedImage === null, 'ZZ-999 has no matched image');
  assertEqual(match2.score, 0, 'ZZ-999 score = 0');
}

// ── Test 2: Match API endpoint ──
async function testMatchAPI() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TEST 2: Match API Endpoint');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // 2a. Basic match request
  console.log('  2a. Basic match request');
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    res = await fetch(`${API_BASE}/api/agent/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [
          { name: 'Dining Chair', brand: 'TestBrand', description: 'A dining chair', generatedCode: 'CH-005' }
        ],
        images: [
          { name: 'CH-005.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 },
          { name: 'other.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 }
        ],
        verifyWithGemini: false
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    assert(res.ok, `Match API responded with HTTP ${res.status}`);
  } catch (err) {
    warn(`Match API not reachable at ${API_BASE} (${err.message}) — skipping API tests`);
    return; // Can't continue if server is down
  }

  const data = await res.json();
  assert(data.success === true, 'Match API returned success=true');
  assert(Array.isArray(data.matches), 'Match API returned matches array');
  assert(data.matches.length === 1, 'Match API returned 1 match');

  const match = data.matches[0];
  assert(match.matchedImage !== null, 'Match has a matchedImage');
  if (match.matchedImage) {
    // CRITICAL: dataUrl should be STRIPPED from the match API response
    // The client resolves dataUrl via imageMap[matchedImage.name]
    assert(match.matchedImage.dataUrl === undefined, 'dataUrl is STRIPPED from match API response (client uses imageMap)');
    assert(match.matchedImage.name === 'CH-005.jpg', 'matchedImage has name');
    assert(typeof match.matchedImage.imageIndex === 'number', 'matchedImage has imageIndex');
    assert(match.score >= 80, `Match score >= 80 (got ${match.score})`);
  }

  // 2b. Verify client-side dataUrl resolution works
  console.log('\n  2b. Client-side dataUrl resolution');
  const imageMap = {
    'CH-005.jpg': makeDataUrl('image/jpeg', TINY_JPEG_BASE64),
    'other.jpg': makeDataUrl('image/jpeg', TINY_JPEG_BASE64)
  };
  const resolvedUrl = match.matchedImage
    ? (match.matchedImage.dataUrl || imageMap[match.matchedImage.name] || '')
    : '';
  assert(resolvedUrl.startsWith('data:'), 'Client can resolve dataUrl from imageMap');
  assert(resolvedUrl.length > 0, 'Resolved dataUrl is not empty');

  // 2c. No match scenario
  console.log('\n  2c. No match scenario');
  res = await fetch(`${API_BASE}/api/agent/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: [
        { name: 'Unknown Product', brand: 'Test', description: 'No matching image', generatedCode: 'ZZ-999' }
      ],
      images: [
        { name: 'random_001.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 }
      ],
      verifyWithGemini: false
    })
  });
  const noMatchData = await res.json();
  assert(noMatchData.success === true, 'No-match returned success=true');
  assert(noMatchData.matches[0].matchedImage === null, 'No-match has null matchedImage');
  assertEqual(noMatchData.matches[0].score, 0, 'No-match score = 0');

  // 2d. Multiple products, multiple images
  console.log('\n  2d. Multiple products, multiple images');
  res = await fetch(`${API_BASE}/api/agent/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: [
        { name: 'Chair A', brand: 'A', description: 'Chair A', generatedCode: 'CH-001' },
        { name: 'Table B', brand: 'B', description: 'Table B', generatedCode: 'TB-002' },
        { name: 'Sofa C', brand: 'C', description: 'Sofa C', generatedCode: 'SF-003' }
      ],
      images: [
        { name: 'CH-001_front.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 },
        { name: 'TB-002_v2.png', dataUrl: makeDataUrl('image/png', TINY_PNG_BASE64), width: 100, height: 100, size: 1000 },
        { name: 'random_003.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 }
      ],
      verifyWithGemini: false
    })
  });
  const multiData = await res.json();
  assert(multiData.matches.length === 3, '3 matches returned');
  const matchedCount = multiData.matches.filter(m => m.matchedImage !== null).length;
  assert(matchedCount >= 2, `At least 2 products matched (got ${matchedCount})`);

  // 2e. Response payload size check
  console.log('\n  2e. Response payload size check');
  const jsonStr = JSON.stringify(multiData);
  const sizeKB = (jsonStr.length / 1024).toFixed(1);
  console.log(`     Response size: ${sizeKB} KB`);
  // With dataUrl stripped, the response should be very small
  assert(parseFloat(sizeKB) < 10, `Response size < 10 KB (${sizeKB} KB) — dataUrl stripping working`);

  // 2f. Validation: missing products
  console.log('\n  2f. Validation: missing products');
  res = await fetch(`${API_BASE}/api/agent/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      images: [{ name: 'test.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64) }]
    })
  });
  assert(!res.ok, 'Missing products returns error status');
  const errData = await res.json();
  assert(errData.error !== undefined, 'Error message returned for missing products');

  // 2g. Validation: missing images
  console.log('\n  2g. Validation: missing images');
  res = await fetch(`${API_BASE}/api/agent/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: [{ name: 'Test', description: 'Test', generatedCode: 'T-001' }]
    })
  });
  assert(!res.ok, 'Missing images returns error status');
}

// ── Test 3: Gemini verification (if API key is available) ──
async function testGeminiVerification() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TEST 3: Gemini Verification (if configured)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  if (!process.env.GEMINI_API_KEY) {
    warn('GEMINI_API_KEY not set — skipping Gemini verification tests');
    return;
  }

  // 3a. Verify match with Gemini
  console.log('  3a. Verify match with Gemini');
  const { verifyMatch } = await import('./lib/gemini-verify.js');

  const verification = await verifyMatch(
    { name: 'Test Chair', brand: 'Test', productCode: 'TC-001', description: 'A test chair' },
    makeDataUrl('image/jpeg', TINY_JPEG_BASE64)
  );

  assert(verification.isMatch !== undefined, 'Verification returned isMatch');
  assert(['high', 'medium', 'low', 'skipped'].includes(verification.confidence),
    `Verification confidence is valid (got ${verification.confidence})`);
  assert(typeof verification.reason === 'string', 'Verification has a reason');

  // 3b. Visual search fallback
  console.log('\n  3b. Visual search fallback');
  const { visualSearchMatch } = await import('./lib/gemini-verify.js');

  const visualResult = await visualSearchMatch(
    { name: 'Test Chair', brand: 'Test', productCode: 'TC-001', description: 'A test chair' },
    [
      { name: 'chair_01.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), imageIndex: 0 },
      { name: 'table_01.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), imageIndex: 1 }
    ]
  );

  if (visualResult) {
    assert(visualResult.matchedImage !== undefined, 'Visual search returned matchedImage');
    assert(typeof visualResult.score === 'number', 'Visual search returned score');
    assert(visualResult.matchType === 'visual-search', 'Visual search match type');
    warn('Visual search completed (result depends on Gemini API)');
  } else {
    warn('Visual search returned null (may be expected for tiny test images)');
  }
}

// ── Test 4: End-to-end match flow (process → match → resolve) ──
async function testEndToEndFlow() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TEST 4: End-to-End Match Flow');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Simulate the full client-side flow:
  // 1. Process step returns images with dataUrls
  // 2. Match step returns matches WITHOUT dataUrls
  // 3. Client resolves dataUrls from imageMap

  const { matchProductsToImages } = await import('./lib/product-matcher.js');

  // Simulated process result (like from /api/agent/process)
  const allImages = [
    { name: 'CH-001_front.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 },
    { name: 'CH-001_back.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 },
    { name: 'TB-002_top.png', dataUrl: makeDataUrl('image/png', TINY_PNG_BASE64), width: 100, height: 100, size: 1000 },
    { name: 'SF-003_side.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64), width: 100, height: 100, size: 1000 }
  ];

  const products = [
    { name: 'Chair A', brand: 'A', description: 'Chair A', productCode: 'CH-001', generatedCode: 'HACH-001R' },
    { name: 'Table B', brand: 'B', description: 'Table B', productCode: 'TB-002', generatedCode: 'HATB-002R' },
    { name: 'Sofa C', brand: 'C', description: 'Sofa C', productCode: 'SF-003', generatedCode: 'HASF-003R' }
  ];

  // Step 1: Pattern matching (simulates server-side)
  const matchResult = matchProductsToImages(products, allImages);

  // Step 2: Build imageMap (simulates client-side cache from process step)
  const imageMap = {};
  allImages.forEach(img => { imageMap[img.name] = img.dataUrl; });

  // Step 3: Resolve dataUrls for each match (simulates client-side renderMatchResults)
  console.log('  4a. Resolve dataUrls from imageMap');
  let allResolved = true;
  matchResult.matches.forEach((m, idx) => {
    const matchedImage = m.matchedImage;
    if (matchedImage) {
      // Simulate stripped dataUrl (as returned by match API)
      const { dataUrl, ...stripped } = matchedImage;
      // Client resolves from imageMap
      const resolvedUrl = imageMap[stripped.name] || '';
      if (!resolvedUrl.startsWith('data:')) {
        console.error(`     Product ${idx} (${m.product.name}): dataUrl NOT resolvable from imageMap`);
        allResolved = false;
      } else {
        console.log(`     ✅ Product ${idx} (${m.product.name}): resolved ${stripped.name} → dataUrl (${resolvedUrl.length} chars)`);
      }
    } else {
      console.log(`     ⚠️ Product ${idx} (${m.product.name}): no match (expected for unknown codes)`);
    }
  });
  assert(allResolved, 'All matched images are resolvable from imageMap');

  // 4b. Verify no duplicate image assignments
  console.log('\n  4b. Verify unique image assignments');
  const assignedNames = matchResult.matches
    .filter(m => m.matchedImage)
    .map(m => m.matchedImage.name);
  const uniqueNames = new Set(assignedNames);
  if (assignedNames.length === uniqueNames.size) {
    console.log(`     ✅ All ${assignedNames.length} matched products have unique images`);
  } else {
    const duplicates = assignedNames.length - uniqueNames.size;
    warn(`${duplicates} duplicate image assignment(s) detected`);
  }
  assert(assignedNames.length >= 2, 'At least 2 products have assigned images');

  // 4c. Verify match scores are reasonable
  console.log('\n  4c. Verify match scores');
  matchResult.matches.forEach((m, idx) => {
    if (m.matchedImage) {
      console.log(`     Product ${idx}: score=${m.score} type=${m.matchType}`);
      assert(m.score >= 40, `Product ${idx} score >= 40 (got ${m.score})`);
    }
  });
}

// ── Test 5: Edge cases ──
async function testEdgeCases() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TEST 5: Edge Cases');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { scoreMatch, matchProductsToImages } = await import('./lib/product-matcher.js');

  // 5a. Empty inputs
  console.log('  5a. Empty inputs');
  assertEqual(scoreMatch('', 'test.jpg').score, 0, 'Empty product code score = 0');
  assertEqual(scoreMatch('CH-005', '').score, 0, 'Empty image name score = 0');
  assertEqual(scoreMatch(null, 'test.jpg').score, 0, 'Null product code score = 0');
  assertEqual(scoreMatch('CH-005', null).score, 0, 'Null image name score = 0');

  // 5b. Empty arrays
  console.log('\n  5b. Empty arrays');
  const emptyResult = matchProductsToImages([], []);
  assertEqual(emptyResult.matches.length, 0, 'Empty products = 0 matches');
  assertEqual(emptyResult.unmatchedImages.length, 0, 'Empty images = 0 unmatched');

  // 5c. Products with no productCode
  console.log('\n  5c. Products with no productCode');
  const noCodeResult = matchProductsToImages(
    [{ name: 'Test', description: 'Test' }],
    [{ name: 'test.jpg', dataUrl: makeDataUrl('image/jpeg', TINY_JPEG_BASE64) }]
  );
  assertEqual(noCodeResult.matches[0].score, 0, 'No productCode = no match');
  assert(noCodeResult.matches[0].matchedImage === null, 'No productCode = null matchedImage');

  // 5d. Case insensitivity
  console.log('\n  5d. Case insensitivity');
  const caseResult = scoreMatch('CH-005', 'ch-005.JPG');
  assertEqual(caseResult.score, 100, 'Case-insensitive exact match score = 100');
  assertEqual(caseResult.matchType, 'exact', 'Case-insensitive exact match type');

  // 5e. Special characters in filenames
  console.log('\n  5e. Special characters in filenames');
  const specialResult = scoreMatch('CH-005', 'CH-005 (1).jpg');
  assert(specialResult.score >= 60, `Special chars match score >= 60 (got ${specialResult.score})`);

  // 5f. Long filenames with codes embedded
  console.log('\n  5f. Long filenames with codes embedded');
  const longResult = scoreMatch('CH-005', 'product_chair_CH-005_front_view_high_res_v2.jpg');
  assertEqual(longResult.score, 80, 'Code embedded in long filename score = 80');
  assertEqual(longResult.matchType, 'code-in-filename', 'Code embedded match type');
}

// ── Main ──
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  MATCH FLOW E2E TEST');
  console.log(`  API Base: ${API_BASE}`);
  console.log(`  Gemini: ${SKIP_GEMINI ? 'SKIPPED' : (process.env.GEMINI_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED')}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const startTime = Date.now();

  try {
    await testPatternMatching();
  } catch (err) {
    console.error(`\n  ❌ Test 1 failed with error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  try {
    await testMatchAPI();
  } catch (err) {
    console.error(`\n  ❌ Test 2 failed with error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  try {
    await testGeminiVerification();
  } catch (err) {
    console.error(`\n  ❌ Test 3 failed with error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  try {
    await testEndToEndFlow();
  } catch (err) {
    console.error(`\n  ❌ Test 4 failed with error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  try {
    await testEdgeCases();
  } catch (err) {
    console.error(`\n  ❌ Test 5 failed with error: ${err.message}`);
    console.error(err.stack);
    failed++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Duration: ${duration}s`);
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Warnings: ${warnings}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  if (failed > 0) {
    console.error(`❌ ${failed} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log('✅ ALL TESTS PASSED');
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
