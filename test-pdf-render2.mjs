// Test pdfjs-dist rendering directly
import * as pdfjsLib from 'pdfjs-dist';
import fs from 'fs';

// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const buffer = fs.readFileSync('uploads/DINING_CHAIRS_with_Brand.pdf');
console.log('PDF size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

const loadingTask = pdfjsLib.getDocument({ data: buffer.buffer });
const pdf = await loadingTask.promise;
console.log('Pages:', pdf.numPages);

for (let i = 1; i <= Math.min(pdf.numPages, 3); i++) {
  const page = await pdf.getPage(i);
  const viewport = page.getViewport({ scale: 0.5 });
  console.log(`Page ${i}: ${viewport.width}x${viewport.height}`);
}
console.log('SUCCESS: pdfjs-dist can read the PDF');
