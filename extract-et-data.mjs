// Script: Convert .et file to .xlsx and CSV
// Usage: node extract-et-data.mjs <input.et> [output.csv]
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import XLSX from 'xlsx';

const etFile = process.argv[2] || './uploads/DINING_CHAIRS.et';
const outCsv = process.argv[3] || etFile.replace(/\.et$/i, '.csv');
// Write xlsx to same directory as csv (usually /tmp/ which is writable)
const outXlsx = outCsv.replace(/\.csv$/i, '.xlsx');

if (!fs.existsSync(etFile)) {
  console.error(`File not found: ${etFile}`);
  process.exit(1);
}

console.log(`Converting: ${etFile}`);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'et-convert-'));
const etPath = path.join(tempDir, 'input.et');
fs.writeFileSync(etPath, fs.readFileSync(etFile));

// Convert .et → .xlsx using LibreOffice
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

const xlsxPath = path.join(tempDir, 'input.xlsx');
if (!fs.existsSync(xlsxPath)) {
  console.error('LibreOffice failed to produce .xlsx output');
  process.exit(1);
}

// Copy .xlsx to output
fs.copyFileSync(xlsxPath, outXlsx);
console.log(`✅ XLSX saved: ${outXlsx}`);

// Read with SheetJS and export CSV
const buf = fs.readFileSync(xlsxPath);
const workbook = XLSX.read(buf, { type: 'buffer', cellFormula: false, cellText: true });
const ws = workbook.Sheets[workbook.SheetNames[0]];

// Convert to CSV
const csv = XLSX.utils.sheet_to_csv(ws);
fs.writeFileSync(outCsv, csv);
console.log(`✅ CSV saved: ${outCsv}`);

// Print preview
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
console.log(`\n=== Preview (first 10 rows) ===`);
for (let i = 0; i < Math.min(10, data.length); i++) {
  console.log(`  Row ${i + 1}: ${data[i].slice(0, 5).map(c => `"${c}"`).join(', ')}`);
}

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });
console.log('\nDone! You can now:');
console.log(`  1. Open ${outXlsx} in Excel/Google Sheets to edit`);
console.log(`  2. Open ${outCsv} in any text editor/spreadsheet`);
console.log(`  3. The data rows are in the same order as the extracted images`);
