import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractProductInfo } from './lib/deepseek.js';
import fs from 'fs';

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
const textResult = await extractTextFromPDF(buffer);
console.log(`Text length: ${textResult.text.length} chars`);
console.log('First 500 chars:');
console.log(textResult.text.slice(0, 500));
console.log('\n--- Calling DeepSeek ---');
try {
  const products = await extractProductInfo(textResult.text);
  console.log(`DeepSeek OK: ${products.length} products`);
  console.log(JSON.stringify(products.slice(0, 2), null, 2));
} catch (e) {
  console.error('DeepSeek FAILED:', e.message);
}
