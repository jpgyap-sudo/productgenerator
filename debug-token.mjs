#!/usr/bin/env node
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const CODE = process.argv[2];

console.log('CLIENT_ID:', CLIENT_ID ? CLIENT_ID.substring(0, 30) + '...' : '(not set)');
console.log('CLIENT_SECRET:', CLIENT_SECRET ? CLIENT_SECRET.substring(0, 10) + '...' : '(not set)');
console.log('CODE:', CODE ? CODE.substring(0, 20) + '...' : '(not set)');

if (!CLIENT_ID || !CLIENT_SECRET || !CODE) {
  console.error('Missing required params');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, 'urn:ietf:wg:oauth:2.0:oob');

try {
  const { tokens } = await oauth2Client.getToken(CODE);
  console.log('\n✅ SUCCESS!');
  console.log('access_token:', tokens.access_token ? tokens.access_token.substring(0, 20) + '...' : '(none)');
  console.log('refresh_token:', tokens.refresh_token || '(none - need to revoke first)');
  console.log('expiry_date:', tokens.expiry_date);
  
  if (tokens.refresh_token) {
    console.log('\n────────────────────────────────────────────────────────');
    console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('────────────────────────────────────────────────────────');
  }
} catch (err) {
  console.error('\n❌ Error:', err.message);
  if (err.response?.data) {
    console.error('Response data:', JSON.stringify(err.response.data, null, 2));
  }
}
