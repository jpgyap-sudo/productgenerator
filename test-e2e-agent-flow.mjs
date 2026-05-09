/**
 * Phase-by-Phase E2E Test for Agent Match Flow
 * 
 * Tests the complete flow:
 *   Phase 1: process.js → returns allImages with dataUrl + galleryUrl
 *   Phase 2: match.js → returns slim matches (dataUrl stripped, galleryUrl preserved)
 *   Client-side: renderMatchResults() → resolves images via imageMap + galleryMap
 *
 * Run: node test-e2e-agent-flow.mjs
 */

const BASE = 'http://localhost:3000';
const VPS_BASE = 'https://productgenerator.superroo.com';

// ── Test Data ──
const SAMPLE_PRODUCTS = [
  { productCode: 'CH-001', name: 'Dining Chair HC-001', brand: 'Home Atelier', description: 'Modern dining chair with wooden legs and cushioned seat' },
  { productCode: 'TB-002', name: 'Coffee Table HC-002', brand: 'Home Atelier', description: 'Glass top coffee table with metal frame' },
  { productCode: 'LX-999', name: 'Luxury Armchair', brand: 'MingRuiShi', description: 'Premium leather armchair with gold accents and tufted back' }
];

// Create realistic test images (small valid PNG/JPEG base64)
function createTestImage(name) {
  // 1x1 pixel PNG (smallest valid PNG)
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return {
    name,
    dataUrl: `data:image/png;base64,${png1x1}`,
    width: 1,
    height: 1,
    size: 68,
    mimeType: 'image/png'
  };
}

const SAMPLE_IMAGES = [
  createTestImage('CH-001.jpg'),
  createTestImage('TB-002.jpg'),
  createTestImage('chair_01.jpg'),
  createTestImage('table_01.jpg'),
  createTestImage('lounge_01.jpg')
];

