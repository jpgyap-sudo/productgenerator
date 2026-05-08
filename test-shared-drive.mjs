#!/usr/bin/env node
import { google } from 'googleapis';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import stream from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env'), override: true });

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const parentId = process.env.DRIVE_PARENT_FOLDER_ID;

console.log('DRIVE_PARENT_FOLDER_ID:', parentId || 'NOT SET');

if (!raw || !parentId) {
  console.error('Missing env vars');
  process.exit(1);
}

const creds = JSON.parse(raw);
const pk = creds.private_key.replace(/\\n/g, '\n');
const auth = new google.auth.JWT(creds.client_email, null, pk, ['https://www.googleapis.com/auth/drive.file'], null);
const drive = google.drive({ version: 'v3', auth });

// Test 1: Verify we can access the parent folder
console.log('\n--- Test 1: Verify parent folder access ---');
try {
  const r = await drive.files.get({
    fileId: parentId,
    fields: 'id,name,owners'
  });
  console.log('Parent folder:', r.data.name, '(ID:', r.data.id, ')');
  console.log('Owned by:', r.data.owners?.[0]?.emailAddress || 'unknown');
} catch (e) {
  console.error('Cannot access parent folder:', e.message);
  console.error('Make sure you shared this folder with:', creds.client_email);
  process.exit(1);
}

// Test 2: Create a sub-folder inside the parent
console.log('\n--- Test 2: Create sub-folder in parent ---');
let subFolderId;
try {
  const f = await drive.files.create({
    requestBody: {
      name: 'Test_SubFolder_' + Date.now(),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id,name,webViewLink'
  });
  subFolderId = f.data.id;
  console.log('Created sub-folder:', f.data.name, '(ID:', f.data.id, ')');
  console.log('URL:', f.data.webViewLink);
} catch (e) {
  console.error('Failed to create sub-folder:', e.message);
  process.exit(1);
}

// Test 3: Upload a file to the sub-folder
console.log('\n--- Test 3: Upload file to sub-folder ---');
try {
  const buf = Buffer.from('test content for Drive upload verification');
  const readableStream = stream.Readable.from(buf);
  
  const u = await drive.files.create({
    requestBody: {
      name: 'test-upload.txt',
      parents: [subFolderId]
    },
    media: {
      mimeType: 'text/plain',
      body: readableStream
    },
    fields: 'id,name'
  });
  console.log('Uploaded file:', u.data.name, '(ID:', u.data.id, ')');
  console.log('\n✅ SUCCESS! Both folder creation and file upload work!');
  console.log('   The service account can create folders and upload files');
  console.log('   inside a folder shared by a real user.');
} catch (e) {
  console.error('Failed to upload file:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors));
  process.exit(1);
}
