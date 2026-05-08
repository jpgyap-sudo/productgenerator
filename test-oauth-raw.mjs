#!/usr/bin/env node
/**
 * Test OAuth2 token exchange with raw HTTP and verbose logging.
 */
import readline from 'readline';

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3456';

async function main() {
  console.log('=== Generate auth URL ===\n');
  const params = new URLSearchParams({
    access_type: 'offline',
    scope: 'https://www.googleapis.com/auth/drive.file',
    prompt: 'consent',
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI
  });
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  console.log('Open this URL in your browser:');
  console.log(authUrl);
  console.log('\nAfter authorizing, you will be redirected to a URL like:');
  console.log('  http://localhost:3456?code=4/xxx...');
  console.log('Copy the ENTIRE redirected URL from the address bar.\n');
  
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = await new Promise(resolve => rl.question('Paste the redirected URL (or just the code): ', resolve));
  rl.close();
  
  const trimmed = input.trim();
  let code = trimmed;
  if (trimmed.includes('code=')) {
    const match = trimmed.match(/code=([^&]+)/);
    if (match) code = decodeURIComponent(match[1]);
  }
  
  console.log('\n=== Exchange code for tokens ===');
  console.log('Code:', code.substring(0, 30) + '...');
  
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI
  });
  
  try {
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
  } catch(e) {
    console.error('Fetch error:', e.message);
  }
}

main();
