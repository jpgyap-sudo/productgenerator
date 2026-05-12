import fs from 'fs';
import { extractETImagesAndData } from './lib/et-image-extractor.js';

const buf = fs.readFileSync('./uploads/DINING_CHAIRS.et');
const result = await extractETImagesAndData(buf, { useResume: false });

console.log(`Products: ${result.products.length}`);
console.log(`With images: ${result.products.filter(p => p.hasPreMappedImage).length}`);
console.log(`UUID matched: ${result.products.filter(p => p.matchedViaUUID).length}`);
console.log('\n=== First 15 products ===');
for (let i = 0; i < Math.min(15, result.products.length); i++) {
  const p = result.products[i];
  const matchType = p.matchedViaUUID ? 'UUID' : (p.hasPreMappedImage ? 'SEQ' : 'NONE');
  console.log(`  Row ${String(p.row).padStart(2)}: ${p.productCode.padEnd(10)} img=${(p.imageName||'(none)').padEnd(20)} ${matchType}`);
}
console.log('\n=== Rows 15-25 ===');
for (let i = 14; i < Math.min(25, result.products.length); i++) {
  const p = result.products[i];
  const matchType = p.matchedViaUUID ? 'UUID' : (p.hasPreMappedImage ? 'SEQ' : 'NONE');
  console.log(`  Row ${String(p.row).padStart(2)}: ${p.productCode.padEnd(10)} img=${(p.imageName||'(none)').padEnd(20)} ${matchType}`);
}
