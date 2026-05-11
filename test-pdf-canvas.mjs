// Test pdfjs-dist + canvas for PDF page rendering
import { createCanvas, loadImage } from 'canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import fs from 'fs';

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log('PDF size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

const loadingTask = pdfjsLib.getDocument({ data: buffer.buffer });
const pdf = await loadingTask.promise;
console.log('Pages:', pdf.numPages);

for (let i = 1; i <= Math.min(pdf.numPages, 3); i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 0.5 });
  console.log(`Page ${i}: ${viewport.width}x${viewport.height}`);
  
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  
  const pngBuffer = canvas.toBuffer('image/png');
  console.log(`  Rendered: ${(pngBuffer.length / 1024).toFixed(1)} KB`);
}

console.log('SUCCESS: PDF pages rendered with canvas!');
