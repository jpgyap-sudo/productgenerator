import { extractTextFromPDF } from './lib/pdf-extractor.js';
import fs from 'fs';

const pdfBuf = fs.readFileSync('C:/Users/User/Downloads/test scri0pt/Book1.pdf');
const { text } = await extractTextFromPDF(pdfBuf);

// Simulate the chunk splitting
const BATCH_SIZE = 4000;
const lines = text.split('\n');
const chunks = [];
let current = '';
for (const line of lines) {
  if (current.length + line.length + 1 > BATCH_SIZE && current.length > 0) {
    chunks.push(current.trim());
    current = line;
  } else {
    current += (current ? '\n' : '') + line;
  }
}
if (current.trim()) chunks.push(current.trim());

console.log('Number of chunks:', chunks.length);
for (let i = 0; i < chunks.length; i++) {
  // Test regex on each chunk
  const codeLineRegex = /^([A-Za-z]{1,4}[-_]\d{2,4})$/gm;
  const codes = [];
  let match;
  while ((match = codeLineRegex.exec(chunks[i])) !== null) {
    codes.push(match[1]);
  }
  console.log('Chunk', i+1, ':', chunks[i].length, 'chars, codes found:', codes.length, codes.slice(0,5));
  
  // Show first and last 100 chars
  console.log('  Start:', JSON.stringify(chunks[i].substring(0, 100)));
  console.log('  End:', JSON.stringify(chunks[i].substring(chunks[i].length - 100)));
}
