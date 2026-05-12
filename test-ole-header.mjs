import CFB from 'cfb';
import fs from 'fs';

const buf = fs.readFileSync('DINING_CHAIRS_COPY.et');
const cfb = CFB.read(buf, {type: 'buffer'});
const entry = CFB.find(cfb, 'ETCellImageData');
const content = entry.content;

// The first image starts at offset 4444. Let's examine the header before it.
console.log('=== First 200 bytes of ETCellImageData ===');
for (let i = 0; i < 200; i++) {
  process.stdout.write(content[i].toString(16).padStart(2,'0') + ' ');
  if ((i+1) % 16 === 0) {
    // ASCII representation
    process.stdout.write(' |');
    for (let j = i-15; j <= i; j++) {
      const c = content[j];
      process.stdout.write(c >= 32 && c <= 126 ? String.fromCharCode(c) : '.');
    }
    process.stdout.write('|\n');
  }
}

// Let's also look at the data between image 0 and image 1
console.log('\n=== Data between image 0 (end ~297793) and image 1 (start 297793) ===');
// Check what's right before image 1
for (let i = 297780; i < 297800; i++) {
  process.stdout.write(content[i].toString(16).padStart(2,'0') + ' ');
  if ((i+1) % 16 === 0) process.stdout.write('\n');
}

// Let's look at the structure more carefully
// The ETCellImageData likely has a table of contents at the start
// with entries like: [row][col][image_offset][image_size]
console.log('\n\n=== Looking for structure patterns ===');

// Check bytes 0-4444 (before first image) for a TOC
console.log('Bytes 0-100:');
for (let i = 0; i < 100; i++) {
  process.stdout.write(content[i].toString(16).padStart(2,'0') + ' ');
  if ((i+1) % 16 === 0) process.stdout.write('\n');
}

// Check if there's a 4-byte count at the start
const count = content.readUInt32LE(0);
console.log('\nUInt32LE at offset 0:', count);
console.log('UInt32LE at offset 4:', content.readUInt32LE(4));
console.log('UInt32LE at offset 8:', content.readUInt32LE(8));
console.log('UInt32LE at offset 12:', content.readUInt32LE(12));
