#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  test-drive.mjs — Test Google Drive API authentication & access
//
//  Usage:
//    node test-drive.mjs
//
//  Prerequisites:
//    - GOOGLE_SERVICE_ACCOUNT_JSON in .env or environment
// ═══════════════════════════════════════════════════════════════════

import { google } from 'googleapis';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env from project root
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Google Drive API — Authentication Test');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Step 1: Check env var ──
  console.log('\n[1/4] Checking GOOGLE_SERVICE_ACCOUNT_JSON...');
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawJson) {
    console.log('  ✗ NOT SET — GOOGLE_SERVICE_ACCOUNT_JSON environment variable is missing');
    console.log('  ℹ  Set it in .env or as a system environment variable');
    process.exit(1);
  }
  console.log('  ✓ Found (length: ' + rawJson.length + ' chars)');

  // ── Step 2: Parse JSON ──
  console.log('\n[2/4] Parsing service account JSON...');
  let credentials;
  try {
    credentials = JSON.parse(rawJson);
  } catch (e) {
    console.log('  ✗ Invalid JSON: ' + e.message);
    process.exit(1);
  }

  const checks = {
    'type': credentials.type === 'service_account',
    'project_id': !!credentials.project_id,
    'private_key_id': !!credentials.private_key_id,
    'private_key': !!credentials.private_key,
    'client_email': !!credentials.client_email,
    'client_id': !!credentials.client_id,
  };

  let allOk = true;
  for (const [key, ok] of Object.entries(checks)) {
    console.log(`  ${ok ? '✓' : '✗'} ${key}: ${ok ? credentials[key] : 'MISSING'}`);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.log('\n  ✗ Service account JSON is incomplete');
    process.exit(1);
  }

  // Check private key format
  const pk = credentials.private_key;
  console.log(`  ℹ  Private key length: ${pk.length} chars`);
  console.log(`  ℹ  Starts with correct header: ${pk.startsWith('-----BEGIN PRIVATE KEY-----')}`);
  console.log(`  ℹ  Has actual newlines: ${pk.includes('\n')}`);
  console.log(`  ℹ  Has escaped newlines (\\n): ${pk.includes('\\n')}`);

  // ── Step 3: Authenticate ──
  console.log('\n[3/4] Authenticating with Google Drive API...');
  const privateKey = pk.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    privateKey,
    SCOPES,
    null
  );

  try {
    const tokens = await auth.authorize();
    console.log(`  ✓ Authenticated successfully`);
    console.log(`  ℹ  Token type: ${tokens.token_type}`);
    console.log(`  ℹ  Expires in: ${tokens.expires_in} seconds`);
    console.log(`  ℹ  Access token (first 50 chars): ${tokens.access_token?.substring(0, 50)}...`);
  } catch (e) {
    console.log(`  ✗ Authentication failed: ${e.message}`);
    if (e.message.includes('invalid_grant')) {
      console.log('  ℹ  This usually means the service account key is expired or revoked.');
      console.log('  ℹ  Generate a new key at: https://console.cloud.google.com/apis/credentials');
    }
    if (e.message.includes('permission')) {
      console.log('  ℹ  The service account may not have Drive API enabled.');
      console.log('  ℹ  Enable it at: https://console.cloud.google.com/apis/library/drive.googleapis.com');
    }
    process.exit(1);
  }

  // ── Step 4: List files ──
  console.log('\n[4/4] Testing Drive API access (listing files)...');
  const drive = google.drive({ version: 'v3', auth });

  try {
    const res = await drive.files.list({
      pageSize: 10,
      fields: 'files(id, name, mimeType, createdTime)',
      orderBy: 'createdTime desc'
    });

    const files = res.data.files;
    if (files.length === 0) {
      console.log('  ✓ Connected to Drive API, but no files found.');
      console.log('  ℹ  Make sure the service account email has been granted access to a shared folder.');
      console.log(`  ℹ  Service account email: ${credentials.client_email}`);
      console.log('  ℹ  Share a Google Drive folder with this email (Editor permission).');
    } else {
      console.log(`  ✓ Found ${files.length} file(s)/folder(s):`);
      files.forEach((f, i) => {
        const icon = f.mimeType === 'application/vnd.google-apps.folder' ? '📁' : '📄';
        console.log(`     ${icon} ${f.name} (${f.mimeType})`);
      });
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ✅ Google Drive API is working correctly!');
    console.log('═══════════════════════════════════════════════════════════════');

  } catch (e) {
    console.log(`  ✗ Drive API call failed: ${e.message}`);
    if (e.message.includes('403')) {
      console.log('  ℹ  The service account may not have Drive API enabled.');
      console.log('  ℹ  Enable it at: https://console.cloud.google.com/apis/library/drive.googleapis.com');
    }
    if (e.message.includes('404')) {
      console.log('  ℹ  The Drive API may not be initialized for this project.');
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\nFatal error:', e.message);
  process.exit(1);
});
