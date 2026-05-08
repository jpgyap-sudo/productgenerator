#!/usr/bin/env node
/**
 * Quick test to check Drive access — uses the same auth as lib/drive.js
 */
import { google } from 'googleapis';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env'), override: true });

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const parentId = process.env.DRIVE_PARENT_FOLDER_ID;

if (!raw || !parentId) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON or DRIVE_PARENT_FOLDER_ID');
  process.exit(1);
}

const creds = JSON.parse(raw);
const pk = creds.private_key.replace(/\\n/g, '\n');
const auth = new google.auth.JWT(creds.client_email, null, pk, ['https://www.googleapis.com/auth/drive.file'], null);
const drive = google.drive({ version: 'v3', auth });

console.log('Parent folder ID:', parentId);
console.log('Service account:', creds.client_email);

// Test 1: List files in parent
console.log('\n--- Test 1: List files in parent folder ---');
try {
  const r = await drive.files.list({
    q: `'${parentId}' in parents and trashed=false`,
    fields: 'files(id, name)'
  });
  console.log('Files found:', r.data.files.length);
  for (const f of r.data.files) {
    console.log(`  - ${f.name} (${f.id})`);
  }
} catch (e) {
  console.error('List error:', e.message);
}

// Test 2: Create a sub-folder
console.log('\n--- Test 2: Create sub-folder ---');
let subId;
try {
  const f = await drive.files.create({
    requestBody: {
      name: 'Test_Access_' + Date.now(),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id,name'
  });
  subId = f.data.id;
  console.log('Created:', f.data.name, '(' + f.data.id + ')');
} catch (e) {
  console.error('Create folder error:', e.message);
  process.exit(1);
}

// Test 3: Upload a file
console.log('\n--- Test 3: Upload file ---');
try {
  const buf = Buffer.from('test content');
  const { Readable } = await import('node:stream');
  const readableStream = Readable.from(buf);
  
  const u = await drive.files.create({
    requestBody: { name: 'test-upload.txt', parents: [subId] },
    media: { mimeType: 'text/plain', body: readableStream },
    fields: 'id,name'
  });
  console.log('Uploaded:', u.data.name, '(' + u.data.id + ')');
  console.log('\n✅ SUCCESS!');
} catch (e) {
  console.error('Upload error:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors));
}
