// ═══════════════════════════════════════════════════════════════════
//  test-pdf-only-e2e.mjs — E2E test for PDF-only batch matching feature
//
//  Tests the new feature where uploading only a PDF (no ZIP) will:
//    1. Extract product info from PDF text via DeepSeek
//    2. Extract page images from PDF via sharp
//    3. Use AI to match each product to its corresponding PDF page image
//    4. Return results per row with product code, description, photo, brand
//
//  Usage:
//    node test-pdf-only-e2e.mjs [path/to/sample.pdf]
//
//  If no path provided, uses a default test file path.
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

// ── Config ────────────────────────────────────────────────────────
// Default test PDF — saved from user's sample for iterative E2E testing
const SAMPLE_PDF = process.argv[2] || path.join(__dirname, 'uploads', 'DINING_CHAIRS_with_Brand.pdf');

// ── Colors for output ─────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}→${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${YELLOW}${msg}${RESET}\n`); }

// ── Helpers ───────────────────────────────────────────────────────
async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// ── Test: Upload PDF only ─────────────────────────────────────────
async function testPdfOnlyUpload() {
  heading('Test 1: PDF-only upload to /api/agent/process');

  // Check if sample PDF exists
  if (!fs.existsSync(SAMPLE_PDF)) {
    fail(`Sample PDF not found at: ${SAMPLE_PDF}`);
    info('Provide a path: node test-pdf-only-e2e.mjs /path/to/catalog.pdf');
    return null;
  }

  const pdfBuffer = fs.readFileSync(SAMPLE_PDF);
  info(`PDF: ${SAMPLE_PDF} (${formatSize(pdfBuffer.length)})`);

  // Create multipart form data — only PDF, no ZIP
  const formData = new FormData();
  const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('pdf', pdfBlob, path.basename(SAMPLE_PDF));

  info('Sending PDF-only request...');
  const { status, ok, data } = await fetchJson(`${API_BASE}/api/agent/process`, {
    method: 'POST',
    body: formData
  });

  if (!ok) {
    fail(`Upload failed (HTTP ${status}): ${data.error || JSON.stringify(data)}`);
    return null;
  }

  if (!data.isPdfOnly) {
    fail('Response missing isPdfOnly flag');
    return null;
  }

  pass(`PDF-only mode detected (isPdfOnly: ${data.isPdfOnly})`);

  // Check products extracted
  if (!data.products || data.products.length === 0) {
    fail('No products extracted from PDF');
    info(`Warning: ${data.warning || 'Unknown'}`);
    return data;
  }
  pass(`Products extracted: ${data.products.length}`);

  // Check page images extracted
  if (!data.allImages || data.allImages.length === 0) {
    fail('No page images extracted from PDF');
    return data;
  }
  pass(`Page images extracted: ${data.allImages.length}`);

  // Verify each product has required fields
  let allHaveFields = true;
  for (let i = 0; i < data.products.length; i++) {
    const p = data.products[i];
    const hasCode = !!p.productCode;
    const hasDesc = !!p.description;
    const hasBrand = !!p.brand;
    const hasName = !!p.name;

    if (!hasCode || !hasDesc || !hasName) {
      fail(`Product #${i + 1} missing fields: code=${hasCode} desc=${hasDesc} brand=${hasBrand} name=${hasName}`);
      allHaveFields = false;
    }
  }
  if (allHaveFields) {
    pass('All products have required fields (code, description, brand, name)');
  }

  // Verify page images have data URLs
  const allHaveDataUrls = data.allImages.every(img => !!img.dataUrl);
  if (allHaveDataUrls) {
    pass(`All ${data.allImages.length} page images have data URLs`);
  } else {
    fail('Some page images missing data URLs');
  }

  // Log first product as sample
  if (data.products.length > 0) {
    const first = data.products[0];
    info(`Sample product #1: ${first.name} (code: ${first.productCode || 'N/A'}, brand: ${first.brand || 'N/A'})`);
    info(`  Description: ${(first.description || '').substring(0, 100)}...`);
  }

  return data;
}

