import fs from 'fs';
import path from 'path';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

const etPath = path.join(process.cwd(), 'uploads', 'DINING_CHAIRS.et');
const etBuffer = fs.readFileSync(etPath);
const result = extractImagesFromETCellImageData(etBuffer);

// Show the raw cellImages entries with yPos and UUID
const sorted = result.sortedImagesByPosition || [];
console.log('=== First 10 with UUID and yPos ===');
for (let i = 0; i < Math.min(10, sorted.length); i++) {
  console.log('[' + i + '] ' + sorted[i].name + ' y=' + sorted[i].yPos + ' uuid=' + (sorted[i].uuid || 'N/A').substring(0, 36));
}

// Also show the uuidMap entries
console.log('');
console.log('=== uuidMap sample (first 10) ===');
let count = 0;
for (const [uuid, imgName] of result.uuidMap) {
  if (count++ >= 10) break;
  console.log('UUID=' + uuid.substring(0, 36) + ' -> ' + imgName);
}

// Show the raw cellImages.xml entries (from the OLE2 extraction)
// Let's also check what the cellImages.xml looks like
console.log('');
console.log('=== All sorted images with UUID ===');
for (let i = 0; i < sorted.length; i++) {
  const uuid = sorted[i].uuid || 'NO_UUID';
  console.log(String(i).padStart(2) + ' | y=' + String(sorted[i].yPos).padStart(8) + ' | ' + sorted[i].name + ' | uuid=' + uuid.substring(0, 36));
}
