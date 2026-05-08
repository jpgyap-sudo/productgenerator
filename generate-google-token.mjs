#!/usr/bin/env node
/**
 * Google Drive OAuth2 Token Generator
 * 
 * Run this ONCE to get a refresh token for your personal Google account.
 * 
 * Usage:
 *   set GOOGLE_OAUTH_CLIENT_ID=your_client_id
 *   set GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
 *   node generate-google-token.mjs
 * 
 * Then:
 *   1. Open the URL in your browser
 *   2. Authorize with your Google account
 *   3. Copy the FULL redirect URL from the address bar
 *   4. Paste it back here
 */

import { google } from 'googleapis';
import readline from 'readline';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Google Drive OAuth2 Token Generator                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('You already have the Client ID and Secret from Google Cloud Console.');
  console.log('');
  console.log('Run this script with:');
  console.log('');
  console.log('  set GOOGLE_OAUTH_CLIENT_ID=<your_client_id>');
  console.log('  set GOOGLE_OAUTH_CLIENT_SECRET=<your_client_secret>');
  console.log('  node generate-google-token.mjs');
  console.log('');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'  // Use out-of-band (copy/paste) flow
);

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent'  // Force to get refresh token
});

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  STEP 1: Open this URL in your browser:                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(authUrl);
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  STEP 2: Sign in with your Google account                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('  - Click "Continue" (may show warning → "Advanced" → "Go to...")');
console.log('  - Click "Allow" to grant Drive.file access');
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  STEP 3: Copy the code from the page                        ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('  You will see a page with a code box.');
console.log('  Copy that code and paste it below.');
console.log('');

// Read the code from stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const code = await new Promise(resolve => {
  rl.question('Paste the code here: ', answer => {
    resolve(answer.trim());
    rl.close();
  });
});

if (!code) {
  console.error('No code provided. Exiting.');
  process.exit(1);
}

console.log('\nExchanging code for tokens...');

try {
  const { tokens } = await oauth2Client.getToken(code);
  
  if (!tokens.refresh_token) {
    console.error('\n❌ No refresh_token returned!');
    console.error('This usually means you already authorized before and Google cached the consent.');
    console.error('Try:');
    console.error('  1. Go to https://myaccount.google.com/permissions');
    console.error('  2. Find "ProductGenerator Drive" and remove access');
    console.error('  3. Run this script again');
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ TOKENS GENERATED SUCCESSFULLY!                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Add these to your VPS .env file:');
  console.log('');
  console.log('────────────────────────────────────────────────────────');
  console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`);
  console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('────────────────────────────────────────────────────────');
  console.log('');
  console.log('Then SSH into VPS and run:');
  console.log('  cd /root/productgenerator');
  console.log('  echo "GOOGLE_DRIVE_CLIENT_ID=..." >> .env');
  console.log('  echo "GOOGLE_DRIVE_CLIENT_SECRET=..." >> .env');
  console.log('  echo "GOOGLE_DRIVE_REFRESH_TOKEN=..." >> .env');
  console.log('  pm2 restart product-image-studio --update-env');
  console.log('');

} catch (err) {
  console.error('\n❌ Error exchanging code:', err.message);
  process.exit(1);
}
