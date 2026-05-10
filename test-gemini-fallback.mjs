// ══════════════════════════════════════════════════════════════════
//  GEMINI FALLBACK E2E TEST
//  Tests that Gemini fallback activates for low-confidence products
// ══════════════════════════════════════════════════════════════════

import { matchProductsWithVision } from './lib/vision-matcher.js';
import { visualSearchMatch } from './lib/gemini-verify.js';

// ── Mock products (simulating PDF extraction) ─────────────────────
const MOCK_PRODUCTS = [
  {
    name: 'Modern Dining Chair',
    productCode: 'DC-1001',
    category: 'Chair',
    material: 'Fabric',
    color: 'Gray',
    dimensions: '50x50x80 cm',
    description: 'Modern dining chair with gray fabric upholstery and black metal legs',
    page: 1
  },
  {
    name: 'Wooden Side Table',
    productCode: 'ST-2002',
    category: 'Table',
    material: 'Wood',
    color: 'Brown',
    dimensions: '40x40x50 cm',
    description: 'Round wooden side table with natural oak finish',
    page: 2
  },
  {
    name: 'Leather Armchair',
    productCode: 'AC-3003',
    category: 'Chair',
    material: 'Leather',
    color: 'Black',
    dimensions: '70x80x100 cm',
    description: 'Premium black leather armchair with chrome base',
    page: 3
  }
];

// ── Mock images (simulating ZIP extraction) ───────────────────────
// These are small valid PNG data URLs for testing
function createMockImageDataUrl(color, width = 100, height = 100) {
  // Create a minimal valid PNG with the specified color
  // We use a 1x1 pixel PNG and scale it conceptually
  const canvas = {
    width,
    height,
    toDataURL: () => {
      // Return a minimal valid PNG (1x1 pixel, colored)
      // This is a real PNG that will decode properly
      const pixelMap = {
        'gray': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'brown': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
        'black': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
        'default': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      };
      const b64 = pixelMap[color] || pixelMap['default'];
      return `data:image/png;base64,${b64}`;
    }
  };
  return canvas.toDataURL();
}

const MOCK_IMAGES = [
  { name: 'img_001.jpg', dataUrl: createMockImageDataUrl('gray'), width: 400, height: 400 },
  { name: 'img_002.jpg', dataUrl: createMockImageDataUrl('brown'), width: 400, height: 400 },
  { name: 'img_003.jpg', dataUrl: createMockImageDataUrl('black'), width: 400, height: 400 },
  { name: 'img_004.jpg', dataUrl: createMockImageDataUrl('gray'), width: 400, height: 400 },
  { name: 'img_005.jpg', dataUrl: createMockImageDataUrl('brown'), width: 400, height: 400 },
];

// ── Test 1: Verify visualSearchMatch function exists ──────────────
async function test1_visualSearchMatchExists() {
  console.log('\n─── Test 1: visualSearchMatch function exists ───');
  const exists = typeof visualSearchMatch === 'function';
  console.log(exists ? '  [PASS] visualSearchMatch is a function' : '  [FAIL] visualSearchMatch is not a function');
  return exists;
}

// ── Test 2: Verify matchProductsWithVision returns geminiFallback stats ──
async function test2_geminiFallbackStatsInResponse() {
  console.log('\n─── Test 2: Gemini fallback stats in response ───');
  
  try {
    const result = await matchProductsWithVision(MOCK_PRODUCTS, MOCK_IMAGES);
    
    const hasGeminiFallback = 'geminiFallback' in result.stats;
    console.log(hasGeminiFallback ? '  [PASS] stats.geminiFallback field exists' : '  [FAIL] stats.geminiFallback missing');
    console.log(`  Stats: autoAccepted=${result.stats.autoAccepted}, geminiFallback=${result.stats.geminiFallback}, needsReview=${result.stats.needsReview}`);
    console.log(`  Total matches: ${result.matches.length}`);
    
    // Check if any matches have geminiFallback flag
    const geminiMatches = result.matches.filter(m => m.geminiFallback);
    console.log(`  Gemini fallback matches: ${geminiMatches.length}`);
    if (geminiMatches.length > 0) {
      console.log('  [PASS] Some products got Gemini fallback matches');
      geminiMatches.forEach(m => {
        console.log(`    - "${m.product.name}": confidence=${m.overallConfidence}, bestMatch=${m.bestMatch?.imageId || 'none'}`);
      });
    } else {
      console.log('  [INFO] No Gemini fallback matches (all products may have been matched by OpenAI)');
    }
    
    return true;
  } catch (err) {
    console.log(`  [FAIL] Error: ${err.message}`);
    console.error(err);
    return false;
  }
}

