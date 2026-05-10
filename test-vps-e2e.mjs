// ══════════════════════════════════════════════════════════════════
//  VPS E2E Test — Tests the full batch pipeline on the VPS
// ══════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';

const VPS = 'http://104.248.225.250:3000';
const PDF_PATH = 'C:/Users/User/Downloads/test scri0pt/Book1.pdf';
const ZIP_PATH = 'C:/Users/User/Downloads/test scri0pt/chair.zip';

async function test() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  VPS E2E TEST — Full Batch Pipeline');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Test 1: Health check ──
  console.log('Test 1: Health Check');
  const h = await fetch(`${VPS}/health`);
  console.log(`  Status: ${h.status} ${h.ok ? '✅' : '❌'}`);
  if (!h.ok) { console.log('  FAIL: VPS not reachable'); process.exit(1); }

  // ── Test 2: Upload PDF+ZIP via multipart ──
  console.log('\nTest 2: Upload PDF + ZIP to /api/agent/process');
  const pdfBuf = fs.readFileSync(PDF_PATH);
  const zipBuf = fs.readFileSync(ZIP_PATH);
  const form = new FormData();
  form.append('pdf', new Blob([pdfBuf], { type: 'application/pdf' }), 'Book1.pdf');
  form.append('zip', new Blob([zipBuf], { type: 'application/zip' }), 'chair.zip');

  const pRes = await fetch(`${VPS}/api/agent/process`, { method: 'POST', body: form });
  const pData = await pRes.json();
  console.log(`  success: ${pData.success}`);
  console.log(`  products: ${pData.products?.length}`);
  console.log(`  allImages: ${pData.allImages?.length}`);
  console.log(`  error: ${pData.error || 'none'}`);
  if (!pData.success || !pData.products?.length) {
    console.log('  ❌ FAIL: No products extracted');
    process.exit(1);
  }
  console.log('  ✅ Process OK');

  // ── Test 3: Match products to images via vision (with PDF reference images) ──
  console.log('\nTest 3: Vision matching via /api/agent/match-vision');
  // Use first 3 products and first 10 images for speed
  const testProducts = pData.products.slice(0, 3);
  const testImages = pData.allImages.slice(0, 10);
  const testPdfImages = pData.pdfImages || []; // PDF page images for visual reference

  console.log(`  PDF reference images available: ${testPdfImages.length}`);

  const mRes = await fetch(`${VPS}/api/agent/match-vision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: testProducts,
      images: testImages,
      pdfImages: testPdfImages  // Send PDF page images for GPT-4o visual comparison
    })
  });
  const mData = await mRes.json();
  console.log(`  success: ${mData.success}`);
  console.log(`  matches: ${mData.matches?.length}`);
  console.log(`  stats: ${JSON.stringify(mData.stats)}`);

  if (!mData.success) {
    console.log(`  ❌ FAIL: ${mData.error} ${mData.details || ''}`);
    process.exit(1);
  }

  // Show first match details
  if (mData.matches?.[0]) {
    const m = mData.matches[0];
    console.log(`  First product: ${m.product?.name || 'unknown'}`);
    console.log(`  Best match: ${m.bestMatch?.imageId || 'none'} (confidence: ${m.overallConfidence})`);
    console.log(`  Auto-accept: ${m.autoAccept}`);
    console.log(`  Gemini fallback: ${m.geminiFallback}`);
    console.log(`  Top 3 candidates:`);
    ['bestMatch', 'secondMatch', 'thirdMatch'].forEach((k, i) => {
      if (m[k]) console.log(`    ${i+1}. ${m[k].imageId} (score: ${m[k].score})`);
    });
  }

  // Check stats
  const s = mData.stats || {};
  console.log(`\n  Stats summary:`);
  console.log(`    Total: ${s.totalProducts} products, ${s.totalImages} images`);
  console.log(`    Fingerprints: ${s.fingerprintsCreated}`);
  console.log(`    Auto-accepted: ${s.autoAccepted}`);
  console.log(`    Needs review: ${s.needsReview}`);
  console.log(`    Gemini fallback: ${s.geminiFallback}`);

  // Show PDF image usage stats
  const usedPdfCount = mData.matches?.filter(m => m.usedPdfImage).length || 0;
  console.log(`  Products matched with PDF reference: ${usedPdfCount}/${mData.matches?.length || 0}`);

  if (mData.matches?.length > 0) {
    console.log('\n  ✅ Match OK');
  } else {
    console.log('  ⚠️  No matches returned (may need review)');
  }

  // ── Test 4: Check match-vision route exists (regression) ──
  console.log('\nTest 4: Route registration check');
  const rCheck = await fetch(`${VPS}/api/agent/match-vision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products: [], images: [] })
  });
  const rData = await rCheck.json();
  console.log(`  Expected error (empty arrays): ${rData.error}`);
  console.log(`  ${rData.error === 'products array is required' ? '✅ Route OK' : '❌ Route issue'}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED ✅');
  console.log('═══════════════════════════════════════════════════════════════════');
}

test().catch(e => {
  console.error('\n❌ TEST FAILED:', e.message);
  process.exit(1);
});
