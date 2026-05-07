import { extractTextFromPDF } from './lib/pdf-extractor.js';
import { extractImagesFromZip } from './lib/zip-extractor.js';
import fs from 'fs';

async function test() {
  console.log('=== Testing PDF extraction ===');
  const pdfBuffer = fs.readFileSync('/root/DINING CHAIRS.pdf');
  const pdfResult = await extractTextFromPDF(pdfBuffer);
  console.log('PDF text length:', pdfResult.text.length, 'chars');
  console.log('PDF pages:', pdfResult.pages);
  console.log('First 800 chars:', pdfResult.text.substring(0, 800));
  
  console.log('\n=== Testing ZIP extraction ===');
  const zipBuffer = fs.readFileSync('/root/chair.zip');
  const zipResult = await extractImagesFromZip(zipBuffer);
  console.log('Total images:', zipResult.totalImages);
  if (zipResult.selectedImage) {
    console.log('Selected image:', zipResult.selectedImage.name, '(' + zipResult.selectedImage.width + 'x' + zipResult.selectedImage.height + ')');
  }
  console.log('Top 5 images:');
  zipResult.images.slice(0, 5).forEach((i, idx) => {
    console.log('  ' + (idx+1) + '.', i.name, i.width + 'x' + i.height, 'score:' + i.score, i.selected ? '[SELECTED]' : '');
  });
}
test().catch(console.error);
