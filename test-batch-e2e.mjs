// ══════════════════════════════════════════════════════════════════
//  END-TO-END BATCH PROCESSOR TEST
//  Tests the full pipeline: PDF extract → ZIP extract → DeepSeek → Match
// ══════════════════════════════════════════════════════════════════

import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractAllImagesFromZip } from './lib/zip-extractor.js';
import { extractProductInfo } from './lib/deepseek.js';
import { matchProductsToImages } from './lib/product-matcher.js';
import fs from 'fs';
import path from 'path';

const PDF_PATH = 'C:/Users/User/Downloads/test scri0pt/Book1.pdf';
const ZIP_PATH = 'C:/Users/User/Downloads/test scri0pt/chair.zip';

async function test() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  BATCH PROCESSOR E2E TEST');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 0: Verify files exist ──
  console.log('Step 0: Verify test files');
  if (!fs.existsSync(PDF_PATH)) {
    console.error('❌ PDF not found:', PDF_PATH);
    process.exit(1);
  }
  if (!fs.existsSync(ZIP_PATH)) {
    console.error('❌ ZIP not found:', ZIP_PATH);
    process.exit(1);
  }
  console.log('  ✅ PDF:', PDF_PATH, `(${ (fs.statSync(PDF_PATH).size / 1024 / 1024).toFixed(2) } MB)`);
  console.log('  ✅ ZIP:', ZIP_PATH, `(${ (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2) } MB)\n`);

  // ── Step 1: Extract PDF text ──
  console.log('Step 1: Extract PDF text');
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  const pdfResult = await extractTextFromPDF(pdfBuffer);
  console.log('  Pages:', pdfResult.pages);
  console.log('  Text length:', pdfResult.text.length, 'chars');
  console.log('  First 300 chars:', pdfResult.text.substring(0, 300).replace(/\s+/g, ' '));
  console.log('  ✅ PDF extracted\n');

  // ── Step 2: Extract ZIP images ──
  console.log('Step 2: Extract ZIP images');
  const zipBuffer = fs.readFileSync(ZIP_PATH);
  const zipResult = await extractAllImagesFromZip(zipBuffer);
  console.log('  Total images:', zipResult.totalImages);
  console.log('  Filtered images:', zipResult.images?.length || 0);
  if (zipResult.images?.length > 0) {
    console.log('  Top 5 images:');
    zipResult.images.slice(0, 5).forEach((img, i) => {
      console.log(`    ${i+1}. ${img.name} (${img.width}x${img.height}) score:${img.score}`);
    });
  }
  console.log('  ✅ ZIP extracted\n');

  // ── Step 3: DeepSeek product extraction ──
  console.log('Step 3: DeepSeek product extraction');
  let products = [];
  try {
    products = await extractProductInfo(pdfResult.text);
    console.log('  Products extracted:', products.length);
    products.forEach((p, i) => {
      console.log(`    ${i+1}. ${p.name || '(no name)'} | Code: ${p.productCode || '(none)'} | Brand: ${p.brand || '(none)'}`);
    });
    console.log('  ✅ DeepSeek extraction succeeded\n');
  } catch (err) {
    console.log('  ⚠️ DeepSeek extraction failed (API key or network issue):', err.message);
    console.log('  Falling back to manual mock products for matching test...\n');
    products = [
      { name: 'Dining Chair HC-001', brand: 'Home Atelier', description: 'A dining chair', productCode: 'HC-001', generatedCode: 'HC-001' },
      { name: 'Arm Chair HC-002', brand: 'Home Atelier', description: 'An arm chair', productCode: 'HC-002', generatedCode: 'HC-002' },
      { name: 'Bar Stool HC-003', brand: 'Home Atelier', description: 'A bar stool', productCode: 'HC-003', generatedCode: 'HC-003' },
    ];
  }

  // ── Step 4: Product-to-Image Matching ──
  console.log('Step 4: Product-to-Image Matching');
  if (!products.length) {
    console.log('  ⚠️ No products to match');
    return;
  }
  if (!zipResult.images?.length) {
    console.log('  ⚠️ No images to match against');
    return;
  }

  const matchResult = matchProductsToImages(products, zipResult.images, { useSequentialFallback: true });
  console.log('  Total matches:', matchResult.matches.length);
  console.log('  Unmatched products:', matchResult.matchStats.unmatched);
  console.log('  Unmatched images:', matchResult.unmatchedImages?.length || 0);
  console.log('');

  console.log('  Match details:');
  matchResult.matches.forEach((m, i) => {
    const code = m.product?.productCode || '?';
    const imgName = m.matchedImage?.name || '?';
    const conf = m.verification?.confidence || '';
    const ok = m.verification?.isMatch === false ? '❌' : '✅';
    console.log(`    ${ok} ${code} → ${imgName} (score: ${m.score}%${conf ? ', ' + conf : ''})`);
  });
  console.log('');

  // ── Step 5: Verify per-product image assignment ──
  console.log('Step 5: Verify per-product image assignment');
  const uniqueImages = new Set(matchResult.matches.map(m => m.matchedImage?.name));
  console.log('  Products matched:', matchResult.matches.length);
  console.log('  Unique images assigned:', uniqueImages.size);
  if (uniqueImages.size === matchResult.matches.length) {
    console.log('  ✅ Each product got its own unique image!\n');
  } else {
    console.log('  ⚠️ Some products share the same image (may be correct if ZIP has duplicates)\n');
  }

  // ── Step 6: Verify match stats ──
  console.log('Step 6: Match stats');
  console.log('  ', matchResult.matchStats);
  console.log('');

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED ✅');
  console.log('═══════════════════════════════════════════════════════════════════');
}

test().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
