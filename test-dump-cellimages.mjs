import fs from 'fs';
import CFB from 'cfb';

const etPath = 'C:\\Users\\User\\Downloads\\wps\\DINING CHAIRS.et';
const etBuffer = fs.readFileSync(etPath);

// Parse OLE2
const cfb = CFB.read(etBuffer, { type: 'buffer' });
const entry = CFB.find(cfb, 'ETCellImageData');
const rawContent = entry.content;

// Find ZIP entries manually
function findZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4B && 
        buffer[offset + 2] === 0x03 && buffer[offset + 3] === 0x04) {
      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const uncompressedSize = buffer.readUInt32LE(offset + 22);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);
      const fileName = buffer.toString('utf8', offset + 30, offset + 30 + fileNameLength);
      const dataOffset = offset + 30 + fileNameLength + extraFieldLength;
      entries.push({
        offset,
        fileName,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        dataOffset
      });
      offset = dataOffset + compressedSize;
    } else {
      offset++;
    }
  }
  return entries;
}

const entries = findZipEntries(rawContent);

// Find and extract cellImages.xml
const cellXmlEntry = entries.find(e => e.fileName === 'xl/cellImages.xml');
if (cellXmlEntry) {
  const compressedData = rawContent.slice(cellXmlEntry.dataOffset, cellXmlEntry.dataOffset + cellXmlEntry.compressedSize);
  
  let xmlContent;
  if (cellXmlEntry.compressionMethod === 0) {
    xmlContent = compressedData.toString('utf8');
  } else {
    const zlib = await import('zlib');
    xmlContent = zlib.inflateRawSync(compressedData).toString('utf8');
  }
  
  console.log('=== cellImages.xml ===');
  console.log(xmlContent.substring(0, 5000));
  console.log('...');
  console.log('(total length:', xmlContent.length, 'chars)');
  
  // Also save to file
  fs.writeFileSync('cellImages_dump.xml', xmlContent);
  console.log('\nFull XML saved to cellImages_dump.xml');
}

// Also dump the rels file
const relsEntry = entries.find(e => e.fileName === 'xl/_rels/cellImages.xml.rels');
if (relsEntry) {
  const compressedData = rawContent.slice(relsEntry.dataOffset, relsEntry.dataOffset + relsEntry.compressedSize);
  let relsContent;
  if (relsEntry.compressionMethod === 0) {
    relsContent = compressedData.toString('utf8');
  } else {
    const zlib = await import('zlib');
    relsContent = zlib.inflateRawSync(compressedData).toString('utf8');
  }
  console.log('\n=== cellImages.xml.rels ===');
  console.log(relsContent);
}
