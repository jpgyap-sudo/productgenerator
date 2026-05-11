import { extractImagesFromPDF } from './lib/pdf-image-extractor.js';
import { extractTextFromPDF } from './lib/pdf-extractor.js';
import fs from 'fs';

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log(`PDF size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

console.log('\n--- Testing extractTextFromPDF ---');
try {
  const textResult = await extractTextFromPDF(buffer);
  console.log(`Text extraction OK: ${textResult.text.length} chars, ${textResult.pages} pages`);
} catch (e) {
  console.error('Text extraction FAILED:', e.message);
  console.error(e.stack);
}

console.log('\n--- Testing extractImagesFromPDF ---');
try {
  const imagesResult = await extractImagesFromPDF(Buffer.from(buffer));
  console.log(`Image extraction OK: ${imagesResult.length} pages`);
  for (const img of imagesResult) {
    console.log(`  Page ${img.page}: ${img.width}x${img.height}, ${(img.size / 1024).toFixed(1)} KB`);
  }
} catch (e) {
  console.error('Image extraction FAILED:', e.message);
  console.error(e.stack);
}

console.log('\n--- Done ---');
