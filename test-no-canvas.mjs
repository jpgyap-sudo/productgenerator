import fs from 'fs';

async function extractTextNoCanvas(pdfBuffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bufferCopy = pdfBuffer.buffer.slice(0);
  const loadingTask = pdfjsLib.getDocument({ data: bufferCopy, disableFontFace: true });
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
try {
  const text = await extractTextNoCanvas(buffer);
  console.log(`After text (no canvas): ${mem()}, chars: ${text.length}`);
} catch (e) {
  console.error('Failed:', e.message);
}
if (global.gc) global.gc();
console.log(`After GC: ${mem()}`);
