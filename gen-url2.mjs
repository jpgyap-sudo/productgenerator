#!/usr/bin/env node
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET');
  process.exit(1);
}

// Try with http://localhost as redirect URI (matching the client config)
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'http://localhost');
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive.file'],
  prompt: 'consent'
});

console.log('CLIENT_ID:', CLIENT_ID);
console.log('CLIENT_SECRET:', CLIENT_SECRET.substring(0, 10) + '...');
console.log('Redirect URI: http://localhost');
console.log('');
console.log('Open this URL in your browser:');
console.log(authUrl);
console.log('');
console.log('After authorizing, you will be redirected to http://localhost with a ?code= parameter in the URL.');
console.log('Copy the ENTIRE redirected URL and paste it here.');
