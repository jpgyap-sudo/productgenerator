import { extractImagesFromPDF } from './lib/pdf-image-extractor.js';
import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractProductInfo } from './lib/deepseek.js';
import fs from 'fs';

function mem() {
  const u = process.memoryUsage();
  return `RSS: ${(u.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(u.heapUsed / 1024 / 1024).toFixed(1)}MB, External: ${(u.external / 1024 / 1024).toFixed(1)}MB`;
}

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log(`Start: ${mem()}`);

console.log('\n--- Image extraction ---');
const pages = await extractImagesFromPDF(Buffer.from(buffer));
console.log(`After images: ${mem()}, pages: ${pages.length}`);

console.log('\n--- Text extraction ---');
const textResult = await extractTextFromPDF(buffer);
console.log(`After text: ${mem()}, chars: ${textResult.text.length}`);

// Simulate keeping results in memory (like server does)
const allImages = pages.map(p => ({ dataUrl: p.dataUrl, size: p.size }));
console.log(`\nAfter storing: ${mem()}, images: ${allImages.length}`);

// Note: DeepSeek skipped locally (no API key)
console.log('\nDone.');
