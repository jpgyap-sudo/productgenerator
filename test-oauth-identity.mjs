#!/usr/bin/env node
/**
 * Check which Google account the OAuth2 tokens belong to.
 */
import 'dotenv/config';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const PARENT_ID = process.env.DRIVE_PARENT_FOLDER_ID;

console.log('DRIVE_PARENT_FOLDER_ID:', PARENT_ID);

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost:3000');
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Check who we are
console.log('\n--- Checking OAuth2 identity ---');
try {
  const about = await drive.about.get({ fields: 'user' });
  console.log('Authenticated as:', about.data.user.emailAddress);
  console.log('Display name:', about.data.user.displayName);
} catch (e) {
  console.error('Failed to get user info:', e.message);
}

// Check parent folder access
console.log('\n--- Checking parent folder access ---');
try {
  const f = await drive.files.get({
    fileId: PARENT_ID,
    fields: 'id,name,owners,permissions'
  });
  console.log('Parent folder:', f.data.name);
  console.log('Owners:', f.data.owners?.map(o => o.emailAddress).join(', '));
  console.log('Permissions:', f.data.permissions?.length, 'entries');
} catch (e) {
  console.error('Cannot access parent folder:', e.message);
}

// Create a test folder inside parent
console.log('\n--- Creating folder inside parent ---');
try {
  const f = await drive.files.create({
    requestBody: {
      name: 'OAuth2_Test_' + Date.now(),
      mimeType: 'application/vnd.google-apps.folder',
      parents: [PARENT_ID]
    },
    fields: 'id,name,parents,webViewLink'
  });
  console.log('Created:', f.data.name, '(' + f.data.id + ')');
  console.log('Parents:', f.data.parents);
  console.log('URL:', f.data.webViewLink);
} catch (e) {
  console.error('Failed:', e.message);
}
