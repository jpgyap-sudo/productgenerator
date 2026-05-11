// Debug script to inspect exceljs media and DISPIMG relationships
import ExcelJS from 'exceljs';
import fs from 'fs';
import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

const etPath = process.argv[2] || 'uploads/DINING_CHAIRS.et';
const etBuffer = fs.readFileSync(etPath);
const tmpDir = path.join(os.tmpdir(), 'et-debug3');
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

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(xlsxBuf);

console.log('=== WORKBOOK MEDIA ===');
workbook.media.forEach((m, i) => {
  console.log(`Media #${i}:`, JSON.stringify({
    name: m.name,
    index: m.index,
    type: m.type,
    extension: m.extension,
    size: m.buffer ? m.buffer.length : 0
  }));
});

const worksheet = workbook.getWorksheet(1);
if (worksheet) {
  const drawings = worksheet.getImages();
  console.log('\n=== DRAWING IMAGES ===');
  drawings.forEach((d, i) => {
    console.log(`Drawing #${i}:`, JSON.stringify({
      imageId: d.imageId,
      type: d.type,
      tl: d.range?.tl ? { row: d.range.tl.row, col: d.range.tl.col } : null
    }));
  });

  // Check cells that have DISPIMG formulas
  console.log('\n=== CELLS WITH DISPIMG (first 5) ===');
  let count = 0;
  for (let r = 1; r <= worksheet.rowCount && count < 5; r++) {
    const row = worksheet.getRow(r);
    for (let c = 1; c <= 10; c++) {
      const cell = row.getCell(c);
      if (cell.formula && typeof cell.formula === 'string' && cell.formula.toUpperCase().includes('DISPIMG')) {
        console.log(`Cell ${cell.address}: formula=${cell.formula}, text=${cell.text?.substring(0, 100)}`);
        count++;
      }
    }
  }

  // Check what's in column B for rows 11, 19, 27, 35 (DISPIMG rows)
  console.log('\n=== DISPIMG ROWS (B column) ===');
  for (const r of [11, 19, 27, 35, 43, 51, 59]) {
    const cell = worksheet.getCell(`B${r}`);
    console.log(`B${r}: value=${JSON.stringify(cell.value)?.substring(0, 200)}, formula=${cell.formula}, text=${cell.text?.substring(0, 100)}`);
  }

  // Check what's in column A for rows 11, 19, 27, 35 (product codes)
  console.log('\n=== PRODUCT CODE ROWS (A column) ===');
  for (const r of [11, 19, 27, 35, 43, 51, 59]) {
    const cell = worksheet.getCell(`A${r}`);
    console.log(`A${r}: value=${JSON.stringify(cell.value)?.substring(0, 200)}, text=${cell.text?.substring(0, 100)}`);
  }

  // Check what's around the image anchor rows
  console.log('\n=== IMAGE ANCHOR ROWS ===');
  for (const r of [3, 4, 339, 340, 347, 348, 355, 356]) {
    const row = worksheet.getRow(r);
    const vals = [];
    for (let c = 1; c <= 5; c++) {
      const cell = row.getCell(c);
      vals.push({ addr: cell.address, text: cell.text?.substring(0, 80), formula: cell.formula?.substring(0, 80) });
    }
    console.log(`Row ${r}:`, JSON.stringify(vals));
  }
}
