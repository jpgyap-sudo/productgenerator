import fs from 'fs';
import path from 'path';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

const etPath = path.join(process.cwd(), 'uploads', 'DINING_CHAIRS.et');
const etBuffer = fs.readFileSync(etPath);
const result = extractImagesFromETCellImageData(etBuffer);

const sorted = result.sortedImagesByPosition || [];
console.log('=== All 50 position-sorted images ===');
console.log('Idx | yPos      | Name');
console.log('----+-----------+------------------');
for (let i = 0; i < sorted.length; i++) {
  console.log(String(i).padStart(3) + ' | ' + String(sorted[i].yPos).padStart(8) + ' | ' + sorted[i].name);
}