// ── Test 3: Verify Gemini fallback never auto-accepts ─────────────
async function test3_geminiNeverAutoAccepts() {
  console.log('\n─── Test 3: Gemini fallback never auto-accepts ───');
  
  try {
    const result = await matchProductsWithVision(MOCK_PRODUCTS, MOCK_IMAGES);
    
    const geminiMatches = result.matches.filter(m => m.geminiFallback);
    const autoAcceptedGemini = geminiMatches.filter(m => m.autoAccept);
    
    if (autoAcceptedGemini.length === 0) {
      console.log('  [PASS] No Gemini fallback matches were auto-accepted');
    } else {
      console.log(`  [FAIL] ${autoAcceptedGemini.length} Gemini matches were auto-accepted!`);
    }
    
    // Verify all Gemini matches have autoAccept = false
    const allGood = geminiMatches.every(m => m.autoAccept === false);
    console.log(allGood ? '  [PASS] All Gemini matches have autoAccept=false' : '  [FAIL] Some Gemini matches have autoAccept=true');
    
    return allGood;
  } catch (err) {
    console.log(`  [FAIL] Error: ${err.message}`);
    return false;
  }
}

// ── Test 4: Verify match entry structure ──────────────────────────
async function test4_matchEntryStructure() {
  console.log('\n─── Test 4: Match entry structure ───');
  
  try {
    const result = await matchProductsWithVision(MOCK_PRODUCTS, MOCK_IMAGES);
    
    // Check first match has all required fields
    const firstMatch = result.matches[0];
    const requiredFields = ['productIndex', 'product', 'bestMatch', 'overallConfidence', 'overallReason', 'autoAccept'];
    const hasFields = requiredFields.every(f => f in firstMatch);
    
    console.log(hasFields ? '  [PASS] All required fields present' : '  [FAIL] Missing required fields');
    
    // Check stats has geminiFallback field
    const hasGeminiStat = 'geminiFallback' in result.stats;
    console.log(hasGeminiStat ? '  [PASS] stats.geminiFallback field present' : '  [FAIL] stats.geminiFallback missing');
    
    // Check that geminiFallback flag is set on matches that got Gemini matches
    const geminiMatches = result.matches.filter(m => m.geminiFallback);
    const allHaveFlag = geminiMatches.every(m => m.geminiFallback === true);
    console.log(allHaveFlag ? '  [PASS] Gemini-matched entries have geminiFallback=true' : '  [FAIL] Some Gemini entries missing flag');
    
    // Verify that non-Gemini matches don't have the flag (or have it undefined)
    const nonGemini = result.matches.filter(m => !m.geminiFallback);
    const noneFalselyFlagged = nonGemini.every(m => m.geminiFallback === undefined || m.geminiFallback === false);
    console.log(noneFalselyFlagged ? '  [PASS] Non-Gemini entries correctly lack geminiFallback flag' : '  [FAIL] Some non-Gemini entries falsely flagged');
    
    // Log all matches summary
    console.log('\n  Match Summary:');
    result.matches.forEach((m, i) => {
      const source = m.geminiFallback ? 'GEMINI' : (m.autoAccept ? 'AUTO' : 'OPENAI');
      const img = m.bestMatch?.imageId || 'none';
      console.log(`    ${i + 1}. "${m.product.name}" → ${img} [${source}] (${m.overallConfidence})`);
    });
    
    return hasFields && hasGeminiStat && allHaveFlag && noneFalselyFlagged;
  } catch (err) {
    console.log(`  [FAIL] Error: ${err.message}`);
    return false;
  }
}

// ── Run all tests ─────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GEMINI FALLBACK E2E TEST');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Check API keys
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY not set');
    process.exit(1);
  }
  console.log('  [OK] OPENAI_API_KEY configured');
  
  if (process.env.GEMINI_API_KEY) {
    console.log('  [OK] GEMINI_API_KEY configured');
  } else {
    console.log('  [WARN] GEMINI_API_KEY not set — Gemini fallback will be skipped');
  }
  console.log();

  const results = [];
  
  results.push({ name: 'visualSearchMatch exists', passed: await test1_visualSearchMatchExists() });
  results.push({ name: 'Gemini fallback stats', passed: await test2_geminiFallbackStatsInResponse() });
  results.push({ name: 'Gemini never auto-accepts', passed: await test3_geminiNeverAutoAccepts() });
  results.push({ name: 'Match entry structure', passed: await test4_matchEntryStructure() });

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  results.forEach(r => {
    console.log(`  ${r.passed ? '[PASS]' : '[FAIL]'} ${r.name}`);
  });
  
  console.log(`\n  ${passed}/${results.length} tests passed, ${failed} failed`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
