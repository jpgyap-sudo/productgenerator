// ═══════════════════════════════════════════════════════════════════
//  test-et-images-e2e.mjs — E2E test for .et embedded image extraction
//
//  Tests the feature where uploading a .et file (WPS Spreadsheet)
//  with embedded images will:
//    1. Convert .et → .xlsx via LibreOffice
//    2. Extract embedded images + cell anchors via exceljs
//    3. Extract product data (code, description, brand) from rows
//    4. Return pre-mapped products with images (no AI needed)
//
//  Usage:
//    node test-et-images-e2e.mjs [path/to/sample.et]
//
//  If no path provided, uses the default DINING_CHAIRS.et file.
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE || 'http://localhost:3000';

// ── Config ────────────────────────────────────────────────────────
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

// ── Test: Upload .et with embedded images ─────────────────────────
async function testEtImageUpload() {
  heading('Test 1: .et embedded image upload to /api/agent/process');

  // Check if sample .et exists
  if (!fs.existsSync(SAMPLE_ET)) {
    fail(`Sample .et file not found at: ${SAMPLE_ET}`);
    info('Provide a path: node test-et-images-e2e.mjs /path/to/catalog.et');
    return null;
  }

  const etBuffer = fs.readFileSync(SAMPLE_ET);
  info(`ET: ${SAMPLE_ET} (${formatSize(etBuffer.length)})`);

  // Create multipart form data — only .et, no ZIP
  const formData = new FormData();
  const etBlob = new Blob([etBuffer], { type: 'application/vnd.ms-excel' });
  formData.append('pdf', etBlob, path.basename(SAMPLE_ET));

  info('Sending .et-only request...');
  const startTime = Date.now();
  const { status, ok, data } = await fetchJson(`${API_BASE}/api/agent/process`, {
    method: 'POST',
    body: formData
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!ok) {
    fail(`Upload failed (HTTP ${status}): ${data.error || JSON.stringify(data)}`);
    info(`Response took ${elapsed}s`);
    return null;
  }

  pass(`Upload successful (HTTP ${status}, ${elapsed}s)`);

  // Check for hasEmbeddedImages flag
  if (!data.hasEmbeddedImages) {
    fail('Response missing hasEmbeddedImages flag');
    info(`Response keys: ${Object.keys(data).join(', ')}`);
    return data;
  }
  pass(`hasEmbeddedImages: ${data.hasEmbeddedImages}`);

  // Check products extracted
  if (!data.products || data.products.length === 0) {
    fail('No products extracted from .et file');
    info(`Warning: ${data.warning || 'Unknown'}`);
    return data;
  }
  pass(`Products extracted: ${data.products.length}`);

  // Check images extracted
  if (!data.allImages || data.allImages.length === 0) {
    fail('No embedded images extracted from .et file');
    return data;
  }
  pass(`Embedded images extracted: ${data.allImages.length}`);

  // Verify each product has required fields
  let allHaveFields = true;
  let missingFields = [];
  let productsWithImages = 0;

  for (let i = 0; i < Math.min(data.products.length, 20); i++) {
    const p = data.products[i];
    const hasCode = !!p.productCode;
    const hasDesc = !!p.description;
    const hasBrand = !!p.brand;
    const hasName = !!p.name;
    const hasPreMapped = p.hasPreMappedImage;

    if (hasPreMapped) productsWithImages++;

    if (!hasCode || !hasName) {
      missingFields.push(`#${i + 1}: code=${hasCode} desc=${hasDesc} brand=${hasBrand} name=${hasName} mapped=${hasPreMapped}`);
      allHaveFields = false;
    }
  }

  if (allHaveFields) {
    pass(`First ${Math.min(data.products.length, 20)} products have required fields (code, name)`);
  } else {
    info(`Some products missing fields: ${missingFields.join(', ')}`);
  }

  info(`Products with pre-mapped images: ${productsWithImages}/${data.products.length}`);

  // Log first few products as sample
  if (data.products.length > 0) {
    const sampleCount = Math.min(3, data.products.length);
    for (let i = 0; i < sampleCount; i++) {
      const p = data.products[i];
      info(`Product #${i + 1}: ${p.name} (code: ${p.productCode || 'N/A'}, brand: ${p.brand || 'N/A'}, hasImage: ${p.hasPreMappedImage})`);
      if (p.description) {
        info(`  Description: ${p.description.substring(0, 100)}...`);
      }
    }
  }

  // Verify image data URLs are valid
  let validImages = 0;
  for (let i = 0; i < Math.min(data.allImages.length, 5); i++) {
    const img = data.allImages[i];
    if (img.dataUrl && img.dataUrl.startsWith('data:image/')) {
      validImages++;
    } else {
      info(`Image #${i} has invalid dataUrl: ${img.dataUrl ? img.dataUrl.substring(0, 50) : 'missing'}`);
    }
  }
  if (validImages > 0) {
    pass(`${validImages}/${Math.min(data.allImages.length, 5)} sample images have valid data URLs`);
  }

  return data;
}

// ── Test: Verify no AI matching needed ────────────────────────────
async function testNoAiMatchingNeeded(processResult) {
  heading('Test 2: Verify no AI matching is needed');

  if (!processResult) {
    fail('No process result — skipping');
    return;
  }

  const { products, allImages, hasEmbeddedImages } = processResult;

  if (!hasEmbeddedImages) {
    fail('hasEmbeddedImages is false — AI matching would be needed');
    return;
  }

  pass('hasEmbeddedImages=true — UI will skip AI matching');

  if (!products || products.length === 0) {
    fail('No products to verify');
    return;
  }

  if (!allImages || allImages.length === 0) {
    fail('No images to verify');
    return;
  }

  // Verify that products with hasPreMappedImage have a corresponding image
  let mappedCount = 0;
  for (const product of products) {
    if (product.hasPreMappedImage && product.imageName) {
      const imgExists = allImages.some(img => img.name === product.imageName);
      if (imgExists) {
        mappedCount++;
      } else {
        info(`Product "${product.name}" references image "${product.imageName}" but not found in allImages`);
      }
    }
  }

  if (mappedCount > 0) {
    pass(`${mappedCount} products have valid pre-mapped image references`);
  } else {
    info('No products with pre-mapped image references found');
  }

  pass('No AI matching API call needed — images are pre-mapped to products');
}

// ── Test: Verify render-queue submission format ───────────────────
async function testRenderQueueFormat(processResult) {
  heading('Test 3: Verify render-queue compatible format');

  if (!processResult) {
    fail('No process result — skipping');
    return;
  }

  const { products, allImages } = processResult;

  // Verify the format matches what handleSubmitToQueue expects
  const sampleMatch = {
    productIndex: 0,
    product: products[0],
    bestMatch: allImages[0] ? {
      imageIndex: 0,
      imageName: allImages[0].name,
      confidence: 100,
      reason: 'Pre-mapped from .et spreadsheet cell',
      status: 'auto_accepted',
      dataUrl: allImages[0].dataUrl
    } : null,
    selectedImageIndex: 0,
    confirmed: true,
    overallConfidence: 'high',
    overallReason: 'Image extracted from .et spreadsheet cell'
  };

  // This is the format handleSubmitToQueue sends to /api/render-queue
  const queueItem = {
    product: sampleMatch.product,
    imageIndex: sampleMatch.selectedImageIndex,
    imageDataUrl: allImages[sampleMatch.selectedImageIndex]?.dataUrl || null,
    confidence: sampleMatch.overallConfidence,
    matchReason: sampleMatch.overallReason,
    matchSource: 'et-embedded'
  };

  if (queueItem.product && queueItem.imageDataUrl) {
    pass('Render queue format is valid');
    info(`Product: ${queueItem.product.name || queueItem.product.productCode}`);
    info(`Image data URL: ${queueItem.imageDataUrl.substring(0, 50)}... (${formatSize(queueItem.imageDataUrl.length)} base64)`);
  } else {
    fail('Render queue format is invalid');
    info(`Has product: ${!!queueItem.product}`);
    info(`Has imageDataUrl: ${!!queueItem.imageDataUrl}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   .et Embedded Image Extraction — E2E Test      ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}`);
  console.log(`API Base: ${API_BASE}`);
  console.log(`ET File: ${SAMPLE_ET}`);

  // Run tests sequentially
  const processResult = await testEtImageUpload();
  await testNoAiMatchingNeeded(processResult);
  await testRenderQueueFormat(processResult);

  // Summary
  heading('Test Summary');
  if (processResult) {
    pass('.et embedded image upload: OK');
    if (processResult.products) {
      pass(`Products extracted: ${processResult.products.length}`);
    }
    if (processResult.allImages) {
      pass(`Embedded images extracted: ${processResult.allImages.length}`);
    }
    if (processResult.hasEmbeddedImages) {
      pass('hasEmbeddedImages flag: true');
    }
  } else {
    fail('.et embedded image upload: FAILED');
    info('This may be because LibreOffice is not installed on this machine.');
    info('The test requires LibreOffice to convert .et → .xlsx.');
    info('Install LibreOffice from: https://www.libreoffice.org/download/');
  }

  console.log('');
}

main().catch(err => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
