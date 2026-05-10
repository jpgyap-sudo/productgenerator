import { extractTextFromPDF } from './lib/pdf-extractor.js';
import fs from 'fs';

const buf = fs.readFileSync('C:/Users/User/Downloads/test scri0pt/Book1.pdf');
const result = await extractTextFromPDF(buf);
console.log('TEXT LENGTH:', result.text.length);
console.log('PAGES:', result.pages);
console.log('---FULL TEXT START---');
console.log(result.text);
console.log('---FULL TEXT END---');
