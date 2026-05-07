#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  fix-drive-env.mjs — Fix GOOGLE_SERVICE_ACCOUNT_JSON in .env
//
//  The .env file stores the service account JSON as a single quoted
//  string. The private_key contains \n escape sequences that must be
//  preserved as literal backslash-n (two chars) in the .env file.
//
//  Usage:
//    node fix-drive-env.mjs < path-to-json-file
//    # or pipe the JSON directly
//    cat annular-magnet-*.json | node fix-drive-env.mjs
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import { config } from 'dotenv';

const ENV_PATH = '.env';

async function main() {
  // Read JSON from stdin or argument
  let jsonStr = '';
  if (process.argv[2]) {
    jsonStr = fs.readFileSync(process.argv[2], 'utf8');
  } else {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    jsonStr = Buffer.concat(chunks).toString('utf8');
  }

  // Parse to validate
  let creds;
  try {
    creds = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Invalid JSON:', e.message);
    process.exit(1);
  }

  console.log('Parsed service account JSON:');
  console.log('  client_email:', creds.client_email);
  console.log('  project_id:', creds.project_id);
  console.log('  private_key length:', creds.private_key?.length);
  console.log('  private_key has actual newlines:', creds.private_key?.includes('\n'));

  // The private_key in the JSON has actual newlines.
  // For .env file, we need to store the entire JSON as a single line
  // with the private_key's newlines escaped as \n (literal backslash-n).
  // 
  // JSON.stringify will produce a valid JSON string with \n escapes.
  // But we need to put that into .env as a quoted value.
  // 
  // The safest approach: store the JSON as a single line in .env
  // by using JSON.stringify on the parsed object, which will properly
  // escape the private key's newlines as \n.

  const singleLineJson = JSON.stringify(creds);
  console.log('\nSingle-line JSON length:', singleLineJson.length);

  // Read current .env
  let envContent = '';
  try {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    console.error('No .env file found');
    process.exit(1);
  }

  // Replace the GOOGLE_SERVICE_ACCOUNT_JSON line
  const regex = /^GOOGLE_SERVICE_ACCOUNT_JSON=.*$/m;
  const newLine = `GOOGLE_SERVICE_ACCOUNT_JSON='${singleLineJson}'`;

  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, newLine);
  } else {
    envContent += '\n' + newLine;
  }

  fs.writeFileSync(ENV_PATH, envContent, 'utf8');
  console.log('\nUpdated .env file');

  // Verify it works
  console.log('\nVerifying...');
  // Clear the require cache for dotenv
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  config({ override: true });

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  console.log('  Env var length:', raw?.length);
  
  try {
    const parsed = JSON.parse(raw);
    console.log('  Parse: OK');
    console.log('  client_email:', parsed.client_email);
    console.log('  private_key has actual newlines:', parsed.private_key?.includes('\n'));
    console.log('  private_key starts correctly:', parsed.private_key?.startsWith('-----BEGIN PRIVATE KEY-----'));
  } catch (e) {
    console.error('  Parse FAILED:', e.message);
    process.exit(1);
  }

  console.log('\n✅ GOOGLE_SERVICE_ACCOUNT_JSON is now properly formatted!');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
