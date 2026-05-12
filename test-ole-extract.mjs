import CFB from 'cfb';
import fs from 'fs';

const buf = fs.readFileSync('DINING_CHAIRS_COPY.et');
const cfb = CFB.read(buf, {type: 'buffer'});

// Find the ETCellImageData stream
const entry = CFB.find(cfb, 'ETCellImageData');
if (!entry) {
  console.log('ETCellImageData not found');
  process.exit(1);
}

console.log('ETCellImageData size:', entry.size);
console.log('Content type:', typeof entry.content);
console.log('Content is Buffer:', Buffer.isBuffer(entry.content));

// The content should be the raw bytes
const content = entry.content;
console.log('Content length:', content.length);

// Scan for JPEG/PNG signatures
let jpegCount = 0, pngCount = 0;
const imageOffsets = [];

for (let i = 0; i < content.length - 4; i++) {
  if (content[i] === 0xFF && content[i+1] === 0xD8 && content[i+2] === 0xFF) {
    jpegCount++;
    imageOffsets.push({ type: 'jpeg', offset: i });
  }
  if (content[i] === 0x89 && content[i+1] === 0x50 && content[i+2] === 0x4E && content[i+3] === 0x47) {
    pngCount++;
    imageOffsets.push({ type: 'png', offset: i });
  }
}

console.log('JPEG headers:', jpegCount);
console.log('PNG headers:', pngCount);
console.log('Total images:', imageOffsets.length);

// Show first 60 offsets
imageOffsets.slice(0, 60).forEach((img, idx) => {
  console.log(`  [${idx}] ${img.type} @ offset ${img.offset}`);
});

// Extract all images
const outputDir = 'extracted-images';
try { fs.mkdirSync(outputDir); } catch(e) {}

for (let i = 0; i < imageOffsets.length; i++) {
  const start = imageOffsets[i].offset;
  const end = (i + 1 < imageOffsets.length) ? imageOffsets[i+1].offset : content.length;
  const imgBuf = content.slice(start, end);
  const ext = imageOffsets[i].type;
  fs.writeFileSync(`${outputDir}/image_${i}.${ext}`, imgBuf);
  console.log(`  Saved image_${i}.${ext} (${imgBuf.length} bytes)`);
}
