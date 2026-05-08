#!/usr/bin/env node
/**
 * Exchange OAuth2 authorization code for tokens (non-interactive).
 * Usage: node exchange-code.mjs <code>
 */
const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3456';

const code = process.argv[2];
if (!code) {
  console.error('Usage: node exchange-code.mjs <authorization_code>');
  process.exit(1);
}

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code: code,
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  redirect_uri: REDIRECT_URI
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: body.toString()
});
const data = await res.json();
console.log('HTTP Status:', res.status);
console.log('Response:', JSON.stringify(data, null, 2));

if (data.refresh_token) {
  console.log('\n✅ SUCCESS!');
  console.log('\n────────────────────────────────────────────────────────');
  console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`);
  console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${data.refresh_token}`);
  console.log('────────────────────────────────────────────────────────\n');
} else if (data.access_token) {
  console.log('\n⚠️  Got access_token but NO refresh_token.');
  console.log('Need to revoke access and re-authorize with prompt=consent.');
}
