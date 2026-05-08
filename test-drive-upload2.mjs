#!/usr/bin/env node
/**
 * Test Google Drive upload with real image content (fetched from a working URL).
 */
import 'dotenv/config';
import { google } from 'googleapis';
import stream from 'node:stream';

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const PARENT_ID = process.env.DRIVE_PARENT_FOLDER_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !PARENT_ID) {
  console.error('Missing OAuth2 env vars or DRIVE_PARENT_FOLDER_ID');
  process.exit(1);
}

console.log('Using OAuth2 with refresh token');
console.log('Parent folder ID:', PARENT_ID);

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3000');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Test 1: Create a sub-folder
console.log('\n--- Test 1: Create sub-folder ---');
let folderId;
try {
  const f = await drive.files.create({
    requestBody: {
      name: 'Upload_Test_' + Date.now(),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [PARENT_ID]
    },
    fields: 'id,name,webViewLink'
  });
  folderId = f.data.id;
  console.log('Created folder:', f.data.name, '(' + f.data.id + ')');
  console.log('URL:', f.data.webViewLink);
} catch (e) {
  console.error('Create folder error:', e.message);
  process.exit(1);
}

// Test 2: Upload a real image (fetch from picsum.photos)
console.log('\n--- Test 2: Upload image from URL ---');
try {
  const imageRes = await fetch('https://picsum.photos/512');
  if (!imageRes.ok) throw new Error('HTTP ' + imageRes.status);
  const arrayBuffer = await imageRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('Fetched image:', buffer.length, 'bytes');

  const readableStream = stream.Readable.from(buffer);
  const u = await drive.files.create({
    requestBody: { name: 'test-image.jpg', parents: [folderId] },
    media: { mimeType: 'image/jpeg', body: readableStream },
    fields: 'id,name,webViewLink'
  });
  console.log('Uploaded:', u.data.name, '(' + u.data.id + ')');
  console.log('View URL:', u.data.webViewLink);
} catch (e) {
  console.error('Upload error:', e.message);
  if (e.errors) console.error(JSON.stringify(e.errors));
  process.exit(1);
}

// Test 3: Upload a text file
console.log('\n--- Test 3: Upload text file ---');
try {
  const buf = Buffer.from('This is a test upload from Product Generator - ' + new Date().toISOString());
  const readableStream = stream.Readable.from(buf);
  const u = await drive.files.create({
    requestBody: { name: 'test-note.txt', parents: [folderId] },
    media: { mimeType: 'text/plain', body: readableStream },
    fields: 'id,name,webViewLink'
  });
  console.log('Uploaded:', u.data.name, '(' + u.data.id + ')');
  console.log('View URL:', u.data.webViewLink);
} catch (e) {
  console.error('Upload error:', e.message);
  process.exit(1);
}

console.log('\n✅ ALL TESTS PASSED! Google Drive upload is fully functional with OAuth2.');
console.log('   Folder URL: https://drive.google.com/drive/folders/' + folderId);
