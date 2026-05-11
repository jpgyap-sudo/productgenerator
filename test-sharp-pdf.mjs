// Test sharp PDF rendering
import sharp from 'sharp';
import fs from 'fs';

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log('PDF size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

try {
  const metadata = await sharp(buffer, { page: 0, density: 150 }).metadata();
  console.log('Metadata:', JSON.stringify(metadata));
} catch (e) {
  console.log('sharp PDF error:', e.message);
}

// Try with different approach
try {
  const img = sharp(buffer, { page: 0, density: 150, pages: 1 });
  const pngBuffer = await img.png().toBuffer();
  console.log('Rendered page 1:', pngBuffer.length, 'bytes');
} catch (e) {
  console.log('sharp render error:', e.message);
}
