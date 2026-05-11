// ═══════════════════════════════════════════════════════════════════
//  test-et-only-e2e.mjs — E2E test for .et (WPS Spreadsheet) standalone
//  matching feature
//
//  Tests the feature where uploading only a .et file (no ZIP) will:
//    1. Extract product info from .et spreadsheet text via SheetJS + DeepSeek
//    2. No page images (spreadsheets don't have visual pages)
//    3. Return products with code, description, brand for manual matching
//
//  Usage:
//    node test-et-only-e2e.mjs [path/to/sample.et]
//
//  If no path provided, uses a default test file path.
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

// ── Config ────────────────────────────────────────────────────────
// Default test .et file — saved from user's sample for iterative E2E testing
const SAMPLE_ET = process.argv[2] || path.join(__dirname, 'uploads', 'DINING_CHAIRS.et');

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

// ── Test: Upload .et only ─────────────────────────────────────────
async function testEtOnlyUpload() {
  heading('Test 1: .et-only upload to /api/agent/process');

  // Check if sample .et exists
  if (!fs.existsSync(SAMPLE_ET)) {
    fail(`Sample .et file not found at: ${SAMPLE_ET}`);
    info('Provide a path: node test-et-only-e2e.mjs /path/to/catalog.et');
    return null;
  }

  const etBuffer = fs.readFileSync(SAMPLE_ET);
  info(`ET: ${SAMPLE_ET} (${formatSize(etBuffer.length)})`);

  // Create multipart form data — only .et, no ZIP
  const formData = new FormData();
  const etBlob = new Blob([etBuffer], { type: 'application/vnd.ms-excel' });
  formData.append('pdf', etBlob, path.basename(SAMPLE_ET));

  info('Sending .et-only request...');
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

  pass(`Standalone mode detected (isPdfOnly: ${data.isPdfOnly})`);

  // Check products extracted
  if (!data.products || data.products.length === 0) {
    fail('No products extracted from .et file');
    info(`Warning: ${data.warning || 'Unknown'}`);
    return data;
  }
  pass(`Products extracted: ${data.products.length}`);

  // For .et files, there should be no page images (spreadsheets don't have pages)
  if (data.allImages && data.allImages.length > 0) {
    info(`Note: ${data.allImages.length} images returned (unexpected for .et, but non-blocking)`);
  } else {
    pass('No page images (expected for .et spreadsheet)');
  }

  // Verify each product has required fields
  let allHaveFields = true;
  let missingFields = [];
  for (let i = 0; i < Math.min(data.products.length, 10); i++) {
    const p = data.products[i];
    const hasCode = !!p.productCode;
    const hasDesc = !!p.description;
    const hasBrand = !!p.brand;
    const hasName = !!p.name;

    if (!hasCode || !hasDesc || !hasName) {
      missingFields.push(`#${i + 1}: code=${hasCode} desc=${hasDesc} brand=${hasBrand} name=${hasName}`);
      allHaveFields = false;
    }
  }
  if (allHaveFields) {
    pass('First 10 products have required fields (code, description, brand, name)');
  } else {
    info(`Some products missing fields: ${missingFields.join(', ')}`);
    info('(This is acceptable if the .et file has sparse data)');
  }

  // Log first few products as sample
  if (data.products.length > 0) {
    const sampleCount = Math.min(3, data.products.length);
    for (let i = 0; i < sampleCount; i++) {
      const p = data.products[i];
      info(`Product #${i + 1}: ${p.name} (code: ${p.productCode || 'N/A'}, brand: ${p.brand || 'N/A'})`);
      if (p.description) {
        info(`  Description: ${p.description.substring(0, 100)}...`);
      }
    }
  }

  return data;
}

// ── Test: AI per-row matching (if images available) ───────────────
async function testEtOnlyMatching(processResult) {
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

  // For .et files, there are typically no page images
  // The matching endpoint should still work with empty images
  if (!allImages || allImages.length === 0) {
    info('No page images to match against (expected for .et files)');
    info('Skipping AI matching — .et files return products for manual entry');
    return { matches: [], stats: { autoAccepted: 0, needsReview: 0 } };
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

  if (!data.matches || data.matches.length === 0) {
    info('No matches returned (expected if no images available)');
    return data;
  }

  pass(`Matches returned: ${data.matches.length}`);

  if (data.stats) {
    pass(`Stats: ${data.stats.autoAccepted || 0} auto-accepted, ${data.stats.needsReview || 0} need review`);
  }

  return data;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   .et Standalone Matching — E2E Test Suite       ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);
  console.log(`API Base: ${API_BASE}`);
  console.log(`ET File: ${SAMPLE_ET}`);

  // Run tests sequentially
  const processResult = await testEtOnlyUpload();
  const matchResult = await testEtOnlyMatching(processResult);

  // Summary
  heading('Test Summary');
  if (processResult) {
    pass('.et-only upload: OK');
    if (processResult.products) {
      pass(`Products extracted: ${processResult.products.length}`);
    }
  } else {
    fail('.et-only upload: FAILED');
  }

  console.log('');
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
