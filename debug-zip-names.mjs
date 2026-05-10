import AdmZip from 'adm-zip';
import fs from 'fs';

try {
  const buf = fs.readFileSync('C:/Users/User/Downloads/test scri0pt/chair.zip');
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  console.log('Total entries:', entries.length);
  for (const e of entries) {
    if (!e.isDirectory) {
      console.log('FILE:', e.entryName);
    } else {
      console.log('DIR:', e.entryName);
    }
  }
} catch(e) {
  console.error('ERROR:', e.message);
}
