// ═══════════════════════════════════════════════════════════════════
//  test-ole-integration.mjs
//  Test the OLE2 extractor integration with the main pipeline.
//  Verifies that extractImagesFromETCellImageData works correctly
//  when called from extractETImagesAndData.
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

// Path to the .et file
const etPath = 'C:\\Users\\User\\Downloads\\wps\\DINING CHAIRS.et';

if (!fs.existsSync(etPath)) {
  console.error(`File not found: ${etPath}`);
  process.exit(1);
}

console.log(`Reading .et file: ${etPath}`);
const etBuffer = fs.readFileSync(etPath);
console.log(`File size: ${(etBuffer.length / 1024 / 1024).toFixed(2)} MB`);

// ── Test 1: OLE2 extraction ──────────────────────────────────────
console.log('\n═══ Test 1: OLE2 ETCellImageData extraction ═══');
const oleResult = extractImagesFromETCellImageData(etBuffer);

if (oleResult.success) {
  console.log(`✅ SUCCESS: ${oleResult.imageCount} images extracted`);
  console.log(`   UUID mappings: ${oleResult.uuidMap.size}`);

  // Show first 5 images
  console.log('\nFirst 5 images:');
  oleResult.images.slice(0, 5).forEach((img, i) => {
    console.log(`   ${i + 1}. ${img.name} (${(img.size / 1024).toFixed(1)} KB, UUID: ${img.uuid})`);
  });

  // Show last 3 images
  if (oleResult.images.length > 5) {
    console.log(`\nLast 3 images:`);
    oleResult.images.slice(-3).forEach((img, i) => {
      console.log(`   ${oleResult.images.length - 2 + i}. ${img.name} (${(img.size / 1024).toFixed(1)} KB, UUID: ${img.uuid})`);
    });
  }

  // Verify all images have dataUrl
  const withoutDataUrl = oleResult.images.filter(img => !img.dataUrl);
  if (withoutDataUrl.length > 0) {
    console.log(`\n⚠️  ${withoutDataUrl.length} images missing dataUrl`);
  } else {
    console.log(`\n✅ All ${oleResult.images.length} images have dataUrl`);
  }

  // Verify all images have UUID
  const withoutUuid = oleResult.images.filter(img => !img.uuid);
  if (withoutUuid.length > 0) {
    console.log(`⚠️  ${withoutUuid.length} images missing UUID`);
  } else {
    console.log(`✅ All ${oleResult.images.length} images have UUID`);
  }

  // Show UUID sample
  console.log('\nSample UUID mappings:');
  let count = 0;
  for (const [uuid, img] of oleResult.uuidMap) {
    if (count >= 3) break;
    console.log(`   ${uuid} → ${img.name}`);
    count++;
  }

} else {
  console.log(`❌ FAILED: ${oleResult.error}`);
}

// ── Test 2: Verify dataUrl format ────────────────────────────────
console.log('\n═══ Test 2: Data URL format check ═══');
if (oleResult.images.length > 0) {
  const firstImg = oleResult.images[0];
  const isValidDataUrl = firstImg.dataUrl.startsWith('data:image/');
  console.log(`First image dataUrl starts with 'data:image/': ${isValidDataUrl}`);
  console.log(`MIME type: ${firstImg.mimeType}`);
  console.log(`Data URL length: ${firstImg.dataUrl.length} chars`);
}

// ── Test 3: Verify the module can be imported alongside et-image-extractor ──
console.log('\n═══ Test 3: Module import compatibility ═══');
try {
  const { extractImagesFromETCellImageData: reimported } = await import('./lib/et-ole-image-extractor.js');
  console.log('✅ Module can be re-imported');
} catch (err) {
  console.log(`❌ Module import failed: ${err.message}`);
}

// ── Summary ──────────────────────────────────────────────────────
console.log('\n═══ Summary ═══');
console.log(`Images extracted: ${oleResult.imageCount}`);
console.log(`UUID mappings: ${oleResult.uuidMap.size}`);
console.log(`Success: ${oleResult.success}`);
if (oleResult.error) console.log(`Error: ${oleResult.error}`);

// Write results to file for inspection
const summary = {
  imageCount: oleResult.imageCount,
  uuidMapSize: oleResult.uuidMap.size,
  success: oleResult.success,
  images: oleResult.images.map(img => ({
    name: img.name,
    size: img.size,
    uuid: img.uuid,
    mimeType: img.mimeType,
    hasDataUrl: !!img.dataUrl
  }))
};
fs.writeFileSync('test-ole-integration-result.json', JSON.stringify(summary, null, 2));
console.log('\nResults written to test-ole-integration-result.json');
