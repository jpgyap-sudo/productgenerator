// Quick test for pdf-to-img rendering
import { pdf } from 'pdf-to-img';
import fs from 'fs';

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log('PDF size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

let pages = 0;
for await (const img of pdf(buffer, { scale: 0.5 })) {
  pages++;
  if (pages <= 2) {
    console.log(`Page ${pages}: ${img.substring(0, 60)}... (length: ${img.length})`);
  }
}
console.log('Total pages rendered:', pages);
