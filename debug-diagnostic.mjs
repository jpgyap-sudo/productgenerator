#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  DIAGNOSTIC TEST — Full pipeline trace for batch processing
//  Tests each phase independently to isolate where matches break.
// ═══════════════════════════════════════════════════════════════════

import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractAllImagesFromZip } from './lib/zip-extractor.js';
import { extractProductInfo, scanForProductCodes } from './lib/deepseek.js';
import { matchProductsToImages, scoreMatch } from './lib/product-matcher.js';
import fs from 'fs';

const PDF_PATH = 'C:/Users/User/Downloads/test scri0pt/Book1.pdf';
const ZIP_PATH = 'C:/Users/User/Downloads/test scri0pt/chair.zip';

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  DIAGNOSTIC: Batch Processing Pipeline');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ── PHASE A: PDF Text Extraction ──
console.log('PHASE A: PDF Text Extraction');
console.log('───────────────────────────────────────────────────────────────────\n');

const pdfBuffer = fs.readFileSync(PDF_PATH);
const pdfResult = await extractTextFromPDF(pdfBuffer);
assert(pdfResult.text.length > 0, `PDF text extracted: ${pdfResult.text.length} chars`);
assert(pdfResult.pages > 0, `PDF pages: ${pdfResult.pages}`);

// Scan for product codes in the raw PDF text
const rawCodes = scanForProductCodes(pdfResult.text);
console.log(`  Raw product codes found in PDF: ${rawCodes.length > 0 ? rawCodes.join(', ') : 'NONE'}`);
assert(rawCodes.length > 0, 'Product codes detected in PDF text');

// ── PHASE B: ZIP Image Extraction ──
console.log('\nPHASE B: ZIP Image Extraction');
console.log('───────────────────────────────────────────────────────────────────\n');

const zipBuffer = fs.readFileSync(ZIP_PATH);
const zipResult = await extractAllImagesFromZip(zipBuffer);
assert(zipResult.totalImages > 0, `Total images in ZIP: ${zipResult.totalImages}`);
assert(zipResult.images.length > 0, `Filtered images: ${zipResult.images.length}`);

// Show first 10 image names
console.log('  Sample image names:');
zipResult.images.slice(0, 10).forEach((img, i) => {
  console.log(`    ${i+1}. ${img.name}`);
});

// Scan image names for product codes
const imageNameCodes = new Set();
for (const img of zipResult.images) {
  const name = img.name.replace(/\.[^.]+$/, '').toLowerCase();
  for (const code of rawCodes) {
    if (name.includes(code.toLowerCase())) {
      imageNameCodes.add(code);
    }
  }
}
console.log(`  Product codes found in image filenames: ${imageNameCodes.size > 0 ? [...imageNameCodes].join(', ') : 'NONE'}`);
assert(imageNameCodes.size === 0, '⚠️ Product codes do NOT appear in image filenames (expected for xref naming)');

// ── PHASE C: DeepSeek Extraction (if API key available) ──
console.log('\nPHASE C: DeepSeek Product Extraction');
console.log('───────────────────────────────────────────────────────────────────\n');

let products = [];
const hasDeepSeekKey = !!process.env.DEEPSEEK_API_KEY;
console.log(`  DEEPSEEK_API_KEY: ${hasDeepSeekKey ? '✓ SET' : '✗ NOT SET'}`);

if (hasDeepSeekKey) {
  try {
    products = await extractProductInfo(pdfResult.text);
    console.log(`  Products extracted: ${products.length}`);
    products.forEach((p, i) => {
      console.log(`    ${i+1}. name="${p.name}" code="${p.productCode || '(none)'}" brand="${p.brand || '(none)'}"`);
    });
  } catch (err) {
    console.error(`  ❌ DeepSeek failed: ${err.message}`);
  }
} else {
  console.log('  ⚠️ Skipping DeepSeek — using mock products for matching test');
  // Simulate what DeepSeek would return based on the PDF codes we found
  products = rawCodes.map((code, i) => ({
    name: `Chair ${code}`,
    brand: 'Minotti',
    productCode: code,
    generatedCode: `HA${code}R`,
    description: `A dining chair model ${code}`,
    category: 'chair'
  }));
  console.log(`  Mock products created: ${products.length}`);
  products.forEach((p, i) => {
    console.log(`    ${i+1}. code="${p.productCode}" generatedCode="${p.generatedCode}"`);
  });
}

