import { extractImagesFromZip } from './lib/zip-extractor.js';
import fs from 'fs';

try {
  console.log('Starting ZIP extraction...');
  const buf = fs.readFileSync('C:/Users/User/Downloads/home atelier upload/chair.zip');
  console.log('ZIP size:', (buf.length/1024).toFixed(0), 'KB');
  
  const result = await extractImagesFromZip(buf);
  console.log('Total images:', result.totalImages);
  console.log('Selected image:', result.selectedImage?.name);
  console.log('Selected image score:', result.selectedImage?.score);
  console.log('Selected image data length:', result.selectedImage?.data?.length || 0, 'bytes');
  console.log('--- DONE ---');
} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
}
