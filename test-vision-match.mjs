// ══════════════════════════════════════════════════════════════════
//  VISION MATCHER E2E TEST
//  Tests the full vision-based matching pipeline:
//  PDF product rows -> ZIP images -> Visual fingerprints -> Ranked candidates
// ══════════════════════════════════════════════════════════════════

import { matchProductsWithVision } from './lib/vision-matcher.js';
import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractAllImagesFromZip } from './lib/zip-extractor.js';
import { extractProductInfo } from './lib/deepseek.js';
import fs from 'fs';

const PDF_PATH = 'C:/Users/User/Downloads/test scri0pt/Book1.pdf';
const ZIP_PATH = 'C:/Users/User/Downloads/test scri0pt/chair.zip';

async function test() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  VISION MATCHER E2E TEST');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // -- Step 0: Check API key --
  if (!process.env.OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable not set');
    console.error('   Set it with: set OPENAI_API_KEY=sk-...');
    process.exit(1);
  }
  console.log('  [OK] OPENAI_API_KEY configured\n');

  // -- Step 1: Extract PDF text --
  console.log('Step 1: Extract PDF text');
  let products = [];
  let rawText = '';

  if (fs.existsSync(PDF_PATH)) {
    const pdfBuffer = fs.readFileSync(PDF_PATH);
    const pdfResult = await extractTextFromPDF(pdfBuffer);
    rawText = pdfResult.text;
    console.log('  Pages: ' + pdfResult.pages);
    console.log('  Text length: ' + rawText.length + ' chars');

    // Step 1b: Extract products using DeepSeek
    console.log('\nStep 1b: Extract product info with DeepSeek...');
    try {
      products = await extractProductInfo(rawText);
      console.log('  Products extracted: ' + products.length);
      products.forEach((p, i) => {
        console.log('    ' + (i + 1) + '. ' + (p.name || '(no name)') + ' | Code: ' + (p.productCode || '(none)') + ' | ' + (p.category || ''));
      });
    } catch (err) {
      console.log('  [WARN] DeepSeek failed: ' + err.message);
      console.log('  Using mock products...');
    }
  } else {
    console.log('  [WARN] PDF not found at: ' + PDF_PATH);
    console.log('  Using mock products...');
  }

  // Fallback to mock products if extraction failed or no PDF
  if (products.length === 0) {
    products = [
      {
        name: 'Dining Chair HC-001',
        brand: 'Home Atelier',
        productCode: 'HC-001',
        category: 'chair',
        material: 'fabric/wood',
        color: 'beige',
        dimensions: '50x55x80 cm',
        description: 'Elegant upholstered dining chair with wooden legs, beige fabric seat, curved backrest',
        page: 1
      },
      {
        name: 'Arm Chair HC-002',
        brand: 'Home Atelier',
        productCode: 'HC-002',
        category: 'chair',
        material: 'leather/metal',
        color: 'brown',
        dimensions: '65x60x85 cm',
        description: 'Brown leather armchair with metal frame, padded armrests, tufted back',
        page: 2
      },
      {
        name: 'Bar Stool HC-003',
        brand: 'Home Atelier',
        productCode: 'HC-003',
        category: 'stool',
        material: 'wood/metal',
        color: 'black',
        dimensions: '40x40x75 cm',
        description: 'Black bar stool with wooden seat, metal legs, footrest',
        page: 3
      }
    ];
    console.log('  Using ' + products.length + ' mock products:\n');
    products.forEach((p, i) => {
      console.log('    ' + (i + 1) + '. ' + p.name + ' (' + p.productCode + ')');
    });
  }

  // -- Step 2: Extract ZIP images --
  console.log('\nStep 2: Extract ZIP images');
  let images = [];

  if (fs.existsSync(ZIP_PATH)) {
    const zipBuffer = fs.readFileSync(ZIP_PATH);
    const zipResult = await extractAllImagesFromZip(zipBuffer);
    images = zipResult.images || [];
    console.log('  Total images in ZIP: ' + zipResult.totalImages);
    console.log('  Images loaded: ' + images.length);
    if (images.length > 0) {
      console.log('  First 5 images:');
      images.slice(0, 5).forEach((img, i) => {
        console.log('    ' + (i + 1) + '. ' + img.name + ' (' + img.width + 'x' + img.height + ')');
      });
    }
  } else {
    console.log('  [WARN] ZIP not found at: ' + ZIP_PATH);
    console.log('  Cannot run full E2E test without real ZIP images.');
    console.log('  Please ensure the ZIP file exists at the expected path.');
    process.exit(1);
  }

  // -- Step 3: Run vision matching --
  console.log('\nStep 3: Run vision-based matching...');
  console.log('  Products: ' + products.length + ', Images: ' + images.length);
  console.log('  This will call OpenAI Vision API for each image...\n');

  const startTime = Date.now();

  try {
    const result = await matchProductsWithVision(products, images);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('  RESULTS (' + elapsed + 's)');
    console.log('═══════════════════════════════════════════════════════════════════\n');

    console.log('  Stats:');
    console.log('    Total products: ' + result.stats.totalProducts);
    console.log('    Total images: ' + result.stats.totalImages);
    console.log('    Fingerprints created: ' + result.stats.fingerprintsCreated);
    console.log('    Auto-accepted: ' + result.stats.autoAccepted);
    console.log('    Needs review: ' + result.stats.needsReview);
    console.log('');

    // Print each product's matches
    result.matches.forEach((m, i) => {
      console.log('  Product ' + (i + 1) + ': ' + (m.product.name || m.product.productCode || 'unknown'));
      console.log('    Confidence: ' + m.overallConfidence);
      console.log('    Auto-accept: ' + m.autoAccept);
      console.log('    Reason: ' + m.overallReason);

      if (m.bestMatch) {
        console.log('    [1] ' + m.bestMatch.imageId + ' (confidence: ' + m.bestMatch.confidence + '%)');
        console.log('        Reason: ' + m.bestMatch.reason);
      } else {
        console.log('    [1] No match');
      }

      if (m.secondMatch) {
        console.log('    [2] ' + m.secondMatch.imageId + ' (confidence: ' + m.secondMatch.confidence + '%)');
      } else {
        console.log('    [2] No match');
      }

      if (m.thirdMatch) {
        console.log('    [3] ' + m.thirdMatch.imageId + ' (confidence: ' + m.thirdMatch.confidence + '%)');
      } else {
        console.log('    [3] No match');
      }
      console.log('');
    });

    // Summary
    const highConf = result.matches.filter(m => m.overallConfidence === 'high').length;
    const medConf = result.matches.filter(m => m.overallConfidence === 'medium').length;
    const lowConf = result.matches.filter(m => m.overallConfidence === 'low').length;
    const noneConf = result.matches.filter(m => m.overallConfidence === 'none' || m.overallConfidence === 'error').length;

    console.log('  Summary:');
    console.log('    High confidence (auto-accept): ' + highConf);
    console.log('    Medium confidence (review): ' + medConf);
    console.log('    Low confidence (manual): ' + lowConf);
    console.log('    No match / Error: ' + noneConf);
    console.log('\n  [DONE] Vision matching test complete');

  } catch (err) {
    console.error('\n  [FAIL] Vision matching failed: ' + err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
