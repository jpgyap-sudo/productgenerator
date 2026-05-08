import { extractTextFromPDF } from './lib/pdf-extractor.js';
import fs from 'fs';

const buf = fs.readFileSync('C:/Users/User/Downloads/test scri0pt/Book1.pdf');
const r = await extractTextFromPDF(buf);
const lines = r.text.split('\n');
for (let i = 0; i < Math.min(100, lines.length); i++) {
  console.log((i+1) + ': ' + lines[i].substring(0, 150));
}
