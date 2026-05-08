#!/usr/bin/env node
/**
 * Exchange authorization code for tokens using direct fetch (no googleapis library).
 */
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const CODE = process.argv[2];

if (!CLIENT_ID || !CLIENT_SECRET || !CODE) {
  console.error('Usage: set GOOGLE_OAUTH_CLIENT_ID=... && set GOOGLE_OAUTH_CLIENT_SECRET=... && node exchange-direct.mjs <code>');
  process.exit(1);
}

async function main() {
  console.log('Exchanging code for tokens...');
  console.log('Client ID:', CLIENT_ID.substring(0, 30) + '...');
  console.log('Client Secret:', CLIENT_SECRET.substring(0, 10) + '...');
  console.log('Code:', CODE.substring(0, 20) + '...');
  console.log('');

  const params = new URLSearchParams({
    code: CODE,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    grant_type: 'authorization_code'
  });

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json();
    
    if (!res.ok) {
      console.error('HTTP Status:', res.status);
      console.error('Error:', JSON.stringify(data, null, 2));
      
      // Try with http://localhost redirect URI
      if (data.error === 'invalid_client' || data.error === 'redirect_uri_mismatch') {
        console.log('\n--- Retrying with redirect_uri=http://localhost ---');
        const params2 = new URLSearchParams({
          code: CODE,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: 'http://localhost',
          grant_type: 'authorization_code'
        });
        const res2 = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params2.toString()
        });
        const data2 = await res2.json();
        console.log('HTTP Status:', res2.status);
        console.log('Response:', JSON.stringify(data2, null, 2));
        
        if (data2.refresh_token) {
          console.log('\n✅ SUCCESS with http://localhost!\n');
          console.log('────────────────────────────────────────────────────────');
          console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`);
          console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
          console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${data2.refresh_token}`);
          console.log('────────────────────────────────────────────────────────');
        }
      }
      process.exit(1);
    }

    console.log('✅ SUCCESS!');
    console.log('Response:', JSON.stringify(data, null, 2));
    
    if (data.refresh_token) {
      console.log('\n────────────────────────────────────────────────────────');
      console.log(`GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}`);
      console.log(`GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
      console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${data.refresh_token}`);
      console.log('────────────────────────────────────────────────────────');
    } else {
      console.log('\n⚠️  No refresh_token! Need to revoke access first.');
    }
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

main();
