// Debug script to inspect .et file headers and structure
import XLSX from 'xlsx';
import fs from 'fs';
import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

const etPath = process.argv[2] || 'uploads/DINING_CHAIRS.et';
const etBuffer = fs.readFileSync(etPath);

const tmpDir = path.join(os.tmpdir(), 'et-debug');
await mkdir(tmpDir, { recursive: true });
const ts = Date.now();
const inPath = path.join(tmpDir, `input_${ts}.et`);
const outPath = path.join(tmpDir, `input_${ts}.xlsx`);

await writeFile(inPath, etBuffer);

await new Promise((resolve, reject) => {
  const proc = spawn('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', tmpDir, inPath], {
    timeout: 60000, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  proc.stderr.on('data', c => stderr += c.toString());
  proc.on('close', async code => {
    try { await unlink(inPath); } catch {}
    if (code !== 0) { reject(new Error(stderr)); return; }
    resolve();
  });
  proc.on('error', reject);
});

const xlsxBuf = await readFile(outPath);
await unlink(outPath);

const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });

console.log('=== FILE INFO ===');
console.log('File:', etPath);
console.log('Size:', (etBuffer.length / 1024 / 1024).toFixed(2), 'MB');
console.log('Sheet names:', wb.SheetNames);
console.log('Total rows in data:', data.length);

console.log('\n=== HEADER ROW (Row 0) ===');
console.log(JSON.stringify(data[0]));

console.log('\n=== HEADER ROW (lowercased) ===');
const headers = data[0].map(h => String(h || '').toLowerCase().trim());
console.log(JSON.stringify(headers));

console.log('\n=== COLUMN SEARCH ===');
const findCol = (keywords) => {
  for (let i = 0; i < headers.length; i++) {
    for (const kw of keywords) {
      if (headers[i].includes(kw)) return i;
    }
  }
  return -1;
};
console.log('code col:', findCol(['code', 'product code', 'item code', 'sku', 'no', 'part number']));
console.log('desc col:', findCol(['description', 'desc', 'product description', 'item description', 'name', 'product name']));
console.log('brand col:', findCol(['brand', 'brand name', 'manufacturer', 'vendor']));
console.log('image col:', findCol(['image', 'img', 'picture', 'photo', 'pic']));

console.log('\n=== FIRST 10 DATA ROWS ===');
for (let i = 1; i < Math.min(11, data.length); i++) {
  const row = data[i];
  if (!row) continue;
  if (row.every(c => c === '' || c === null || c === undefined)) {
    console.log(`  Row ${i}: [EMPTY]`);
    continue;
  }
  console.log(`  Row ${i}:`, JSON.stringify(row));
}

console.log('\n=== ROWS WITH NON-EMPTY DATA (first 20) ===');
let count = 0;
for (let i = 1; i < data.length && count < 20; i++) {
  const row = data[i];
  if (!row) continue;
  const hasData = row.some(c => c !== '' && c !== null && c !== undefined);
  if (hasData) {
    console.log(`  Row ${i}:`, JSON.stringify(row.slice(0, 8)));
    count++;
  }
}
