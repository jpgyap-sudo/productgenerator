import { extractTextFromPDF } from './lib/pdf-extractor.js';
import fs from 'fs';

const pdfBuf = fs.readFileSync('C:/Users/User/Downloads/test scri0pt/Book1.pdf');
const { text } = await extractTextFromPDF(pdfBuf);
const lines = text.split('\n');

console.log('Total lines:', lines.length);
console.log('---');

// Show lines 7-20 (where CH- codes should be)
for (let i = 6; i < Math.min(30, lines.length); i++) {
  console.log(`Line ${i}:`, JSON.stringify(lines[i]));
}

console.log('---');
// Search for CH- patterns
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/CH-/)) {
    console.log(`CH- found at line ${i}:`, JSON.stringify(lines[i]));
  }
}

// Test the regex
const text2 = 'CH-790\nCH-789\nCH-800';
const codeLineRegex = /^([A-Za-z]{1,4}[-_]\d{2,4})$/gm;
let match;
while ((match = codeLineRegex.exec(text2)) !== null) {
  console.log('Regex test match:', match[1]);
}

// Test on actual text
console.log('--- Testing regex on actual text ---');
const codeLineRegex2 = /^([A-Za-z]{1,4}[-_]\d{2,4})$/gm;
while ((match = codeLineRegex2.exec(text)) !== null) {
  console.log('Actual match:', match[1]);
}
