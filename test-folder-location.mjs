#!/usr/bin/env node
import 'dotenv/config';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const PARENT_ID = process.env.DRIVE_PARENT_FOLDER_ID;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3000');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// List files in parent
console.log('=== Files inside parent folder (' + PARENT_ID + ') ===');
const r = await drive.files.list({
  q: `'${PARENT_ID}' in parents and trashed=false`,
  fields: 'files(id, name, webViewLink)'
});
console.log('Count:', r.data.files.length);
for (const f of r.data.files) {
  console.log(' -', f.name, '(' + f.id + ')', f.webViewLink || '');
}

// Recent folders
console.log('\n=== Recent 20 folders ===');
const r2 = await drive.files.list({
  pageSize: 20,
  q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
  fields: 'files(id, name, parents, webViewLink)',
  orderBy: 'createdTime desc'
});
for (const f of r2.data.files) {
  console.log(' -', f.name, '(' + f.id + ')', 'parent:', f.parents?.join(',') || 'ROOT');
  if (f.webViewLink) console.log('   ', f.webViewLink);
}

// Check the specific folder from the worker
console.log('\n=== Checking folder 008_chair_p01_02_xref16 ===');
try {
  const f3 = await drive.files.get({
    fileId: '1gCZss9n5lpBlNFMkDAIyMWOlv16jSNEn',
    fields: 'id,name,parents,webViewLink'
  });
  console.log('Name:', f3.data.name);
  console.log('Parent:', f3.data.parents?.join(',') || 'ROOT');
  console.log('URL:', f3.data.webViewLink);
} catch (e) {
  console.error('Error:', e.message);
}
