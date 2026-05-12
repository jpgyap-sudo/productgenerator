import { extractImagesFromETCellImageData, isETFile, hasETCellImageData } from './lib/et-ole-image-extractor.js';
import fs from 'fs';

const etBuffer = fs.readFileSync('DINING_CHAIRS_COPY.et');

console.log('isETFile:', isETFile(etBuffer));
console.log('hasETCellImageData:', hasETCellImageData(etBuffer));

const result = extractImagesFromETCellImageData(etBuffer);

console.log('\n=== Results ===');
console.log('Success:', result.success);
console.log('Image count:', result.imageCount);
console.log('Error:', result.error || 'none');

if (result.images.length > 0) {
  console.log('\nFirst 5 images:');
  result.images.slice(0, 5).forEach((img, i) => {
    console.log(`  [${i}] ${img.name} (${img.size} bytes, UUID: ${img.uuid.substring(0, 30)}...)`);
  });

  console.log('\nLast 3 images:');
  result.images.slice(-3).forEach((img, i) => {
    console.log(`  [${result.images.length - 3 + i}] ${img.name} (${img.size} bytes, UUID: ${img.uuid.substring(0, 30)}...)`);
  });

  // Check UUID map
  console.log('\nUUID map size:', result.uuidMap.size);
  
  // Show some UUID mappings
  let count = 0;
  for (const [uuid, img] of result.uuidMap) {
    if (count < 5) {
      console.log(`  UUID: ${uuid} → ${img.name}`);
      count++;
    }
  }
}

// Clean up
fs.unlinkSync('DINING_CHAIRS_COPY.et');
