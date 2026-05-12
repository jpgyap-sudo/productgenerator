// Debug script to run on VPS: dump the actual extraction results
import fs from 'fs';
import { extractETImagesAndData, isETFile } from './lib/et-image-extractor.js';

const buf = fs.readFileSync('./uploads/DINING_CHAIRS.et');
console.log('isETFile:', isETFile(buf));

const result = await extractETImagesAndData(buf, { useResume: false });

console.log('\n=== SUMMARY ===');
console.log('Products:', result.products.length);
console.log('With images:', result.products.filter(p => p.hasPreMappedImage).length);
console.log('UUID matched:', result.products.filter(p => p.matchedViaUUID).length);
console.log('Total images:', result.totalImages);

console.log('\n=== ALL PRODUCTS (code → image mapping) ===');
result.products.forEach((p, i) => {
  const imgShort = p.imageName ? p.imageName.split('/').pop() : '(none)';
  const matchType = p.matchedViaUUID ? 'UUID' : (p.hasPreMappedImage ? 'POS' : 'NONE');
  console.log(`  [${String(i).padStart(2)}] Row ${String(p.row).padStart(2)}: code=${p.productCode.padEnd(10)} img=${imgShort.padEnd(20)} match=${matchType}`);
});

console.log('\n=== DISPIMG FORMULA CHECK ===');
// Re-parse to check DISPIMG formulas
import XLSX from 'xlsx';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

const oleResult = extractImagesFromETCellImageData(buf);
console.log('OLE2 images:', oleResult.imageCount);
console.log('OLE2 uuidMap size:', oleResult.uuidMap.size);
console.log('OLE2 sortedImagesByPosition:', oleResult.sortedImagesByPosition.length);

// Check DISPIMG formulas in the xlsx
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-debug-'));
const etPath = path.join(tempDir, 'input.et');
const xlsxPath = path.join(tempDir, 'output.xlsx');
fs.writeFileSync(etPath, buf);

await new Promise((resolve, reject) => {
  const proc = spawn('soffice', [
    '--headless', '--convert-to', 'xlsx', '--outdir', tempDir, etPath
  ], { stdio: 'pipe' });
  let stderr = '';
  proc.stderr.on('data', d => stderr += d);
  proc.on('exit', code => {
    if (code === 0) resolve();
    else reject(new Error(`soffice exit ${code}: ${stderr}`));
  });
});

const xlsxBuf = fs.readFileSync(xlsxPath);
const workbook = XLSX.read(xlsxBuf, { type: 'buffer', cellFormula: true, cellText: true });
const ws = workbook.Sheets[workbook.SheetNames[0]];
const cellAddresses = Object.keys(ws);

console.log('\n=== DISPIMG FORMULAS IN SPREADSHEET ===');
let dispimgCount = 0;
for (const addr of cellAddresses) {
  if (addr.startsWith('!')) continue;
  const cell = ws[addr];
  if (!cell) continue;
  let formulaStr = '';
  if (cell.f && typeof cell.f === 'string') {
    formulaStr = cell.f;
  }
  if (formulaStr.toUpperCase().includes('DISPIMG')) {
    dispimgCount++;
    const match = formulaStr.match(/DISPIMG\s*\(\s*["']?([^"',)\s]+)/i);
    const uuid = match ? match[1] : '???';
    const uuidInMap = oleResult.uuidMap.has(uuid);
    console.log(`  ${addr}: ${formulaStr.substring(0, 80)}... → uuid="${uuid}" inMap=${uuidInMap}`);
  }
}
console.log(`\nTotal DISPIMG formulas found: ${dispimgCount}`);

// Check what columns exist
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
console.log('\n=== HEADERS ===');
if (data.length > 0) {
  data[0].forEach((h, i) => console.log(`  Col ${i}: "${h}"`));
}
console.log(`\nTotal data rows (including header): ${data.length}`);
console.log(`First 5 data rows:`);
for (let i = 1; i < Math.min(6, data.length); i++) {
  console.log(`  Row ${i}: ${JSON.stringify(data[i].slice(0, 6))}`);
}

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });
