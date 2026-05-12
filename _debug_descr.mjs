import fs from 'fs';
import path from 'path';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

const etPath = path.join(process.cwd(), 'uploads', 'DINING_CHAIRS.et');
const etBuffer = fs.readFileSync(etPath);
const result = extractImagesFromETCellImageData(etBuffer);

const sorted = result.sortedImagesByPosition || [];
console.log('=== All sorted images with descr ===');
for (let i = 0; i < sorted.length; i++) {
  const descr = sorted[i].descr || '(no descr)';
  console.log(String(i).padStart(2) + ' | y=' + String(sorted[i].yPos).padStart(8) + ' | ' + sorted[i].name + ' | descr=' + descr);
}