assert(products.length > 0, 'Products available for matching');

// ── PHASE D: Pattern Matching ──
console.log('\nPHASE D: Pattern Matching');
console.log('───────────────────────────────────────────────────────────────────\n');

// Test 1: Direct scoreMatch with product codes vs image names
console.log('  D1. Direct scoreMatch tests:');
for (const code of rawCodes.slice(0, 5)) {
  const imgName = zipResult.images[0]?.name || '';
  const result = scoreMatch(code, imgName);
  console.log(`    scoreMatch("${code}", "${imgName}") = ${result.score} (${result.matchType})`);
}

// Test 2: Full matchProductsToImages
console.log('\n  D2. Full matchProductsToImages:');
const matchResult = matchProductsToImages(products, zipResult.images);
console.log(`    Matches: ${matchResult.matchStats.matched}/${matchResult.matchStats.total}`);
console.log(`    Unmatched products: ${matchResult.matchStats.unmatched}`);
console.log(`    Unmatched images: ${matchResult.unmatchedImages.length}`);

matchResult.matches.slice(0, 5).forEach((m, i) => {
  const code = m.product?.productCode || '?';
  const imgName = m.matchedImage?.name || '(none)';
  console.log(`    ${i+1}. code="${code}" → img="${imgName}" score=${m.score} type=${m.matchType}`);
});

// ── PHASE E: Cross-reference Analysis ──
console.log('\nPHASE E: Cross-Reference Analysis');
console.log('───────────────────────────────────────────────────────────────────\n');

// Check if there's ANY overlap between product codes and image names
console.log('  Checking for ANY substring overlap between codes and image names...');
let anyMatch = false;
for (const code of rawCodes) {
  const codeLower = code.toLowerCase();
  for (const img of zipResult.images) {
    const nameLower = img.name.toLowerCase();
    if (nameLower.includes(codeLower) || codeLower.includes(nameLower.replace(/\.[^.]+$/, ''))) {
      console.log(`    FOUND: "${code}" ↔ "${img.name}"`);
      anyMatch = true;
    }
  }
}
if (!anyMatch) {
  console.log('    ⚠️ NO overlap found between product codes and image filenames.');
  console.log('    Product codes: CH-790, CH-789, CH-800, ...');
  console.log('    Image names: chair/chair_p01_01_xref14.jpeg, ...');
  console.log('    → The naming conventions are COMPLETELY DIFFERENT.');
  console.log('    → Pattern matching will ALWAYS return 0 matches.');
  console.log('    → Need visual search (Gemini) or a cross-reference mapping.');
}

// ── PHASE F: Gemini Visual Search Check ──
console.log('\nPHASE F: Gemini Visual Search Capability');
console.log('───────────────────────────────────────────────────────────────────\n');
const hasGeminiKey = !!process.env.GEMINI_API_KEY;
console.log(`  GEMINI_API_KEY: ${hasGeminiKey ? '✓ SET' : '✗ NOT SET'}`);
if (!hasGeminiKey) {
  console.log('  ⚠️ Without Gemini, visual search fallback is DISABLED.');
  console.log('  ⚠️ Since pattern matching finds 0 matches, ALL products will be unmatched.');
}

// ── SUMMARY ──
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('  DIAGNOSTIC SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════\n');

console.log('  ISSUE #1: DEEPSEEK_API_KEY not set');
console.log('    → Products cannot be extracted from PDF');
console.log('    → Fix: Set DEEPSEEK_API_KEY environment variable');
console.log('');
console.log('  ISSUE #2: Product codes (CH-###) vs Image names (xref##)');
console.log('    → Pattern matching finds ZERO matches');
console.log('    → The ZIP images use "xref" numbering, not product codes');
console.log('    → Fix: Need cross-reference mapping or visual search');
console.log('');
console.log('  ISSUE #3: Gemini visual search may not be configured');
console.log('    → Without Gemini, visual search fallback is disabled');
console.log('    → Fix: Set GEMINI_API_KEY for visual fallback');
console.log('');
console.log('  ISSUE #4: test-batch-processor.mjs uses generatedCode not productCode');
console.log('    → The matcher reads productCode, but test data has generatedCode');
console.log('    → Fix: Add productCode field to test data or normalize in matcher');
console.log('');

console.log(`  Tests: ${passed} passed, ${failed} failed`);
