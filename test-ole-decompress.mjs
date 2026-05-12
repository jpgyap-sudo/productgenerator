import CFB from 'cfb';
import fs from 'fs';
import zlib from 'zlib';

const buf = fs.readFileSync('DINING_CHAIRS_COPY.et');
const cfb = CFB.read(buf, {type: 'buffer'});
const entry = CFB.find(cfb, 'ETCellImageData');
const content = entry.content;

// Find the cellImages.xml entry in the embedded ZIP
// It starts at offset 30 (local file header) + 26 + 2 (filename len) + extra len
// From our earlier scan: "xl/cellImages.xml" compressed: 4270, uncompressed: 26250, method: 8

// Let's find it by scanning for the filename
const searchStr = 'xl/cellImages.xml';
const nameOffset = content.indexOf(searchStr);
if (nameOffset >= 0) {
  // Local file header starts 30 bytes before the filename
  const headerStart = nameOffset - 30;
  const fileNameLen = content.readUInt16LE(headerStart + 26);
  const extraLen = content.readUInt16LE(headerStart + 28);
  const compressedSize = content.readUInt32LE(headerStart + 18);
  const dataStart = headerStart + 30 + fileNameLen + extraLen;
  
  console.log('cellImages.xml found at header offset:', headerStart);
  console.log('Compressed size:', compressedSize);
  console.log('Data start:', dataStart);
  
  const compressedData = content.slice(dataStart, dataStart + compressedSize);
  const decompressed = zlib.inflateRawSync(compressedData);
  console.log('Decompressed size:', decompressed.length);
  console.log('\n=== cellImages.xml content ===');
  console.log(decompressed.toString('utf8').substring(0, 3000));
}

// Also decompress the rels file
const relsStr = 'xl/_rels/cellImages.xml.rels';
const relsOffset = content.indexOf(relsStr);
if (relsOffset >= 0) {
  const headerStart = relsOffset - 30;
  const fileNameLen = content.readUInt16LE(headerStart + 26);
  const extraLen = content.readUInt16LE(headerStart + 28);
  const compressedSize = content.readUInt32LE(headerStart + 18);
  const dataStart = headerStart + 30 + fileNameLen + extraLen;
  
  const compressedData = content.slice(dataStart, dataStart + compressedSize);
  const decompressed = zlib.inflateRawSync(compressedData);
  console.log('\n=== cellImages.xml.rels content ===');
  console.log(decompressed.toString('utf8').substring(0, 2000));
}