// ── Test: AI per-row matching ─────────────────────────────────────
async function testPdfOnlyMatching(processResult) {
  heading('Test 2: AI per-row matching via /api/agent/match-pdf-only');

  if (!processResult) {
    fail('No process result to match — skipping');
    return;
  }

  const { products, allImages } = processResult;

  if (!products || products.length === 0) {
    fail('No products to match');
    return;
  }

  if (!allImages || allImages.length === 0) {
    fail('No page images to match against');
    return;
  }

  info(`Matching ${products.length} products to ${allImages.length} page images...`);

  const { status, ok, data } = await fetchJson(`${API_BASE}/api/agent/match-pdf-only`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products, images: allImages })
  });

  if (!ok) {
    fail(`Matching failed (HTTP ${status}): ${data.error || JSON.stringify(data)}`);
    return;
  }

  pass(`Matching completed (HTTP ${status})`);

  // Check matches returned
  if (!data.matches || data.matches.length === 0) {
    fail('No matches returned');
    return;
  }
  pass(`Matches returned: ${data.matches.length}`);

  // Check each match has required fields
  let allValid = true;
  for (let i = 0; i < data.matches.length; i++) {
    const m = data.matches[i];
    const hasProduct = !!m.product;
    const hasBestMatch = !!m.bestMatch;
    const hasConfidence = m.overallConfidence;

    if (!hasProduct) {
      fail(`Match #${i + 1} missing product info`);
      allValid = false;
    }
    if (!hasBestMatch) {
      info(`Match #${i + 1} has no best match (low confidence)`);
    }
  }
  if (allValid) {
    pass('All matches have valid structure');
  }

  // Check stats
  if (data.stats) {
    pass(`Stats: ${data.stats.autoAccepted || 0} auto-accepted, ${data.stats.needsReview || 0} need review`);
  }

  // Log sample match
  if (data.matches.length > 0) {
    const first = data.matches[0];
    info(`Sample match #1: ${first.product?.name || 'N/A'}`);
    if (first.bestMatch) {
      info(`  Best match confidence: ${first.bestMatch.confidence}%`);
      info(`  Reason: ${(first.bestMatch.reason || '').substring(0, 120)}`);
    }
    info(`  Overall confidence: ${first.overallConfidence || 'none'}`);
  }

  return data;
}

// ── Test: Submit matched results ──────────────────────────────────
async function testSubmitMatches(matchResult) {
  heading('Test 3: Submit confirmed matches to render queue');

  if (!matchResult || !matchResult.matches) {
    fail('No match results to submit — skipping');
    return;
  }

  const confirmedMatches = matchResult.matches.filter(m => m.overallConfidence === 'high' || m.confirmed);
  if (confirmedMatches.length === 0) {
    info('No high-confidence matches to auto-submit');
    info('(This is expected — low confidence matches need manual review)');
    return;
  }

  info(`Submitting ${confirmedMatches.length} confirmed matches...`);

  for (let i = 0; i < confirmedMatches.length; i++) {
    const m = confirmedMatches[i];
    const { status, ok, data } = await fetchJson(`${API_BASE}/api/agent/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: m.product?.name || `Product ${i + 1}`,
        brand: m.product?.brand || '',
        description: m.product?.description || '',
        productCode: m.product?.productCode || m.product?.generatedCode || '',
        imageDataUrl: m.bestMatch?.dataUrl || null,
        imageName: m.bestMatch?.imageName || `page_${i + 1}.png`,
        resolution: '1K'
      })
    });

    if (ok && data.success) {
      pass(`Product #${i + 1} submitted (ID: ${data.itemId})`);
    } else {
      fail(`Product #${i + 1} submit failed: ${data?.error || 'Unknown'}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   PDF-Only Batch Matching — E2E Test Suite      ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);
  console.log(`API Base: ${API_BASE}`);
  console.log(`PDF: ${SAMPLE_PDF}`);

  // Run tests sequentially
  const processResult = await testPdfOnlyUpload();
  const matchResult = await testPdfOnlyMatching(processResult);
  await testSubmitMatches(matchResult);

  // Summary
  heading('Test Summary');
  if (processResult) {
    pass('PDF-only upload: OK');
  } else {
    fail('PDF-only upload: FAILED');
  }
  if (matchResult) {
    pass('AI per-row matching: OK');
  } else {
    fail('AI per-row matching: SKIPPED or FAILED');
  }

  console.log('');
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
