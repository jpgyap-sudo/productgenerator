// Standalone script: Extract images from .et file in top-to-bottom sequence
// Generates an HTML gallery for visual verification
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractImagesFromETCellImageData } from './lib/et-ole-image-extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ET_FILE = process.argv[2] || './uploads/DINING_CHAIRS.et';
const OUTPUT_HTML = process.argv[3] || './image-sequence-report.html';

console.log(`Extracting images from: ${ET_FILE}`);

const buf = fs.readFileSync(ET_FILE);
const result = extractImagesFromETCellImageData(buf);

if (!result.success || result.imageCount === 0) {
  console.error('Failed to extract images:', result.error || 'no images');
  process.exit(1);
}

// Get position-sorted images (already filtered and sorted by yPos)
const images = result.sortedImagesByPosition || [];
console.log(`\nTotal images: ${result.imageCount}`);
console.log(`Position-sorted (after filtering): ${images.length}`);

// Generate HTML gallery
let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Image Sequence - Top to Bottom</title>
<style>
  body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
  h1 { text-align: center; }
  .summary { text-align: center; margin-bottom: 30px; padding: 15px; background: white; border-radius: 8px; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .card { background: white; border-radius: 8px; padding: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .card img { width: 100%; height: auto; border-radius: 4px; }
  .card .info { margin-top: 10px; font-size: 14px; color: #555; }
  .card .seq { font-size: 24px; font-weight: bold; color: #333; margin-bottom: 5px; }
  .card .ypos { font-size: 12px; color: #999; }
  .card .uuid { font-size: 10px; color: #bbb; word-break: break-all; }
</style>
</head>
<body>
<h1>📸 Image Sequence Gallery (Top → Bottom)</h1>
<div class="summary">
  <strong>File:</strong> ${path.basename(ET_FILE)}<br>
  <strong>Total Images:</strong> ${result.imageCount} | 
  <strong>Position-Sorted:</strong> ${images.length} | 
  <strong>UUID Mappings:</strong> ${result.uuidMap?.size || 0}
</div>
<div class="gallery">
`;

images.forEach((img, idx) => {
  const seq = idx + 1;
  html += `
  <div class="card">
    <div class="seq">#${seq}</div>
    <img src="${img.dataUrl}" alt="Image ${seq}">
    <div class="info">
      <strong>${img.name}</strong><br>
      Size: ${(img.size / 1024).toFixed(1)} KB<br>
      UUID: <span class="uuid">${img.uuid}</span>
    </div>
    <div class="ypos">yPos: ${img.yPos?.toLocaleString() || 'N/A'} EMU</div>
  </div>
  `;
});

html += `
</div>
</body>
</html>
`;

fs.writeFileSync(OUTPUT_HTML, html);
console.log(`\n✅ Gallery saved to: ${OUTPUT_HTML}`);
console.log(`Open in browser: file://${path.resolve(OUTPUT_HTML)}`);

// Also print a text summary
console.log('\n=== IMAGE SEQUENCE (Top to Bottom) ===');
images.forEach((img, idx) => {
  console.log(`  #${String(idx + 1).padStart(2)}: ${img.name.padEnd(20)} yPos=${String(img.yPos).padStart(10)} uuid=${img.uuid}`);
});
