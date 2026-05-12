import { extractImagesFromPDF } from './lib/pdf-image-extractor.js';
import fs from 'fs';

// Direct pdfjs text extraction
async function extractTextDirect(pdfBuffer) {
  const canvas = await import('@napi-rs/canvas');
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
  if (!globalThis.ImageData) globalThis.ImageData = canvas.ImageData;
  if (!globalThis.Path2D) globalThis.Path2D = canvas.Path2D;
  
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bufferCopy = pdfBuffer.buffer.slice(0);
  const loadingTask = pdfjsLib.getDocument({ data: bufferCopy });
  const pdf = await loadingTask.promise;
  
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join('');
    fullText += pageText + '\n';
    page.cleanup();
  }
  pdf.destroy();
  return fullText;
}

function mem() {
  const u = process.memoryUsage();
  return `RSS: ${(u.rss / 1024 / 1024).toFixed(1)}MB, Heap: ${(u.heapUsed / 1024 / 1024).toFixed(1)}MB`;
}

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log(`Start: ${mem()}`);

const pages = await extractImagesFromPDF(Buffer.from(buffer));
console.log(`After images: ${mem()}`);

if (global.gc) global.gc();

const text = await extractTextDirect(buffer);
console.log(`After direct text: ${mem()}, chars: ${text.length}`);

if (global.gc) global.gc();
console.log(`After GC: ${mem()}`);
