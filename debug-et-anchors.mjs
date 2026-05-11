// Debug script to inspect exceljs image anchors (fixed)
import ExcelJS from 'exceljs';
import fs from 'fs';
import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

const etPath = process.argv[2] || 'uploads/DINING_CHAIRS.et';
const etBuffer = fs.readFileSync(etPath);

const tmpDir = path.join(os.tmpdir(), 'et-debug2');
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

const worksheet = workbook.getWorksheet(1);

if (worksheet) {
  const drawingImages = worksheet.getImages();
  console.log('=== DRAWING IMAGES (simplified) ===');
  drawingImages.forEach((img, i) => {
    const tl = img.range?.tl;
    const br = img.range?.br;
    console.log(`  Image #${i}:`);
    console.log(`    imageId: ${img.imageId}`);
    console.log(`    type: ${img.type}`);
    console.log(`    tl:`, tl ? { row: tl.row, col: tl.col } : 'N/A');
    console.log(`    br:`, br ? { row: br.row, col: br.col } : 'N/A');
    if (tl) {
      const roundedRow = Math.round(tl.row);
      console.log(`    rounded row: ${roundedRow}`);
    }
  });
}

// Also check what rows have actual data (non-empty)
console.log('\n=== ROWS WITH DATA (first 30) ===');
for (let r = 1; r <= Math.min(30, worksheet.rowCount); r++) {
  const row = worksheet.getRow(r);
  let hasData = false;
  const vals = [];
  for (let c = 1; c <= 5; c++) {
    const v = row.getCell(c).value;
    vals.push(v);
    if (v !== null && v !== undefined && v !== '') hasData = true;
  }
  if (hasData) {
    console.log(`  Row ${r}:`, JSON.stringify(vals));
  }
}
