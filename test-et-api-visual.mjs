// E2E Visual Test: Upload .et to API, save returned images in sequence order
// Uses only built-in Node.js modules (no external dependencies)
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

const API_URL = process.argv[2] || 'http://localhost:3002/api/agent/process';
const ET_FILE = process.argv[3] || './uploads/DINING_CHAIRS.et';
const OUT_DIR = process.argv[4] || '/tmp/et-visual-test';

console.log(`Testing: ${ET_FILE}`);
console.log(`API: ${API_URL}`);

// Build multipart form data manually
const fileBuffer = fs.readFileSync(ET_FILE);
const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

const preamble = Buffer.from(
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="pdf"; filename="test.et"\r\n` +
  `Content-Type: application/octet-stream\r\n\r\n`
);
const epilogue = Buffer.from(
  `\r\n--${boundary}\r\n` +
  `Content-Disposition: form-data; name="useBatchQueue"\r\n\r\n` +
  `false\r\n` +
  `--${boundary}--\r\n`
);

const body = Buffer.concat([preamble, fileBuffer, epilogue]);

console.log('\nUploading .et file...');
const res = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  body
});

const result = await res.json();

if (!result.success) {
  console.error('API Error:', result.error || result.warning || 'unknown');
  process.exit(1);
}

const products = result.products || [];
const images = result.allImages || [];

console.log(`\nProducts: ${products.length}`);
console.log(`Images: ${images.length}`);

// Create output directory
fs.mkdirSync(OUT_DIR, { recursive: true });

// Save images in sequence order (from products)
let savedCount = 0;
const rows = [];

for (let i = 0; i < products.length; i++) {
  const p = products[i];
  if (p.dataUrl) {
    savedCount++;
    const ext = p.imageName?.split('.').pop() || 'png';
    const filename = `${String(savedCount).padStart(3, '0')}_row${p.row}_${p.productCode || 'nocode'}.${ext}`;
    const filepath = path.join(OUT_DIR, filename);
    
    // Extract base64 data
    const base64 = p.dataUrl.split(',')[1];
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    
    rows.push({
      seq: savedCount,
      row: p.row,
      code: p.productCode || '',
      name: p.name || '',
      filename,
      dataUrl: p.dataUrl
    });
  }
}

console.log(`\nSaved ${savedCount} images to ${OUT_DIR}/`);

// Generate HTML report
let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>.et API Visual Test</title>
<style>
body{font-family:Arial,sans-serif;padding:20px;background:#f5f5f5}
h1{text-align:center}
.card{background:white;border-radius:8px;padding:15px;margin:15px 0;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
.card img{max-width:300px;max-height:300px;border-radius:4px}
.seq{font-size:28px;font-weight:bold;color:#333}
.meta{font-size:14px;color:#555;margin-top:5px}
</style></head><body>
<h1>.et API Visual Test — ${savedCount} products</h1>
<p style="text-align:center">API: ${API_URL}<br>File: ${path.basename(ET_FILE)}</p>
`;

rows.forEach(r => {
  html += `
<div class="card">
  <div class="seq">#${r.seq} — Row ${r.row}</div>
  <img src="${r.dataUrl}" alt="${r.code}">
  <div class="meta">
    <strong>Code:</strong> ${r.code || '(none)'}<br>
    <strong>Name:</strong> ${r.name || '(none)'}<br>
    <strong>File:</strong> ${r.filename}
  </div>
</div>
  `;
});

html += '</body></html>';

const reportPath = path.join(OUT_DIR, 'report.html');
fs.writeFileSync(reportPath, html);

console.log(`\n✅ Report saved: ${reportPath}`);
console.log(`Open: file://${path.resolve(reportPath)}`);

// Print summary
console.log('\n=== SEQUENCE SUMMARY ===');
rows.forEach(r => {
  console.log(`  #${String(r.seq).padStart(2)} Row ${String(r.row).padStart(2)}: ${r.code.padEnd(15)} ${r.name.substring(0,40)}`);
});
