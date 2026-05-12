import CFB from 'cfb';
import fs from 'fs';

const buf = fs.readFileSync('DINING_CHAIRS_COPY.et');
console.log('Buffer size:', buf.length);

try {
  const cfb = CFB.read(buf, {type: 'buffer'});
  console.log('FullPaths:', cfb.FullPaths.length);
  for (let i = 0; i < Math.min(cfb.FullPaths.length, 50); i++) {
    console.log('[' + i + ']', cfb.FullPaths[i], '(size:', cfb.FileIndex[i].size + ')');
  }
} catch(e) {
  console.log('Error:', e.message);
  console.log('Stack:', e.stack);
}
