#!/usr/bin/env node
/**
 * OAuth2 token generator using a local HTTP server to catch the redirect.
 * 
 * Usage:
 *   set GOOGLE_OAUTH_CLIENT_ID=your_client_id
 *   set GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret
 *   node oauth-server.mjs
 * 
 * Then:
 *   1. Open the URL in your browser
 *   2. Authorize with your Google account
 *   3. You'll be redirected to localhost - the server catches it
 *   4. The refresh token is displayed
 */
import { google } from 'googleapis';
import http from 'http';
import url from 'url';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const PORT = 3456;
const REDIRECT_URI = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('Usage:');
  console.log('  set GOOGLE_OAUTH_CLIENT_ID=your_client_id');
  console.log('  set GOOGLE_OAUTH_CLIENT_SECRET=your_client_secret');
  console.log('  node oauth-server.mjs');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent'
});

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  STEP 1: Open this URL in your browser:                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(authUrl);
console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  STEP 2: Sign in and authorize                             ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('  The server is listening on http://localhost:3456');
console.log('  After authorizing, you will be redirected here.');
console.log('');

// Create a local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  
  if (parsed.query.code) {
    const code = parsed.query.code;
    
    console.log('✅ Authorization code received! Exchanging for tokens...\n');
    
    try {
      const { tokens } = await oauth2Client.getToken(code);
      
      if (!tokens.refresh_token) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body>
            <h2>❌ No refresh_token returned!</h2>
            <p>Go to <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a></p>
            <p>Remove "ProductGenerator Drive" access and try again.</p>
          </body></html>
        `);
        console.error('\n❌ No refresh_token returned!');
        console.error('Go to https://myaccount.google.com/permissions and remove access, then try again.');
        server.close();
        return;
      }
      
      console.log('╔══════════════════════════════════════════════════════════════╗');
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
      console.log('  nano .env  (add the 3 lines above)');
      console.log('  pm2 restart product-image-studio --update-env');
      console.log('');
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body>
          <h2>✅ Authorization successful!</h2>
          <p>You can close this window and return to the terminal.</p>
          <pre>
GOOGLE_DRIVE_CLIENT_ID=${CLIENT_ID}
GOOGLE_DRIVE_CLIENT_SECRET=${CLIENT_SECRET}
GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}
          </pre>
        </body></html>
      `);
      
    } catch (err) {
      console.error('\n❌ Error exchanging code:', err.message);
      if (err.response?.data) {
        console.error('Details:', JSON.stringify(err.response.data, null, 2));
      }
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>❌ Error: ${err.message}</h2></body></html>`);
    }
    
    server.close();
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body>
        <h2>Waiting for authorization...</h2>
        <p>Open the URL from the terminal to authorize.</p>
      </body></html>
    `);
  }
});

server.listen(PORT, () => {
  console.log(`  Server listening on http://localhost:${PORT}`);
  console.log('');
});
