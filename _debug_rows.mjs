import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { execSync } from 'child_process';
import os from 'os';

const etPath = path.join(process.cwd(), 'uploads', 'DINING_CHAIRS.et');
const etBuffer = fs.readFileSync(etPath);
const tempDir = path.join(os.tmpdir(), 'et-debug-' + Date.now());
fs.mkdirSync(tempDir, { recursive: true });

// Convert .et to .xlsx
const etInputPath = path.join(tempDir, 'input.et');
fs.writeFileSync(etInputPath, etBuffer);
console.log('Converting .et to .xlsx...');
execSync('soffice --headless --convert-to xlsx --outdir ' + tempDir + ' ' + etInputPath, { timeout: 30000 });
const xlsxPath = path.join(tempDir, 'input.xlsx');
const xlsxBuffer = fs.readFileSync(xlsxPath);

// Read with SheetJS
const workbook = XLSX.read(xlsxBuffer, { type: 'buffer', cellDates: false, cellNF: false, cellText: true, cellFormula: true });
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false });

console.log('Total rows in spreadsheet:', data.length);
console.log('Header:', JSON.stringify(data[0]));

// Show all non-empty rows with their row numbers
console.log('');
console.log('=== All non-empty rows ===');
for (let i = 1; i < data.length; i++) {
  const row = data[i];
  if (!row) continue;
  if (row.every(c => c === '' || c === null || c === undefined)) continue;
  const code = (row[0] || '').toString().substring(0, 25);
  const desc = (row[2] || '').toString().substring(0, 80);
  console.log('Row ' + String(i+1).padStart(3) + ': code=' + code.padEnd(25) + ' | desc=' + desc);
}

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });
