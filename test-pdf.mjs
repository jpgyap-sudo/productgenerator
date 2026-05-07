import { extractTextFromPDFFile } from './lib/pdf-extractor.js';

try {
  console.log('Starting PDF extraction...');
  const result = await extractTextFromPDFFile('C:/Users/User/Downloads/home atelier upload/DINING CHAIRS.pdf', { maxPages: 3 });
  console.log('Pages:', result.pages);
  console.log('Text length:', result.text.length);
  console.log('--- FIRST 800 CHARS ---');
  console.log(result.text.substring(0, 800));
  console.log('--- DONE ---');
} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
}