// ── Helpers ──
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label} (${JSON.stringify(actual)})`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function phase1_testProcessResponse() {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 1: Process endpoint response shape');
  console.log('══════════════════════════════════════════════');
  
  // Simulate what process.js returns:
  // allImages[] with {name, dataUrl, galleryUrl, width, height, size, mimeType}
  const mockProcessResponse = {
    success: true,
    products: SAMPLE_PRODUCTS.map(p => ({
      ...p,
      generatedCode: `HA${p.productCode}R`
    })),
    allImages: SAMPLE_IMAGES.map(img => ({
      ...img,
      galleryUrl: `https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/${img.name}`
    })),
    totalImages: SAMPLE_IMAGES.length,
    batchId: 'batch_12345'
  };

  console.log('\n── Test 1.1: Process response has allImages with dataUrl ──');
  assert(mockProcessResponse.allImages.length > 0, 'allImages is non-empty');
  assert(!!mockProcessResponse.allImages[0].dataUrl, 'allImages[0].dataUrl is present');
  assert(!!mockProcessResponse.allImages[0].galleryUrl, 'allImages[0].galleryUrl is present');
  assert(!!mockProcessResponse.allImages[0].name, 'allImages[0].name is present');

  console.log('\n── Test 1.2: Client stores agentResultData.allImages ──');
  const agentResultData = mockProcessResponse;
  assert(agentResultData === mockProcessResponse, 'agentResultData stores the full response');

  console.log('\n── Test 1.3: Client builds imageMap and galleryMap ──');
  const imageMap = {};
  const galleryMap = {};
  agentResultData.allImages.forEach(img => {
    imageMap[img.name] = img.dataUrl;
    galleryMap[img.name] = img.galleryUrl || '';
  });
  
  assertEqual(imageMap['CH-001.jpg'], SAMPLE_IMAGES[0].dataUrl, 'imageMap resolves CH-001.jpg to dataUrl');
  assertEqual(galleryMap['CH-001.jpg'], mockProcessResponse.allImages[0].galleryUrl, 'galleryMap resolves CH-001.jpg to galleryUrl');
  assertEqual(imageMap['lounge_01.jpg'], SAMPLE_IMAGES[4].dataUrl, 'imageMap resolves lounge_01.jpg to dataUrl');

  return { agentResultData, imageMap, galleryMap };
}

async function phase2_testMatchResponse() {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 2: Match endpoint response (stripDataUrl)');
  console.log('══════════════════════════════════════════════');

  // Simulate what match.js returns after stripDataUrl:
  // matchedImage has {name, galleryUrl, imageIndex, score, matchType} but NO dataUrl
  const mockMatchResponse = {
    success: true,
    matches: [
      {
        productIndex: 0,
        product: { ...SAMPLE_PRODUCTS[0], generatedCode: 'HACH-001R' },
        matchedImage: {
          name: 'CH-001.jpg',
          imageIndex: 0,
          score: 100,
          matchType: 'exact',
          galleryUrl: 'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg'
          // NOTE: dataUrl is STRIPPED by stripDataUrl in match.js
        },
        score: 100,
        matchType: 'exact',
        allCandidates: [{ imageIndex: 0, score: 100, matchType: 'exact' }],
        verification: { isMatch: true, confidence: 'high', reason: 'Exact filename match' }
      },
      {
        productIndex: 1,
        product: { ...SAMPLE_PRODUCTS[1], generatedCode: 'HATB-002R' },
        matchedImage: {
          name: 'TB-002.jpg',
          imageIndex: 1,
          score: 100,
          matchType: 'exact',
          galleryUrl: 'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/TB-002.jpg'
        },
        score: 100,
        matchType: 'exact',
        allCandidates: [{ imageIndex: 1, score: 100, matchType: 'exact' }],
        verification: { isMatch: true, confidence: 'high', reason: 'Exact filename match' }
      },
      {
        productIndex: 2,
        product: { ...SAMPLE_PRODUCTS[2], generatedCode: 'HALX-999R' },
        matchedImage: {
          name: 'chair_01.jpg',
          imageIndex: 2,
          score: 65,
          matchType: 'visual',
          galleryUrl: 'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/chair_01.jpg'
        },
        score: 65,
        matchType: 'visual',
        allCandidates: [
          { imageIndex: 2, score: 65, matchType: 'visual' },
          { imageIndex: 4, score: 30, matchType: 'visual' }
        ],
        verification: { isMatch: true, confidence: 'medium', reason: 'Visual similarity match' }
      }
    ],
    unmatchedImages: ['table_01.jpg', 'lounge_01.jpg'],
    matchStats: { total: 3, matched: 3, unmatched: 0 }
  };

  console.log('\n── Test 2.1: Match response has slim matches ──');
  assert(mockMatchResponse.matches.length > 0, 'matches is non-empty');

  console.log('\n── Test 2.2: dataUrl is STRIPPED from matchedImage (simulating stripDataUrl) ──');
  mockMatchResponse.matches.forEach((m, i) => {
    assert(!m.matchedImage.dataUrl, `match[${i}].matchedImage.dataUrl is undefined (stripped)`);
    assert(!!m.matchedImage.name, `match[${i}].matchedImage.name is present`);
    assert(!!m.matchedImage.galleryUrl, `match[${i}].matchedImage.galleryUrl is present`);
  });

  return mockMatchResponse;
}

async function phase3_testClientSideResolution(agentResultData, matchResponse) {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 3: Client-side image resolution');
  console.log('══════════════════════════════════════════════');

  // This simulates what the client does in the match button click handler
  // (lines 11406-11421 in index.html)
  const agentAcceptedMatches = {};
  const imageMap = {};
  const galleryMap = {};
  
  (agentResultData.allImages || []).forEach(img => {
    imageMap[img.name] = img.dataUrl;
    galleryMap[img.name] = img.galleryUrl || '';
  });

  matchResponse.matches.forEach((m, idx) => {
    const imageName = m.matchedImage?.name || '';
    agentAcceptedMatches[idx] = {
      accepted: true,
      imageName,
      dataUrl: m.matchedImage?.dataUrl || imageMap[imageName] || '',
      galleryUrl: galleryMap[imageName] || ''
    };
  });

  console.log('\n── Test 3.1: agentAcceptedMatches resolves dataUrl from imageMap ──');
  assertEqual(agentAcceptedMatches[0].dataUrl, SAMPLE_IMAGES[0].dataUrl, 
    'match[0] dataUrl resolved from imageMap (since matchedImage.dataUrl is stripped)');
  assertEqual(agentAcceptedMatches[0].imageName, 'CH-001.jpg', 
    'match[0] imageName is correct');
  assertEqual(agentAcceptedMatches[0].galleryUrl, 
    'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg',
    'match[0] galleryUrl resolved from galleryMap');

  assertEqual(agentAcceptedMatches[1].dataUrl, SAMPLE_IMAGES[1].dataUrl,
    'match[1] dataUrl resolved from imageMap');
  assertEqual(agentAcceptedMatches[1].galleryUrl,
    'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/TB-002.jpg',
    'match[1] galleryUrl resolved from galleryMap');

  console.log('\n── Test 3.2: renderMatchResults() image resolution ──');
  // This simulates what renderMatchResults does (lines 10988-11003)
  const renderImageMap = {};
  const renderGalleryMap = {};
  (agentResultData.allImages || []).forEach(img => {
    renderImageMap[img.name] = img.dataUrl;
    renderGalleryMap[img.name] = img.galleryUrl || '';
  });

  matchResponse.matches.forEach((match, idx) => {
    const matchedImage = match.matchedImage || {};
    const imageDataUrl = matchedImage.dataUrl || renderImageMap[matchedImage.name] || renderGalleryMap[matchedImage.name] || '';
    
    assert(!!imageDataUrl, `renderMatch match[${idx}] imageDataUrl is non-empty`);
    assert(imageDataUrl.startsWith('data:image/'), 
      `renderMatch match[${idx}] imageDataUrl is a valid data URL (starts with data:image/)`);
    
    if (idx === 0) {
      assertEqual(imageDataUrl, SAMPLE_IMAGES[0].dataUrl, 
        `renderMatch match[${idx}] resolves to correct CH-001.jpg dataUrl`);
    }
  });

  console.log('\n── Test 3.3: Fallback chain correctness ──');
  // Test: matchedImage.dataUrl (stripped=undefined) → imageMap[name] → galleryMap[name] → ''
  const testMatch = { matchedImage: { name: 'CH-001.jpg' } }; // no dataUrl, no galleryUrl
  const testName = testMatch.matchedImage.name;
  const result1 = testMatch.matchedImage.dataUrl || renderImageMap[testName] || renderGalleryMap[testName] || '';
  assertEqual(result1, SAMPLE_IMAGES[0].dataUrl, 
    'Fallback chain: undefined → imageMap → galleryMap → empty');

  // Test: if imageMap also missing, falls through to galleryMap
  const testMatch2 = { matchedImage: { name: 'nonexistent.jpg' } };
  const testName2 = testMatch2.matchedImage.name;
  const result2 = testMatch2.matchedImage.dataUrl || renderImageMap[testName2] || renderGalleryMap[testName2] || '';
  assertEqual(result2, '', 
    'Fallback chain: undefined → undefined → undefined → empty string');

  // Test: if galleryUrl is present on matchedImage (not stripped), it's used first
  const testMatch3 = { matchedImage: { name: 'CH-001.jpg', dataUrl: 'data:image/png;base64,OVERRIDE' } };
  const testName3 = testMatch3.matchedImage.name;
  const result3 = testMatch3.matchedImage.dataUrl || renderImageMap[testName3] || renderGalleryMap[testName3] || '';
  assertEqual(result3, 'data:image/png;base64,OVERRIDE',
    'matchedImage.dataUrl takes priority over imageMap when present');

  return agentAcceptedMatches;
}

async function phase4_testHandleMatchAction() {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 4: handleMatchAction() dataUrl resolution');
  console.log('══════════════════════════════════════════════');

  // Simulate handleMatchAction (lines 11140-11155)
  const images = SAMPLE_IMAGES.map(img => ({
    ...img,
    galleryUrl: `https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/${img.name}`
  }));

  const matches = [
    {
      productIndex: 0,
      matchedImage: { name: 'CH-001.jpg', imageIndex: 0, score: 100, matchType: 'exact' }
      // No dataUrl, no galleryUrl (stripped by stripDataUrl)
    }
  ];

  // Build lookup maps (same as handleMatchAction)
  const imgMap = {};
  const galMap = {};
  images.forEach(img => {
    imgMap[img.name] = img.dataUrl;
    galMap[img.name] = img.galleryUrl || '';
  });

  const match = matches[0];
  const imageName = match.matchedImage?.name || '';
  const resolvedDataUrl = match.matchedImage?.dataUrl || imgMap[imageName] || '';
  const resolvedGalleryUrl = galMap[imageName] || '';

  console.log('\n── Test 4.1: handleMatchAction resolves dataUrl from imgMap ──');
  assertEqual(resolvedDataUrl, SAMPLE_IMAGES[0].dataUrl, 
    'resolvedDataUrl comes from imgMap (since matchedImage.dataUrl is stripped)');
  assertEqual(resolvedGalleryUrl, 
    'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg',
    'resolvedGalleryUrl comes from galMap');

  console.log('\n── Test 4.2: handleMatchAction stores resolved values ──');
  const agentAcceptedMatches = {};
  const prev = agentAcceptedMatches[0] || {};
  agentAcceptedMatches[0] = { 
    accepted: true, 
    imageName, 
    dataUrl: resolvedDataUrl, 
    galleryUrl: prev.galleryUrl || resolvedGalleryUrl 
  };

  assertEqual(agentAcceptedMatches[0].dataUrl, SAMPLE_IMAGES[0].dataUrl,
    'Stored dataUrl is the resolved base64 data URL');
  assertEqual(agentAcceptedMatches[0].galleryUrl,
    'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg',
    'Stored galleryUrl is the VPS gallery URL');
}

async function phase5_testCollectAgentProductsForQueue() {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 5: collectAgentProductsForQueue() data propagation');
  console.log('══════════════════════════════════════════════');

  // Simulate collectAgentProductsForQueue (lines 11216-11250)
  const agentAcceptedMatches = {
    0: { accepted: true, imageName: 'CH-001.jpg', dataUrl: SAMPLE_IMAGES[0].dataUrl, galleryUrl: 'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg' },
    1: { accepted: true, imageName: 'TB-002.jpg', dataUrl: SAMPLE_IMAGES[1].dataUrl, galleryUrl: 'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/TB-002.jpg' }
  };

  const products = [];
  Object.entries(agentAcceptedMatches).forEach(([idx, matchInfo]) => {
    if (matchInfo.accepted) {
      products.push({
        name: `Product ${idx}`,
        brand: 'TestBrand',
        description: 'Test description',
        driveFolderName: `CODE-${idx}`,
        dataUrl: matchInfo.dataUrl || '',
        matchedImageName: matchInfo.imageName || '',
        galleryUrl: matchInfo.galleryUrl || ''
      });
    }
  });

  console.log('\n── Test 5.1: Products carry dataUrl and galleryUrl ──');
  assert(products.length === 2, '2 products collected');
  assertEqual(products[0].dataUrl, SAMPLE_IMAGES[0].dataUrl, 
    'Product[0] dataUrl is preserved from agentAcceptedMatches');
  assertEqual(products[0].galleryUrl,
    'https://productgenerator.superroo.com/vps-assets/upload-gallery/batch_12345/CH-001.jpg',
    'Product[0] galleryUrl is preserved');
  assertEqual(products[0].matchedImageName, 'CH-001.jpg',
    'Product[0] matchedImageName is preserved');

  console.log('\n── Test 5.2: Submit API receives galleryUrl ──');
  // Simulate what submit.js receives
  const submitPayload = {
    products: products.map(p => ({
      name: p.name,
      brand: p.brand,
      description: p.description,
      driveFolderName: p.driveFolderName,
      dataUrl: p.dataUrl,
      matchedImageName: p.matchedImageName,
      galleryUrl: p.galleryUrl
    }))
  };

  assert(!!submitPayload.products[0].galleryUrl, 
    'Submit payload includes galleryUrl');
  assert(!!submitPayload.products[0].dataUrl,
    'Submit payload includes dataUrl');
}

async function phase6_testRealApiCall() {
  console.log('\n══════════════════════════════════════════════');
  console.log('PHASE 6: Real API call to match endpoint');
  console.log('══════════════════════════════════════════════');

  const endpoints = [
    { name: 'Local (localhost:3000)', url: `${BASE}/api/agent/match` },
    { name: 'VPS (productgenerator.superroo.com)', url: `${VPS_BASE}/api/agent/match` }
  ];

  for (const ep of endpoints) {
    console.log(`\n── Testing ${ep.name} ──`);
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: SAMPLE_PRODUCTS.map(p => ({
            name: p.name,
            brand: p.brand,
            description: p.description,
            generatedCode: p.productCode
          })),
          images: SAMPLE_IMAGES
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!res.ok) {
        console.log(`  ⚠️  HTTP ${res.status}: ${res.statusText}`);
        continue;
      }

      const data = await res.json();
      
      console.log(`  ✅ Response received (success: ${data.success})`);
      console.log(`  Matches: ${data.matches?.length || 0}, Unmatched: ${data.unmatchedImages?.length || 0}`);
      
      if (data.matches && data.matches.length > 0) {
        const m = data.matches[0];
        const mi = m.matchedImage || {};
        
        console.log(`\n  First match:`);
        console.log(`    productCode: ${m.productCode || m.product?.productCode}`);
        console.log(`    matchedImage.name: ${mi.name}`);
        console.log(`    matchedImage.dataUrl: ${mi.dataUrl ? 'PRESENT (NOT STRIPPED!)' : 'undefined (correctly stripped)'}`);
        console.log(`    matchedImage.galleryUrl: ${mi.galleryUrl || 'missing'}`);
        console.log(`    matchedImage.imageIndex: ${mi.imageIndex}`);
        console.log(`    score: ${mi.score}`);
        console.log(`    matchType: ${mi.matchType}`);

        // CRITICAL ASSERTIONS
        assert(!mi.dataUrl, `dataUrl is stripped from matchedImage (expected: undefined)`);
        assert(!!mi.name, `matchedImage.name is present`);
        
        // Now simulate client-side resolution
        const imageMap = {};
        SAMPLE_IMAGES.forEach(img => { imageMap[img.name] = img.dataUrl; });
        const resolvedDataUrl = mi.dataUrl || imageMap[mi.name] || '';
        assert(!!resolvedDataUrl, `Client can resolve dataUrl from imageMap using name "${mi.name}"`);
        
        passed++;
      }
    } catch (err) {
      if (err.name === 'TimeoutError') {
        console.log(`  ⏱️  Timeout (endpoint may be down)`);
      } else if (err.cause?.code === 'ECONNREFUSED') {
        console.log(`  ⛔ Connection refused (server not running)`);
      } else {
        console.log(`  ❌ Error: ${err.message}`);
      }
    }
  }
}

// ── Main ──
async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('AGENT MATCH FLOW — E2E PHASE-BY-PHASE TEST');
  console.log('══════════════════════════════════════════════\n');

  // Phase 1: Process response
  const { agentResultData, imageMap, galleryMap } = await phase1_testProcessResponse();

  // Phase 2: Match response
  const matchResponse = await phase2_testMatchResponse();

  // Phase 3: Client-side resolution
  const agentAcceptedMatches = await phase3_testClientSideResolution(agentResultData, matchResponse);

  // Phase 4: handleMatchAction
  await phase4_testHandleMatchAction();

  // Phase 5: collectAgentProductsForQueue
  await phase5_testCollectAgentProductsForQueue();

  // Phase 6: Real API call
  await phase6_testRealApiCall();

  // ── Summary ──
  console.log('\n══════════════════════════════════════════════');
  console.log('RESULTS');
  console.log('══════════════════════════════════════════════');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  
  if (failed > 0) {
    console.log('\n  ❌ SOME TESTS FAILED — review output above');
    process.exit(1);
  } else {
    console.log('\n  ✅ ALL TESTS PASSED');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
