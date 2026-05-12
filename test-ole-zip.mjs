import CFB from 'cfb';
import fs from 'fs';
import { unzipSync } from 'zlib';
import { Readable } from 'stream';

const buf = fs.readFileSync('DINING_CHAIRS_COPY.et');
const cfb = CFB.read(buf, {type: 'buffer'});
const entry = CFB.find(cfb, 'ETCellImageData');
const content = entry.content;

// The content starts with PK\x03\x04 - it's a ZIP file!
// Let's extract it using a simple ZIP parser since we have adm-zip or we can use the built-in
// Let's first check if we can find the end of central directory record

// Find the ZIP entries manually
// ZIP local file header: PK\x03\x04
const entries = [];
for (let i = 0; i < content.length - 30; i++) {
  if (content[i] === 0x50 && content[i+1] === 0x4B && content[i+2] === 0x03 && content[i+3] === 0x04) {
    // Local file header
    const compressionMethod = content.readUInt16LE(i + 8);
    const compressedSize = content.readUInt32LE(i + 18);
    const uncompressedSize = content.readUInt32LSB?.(i + 22) || content.readUInt32LE(i + 22);
    const fileNameLen = content.readUInt16LE(i + 26);
    const extraLen = content.readUInt16LE(i + 28);
    const fileName = content.slice(i + 30, i + 30 + fileNameLen).toString('utf8');
    const dataStart = i + 30 + fileNameLen + extraLen;
    
    entries.push({
      offset: i,
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      dataStart,
      dataEnd: dataStart + compressedSize
    });
    
    console.log(`ZIP entry: "${fileName}" (compressed: ${compressedSize}, uncompressed: ${uncompressedSize}, method: ${compressionMethod})`);
  }
}

console.log(`\nFound ${entries.length} ZIP entries`);

// Extract files
const outputDir = 'extracted-zip';
try { fs.mkdirSync(outputDir); } catch(e) {}

for (const entry of entries) {
  const rawData = content.slice(entry.dataStart, entry.dataEnd);
  
  if (entry.fileName.endsWith('.xml')) {
    // Store as-is (text)
    fs.writeFileSync(`${outputDir}/${entry.fileName.replace(/\//g, '_')}`, rawData);
    console.log(`Saved ${entry.fileName} (${rawData.length} bytes)`);
  } else if (entry.fileName.endsWith('.png') || entry.fileName.endsWith('.jpeg') || entry.fileName.endsWith('.jpg')) {
    // Store as-is (stored, not compressed - method 0)
    const imgName = entry.fileName.replace(/^xl\/media\//, '').replace(/\//g, '_');
    fs.writeFileSync(`${outputDir}/${imgName}`, rawData);
    console.log(`Saved ${entry.fileName} -> ${imgName} (${rawData.length} bytes)`);
  }
}

// Also look for the central directory
console.log('\n=== Looking for central directory ===');
for (let i = content.length - 100; i < content.length - 22; i++) {
  if (content[i] === 0x50 && content[i+1] === 0x4B && content[i+2] === 0x05 && content[i+3] === 0x06) {
    console.log(`End of central directory at offset ${i}`);
    const entriesCount = content.readUInt16LE(i + 8);
    const centralDirSize = content.readUInt32LE(i + 12);
    const centralDirOffset = content.readUInt32LE(i + 16);
    console.log(`Entries: ${entriesCount}, Central dir size: ${centralDirSize}, Offset: ${centralDirOffset}`);
    break;
  }
}
