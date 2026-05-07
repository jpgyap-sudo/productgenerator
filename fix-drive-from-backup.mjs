#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  fix-drive-from-backup.mjs — Fix GOOGLE_SERVICE_ACCOUNT_JSON in .env
//  using the real credentials from vps-env.txt backup
//
//  Usage: node fix-drive-from-backup.mjs
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import { config } from 'dotenv';

const ENV_PATH = '.env';
const BACKUP_PATH = 'vps-env.txt';

async function main() {
  // Read vps-env.txt
  let backupContent = '';
  try {
    backupContent = fs.readFileSync(BACKUP_PATH, 'utf8');
  } catch {
    console.error('No vps-env.txt backup found');
    process.exit(1);
  }

  // Extract the GOOGLE_SERVICE_ACCOUNT_JSON value
  // Format: GOOGLE_SERVICE_ACCOUNT_JSON="{\"type\": ...}"
  // The outer quotes are shell quotes, inside is JSON with escaped quotes
  const startMarker = 'GOOGLE_SERVICE_ACCOUNT_JSON=';
  const startIdx = backupContent.indexOf(startMarker);
  if (startIdx === -1) {
    console.error('Could not find GOOGLE_SERVICE_ACCOUNT_JSON in vps-env.txt');
    process.exit(1);
  }

  const valueStart = startIdx + startMarker.length;
  
  // The value starts with a double quote
  if (backupContent[valueStart] !== '"') {
    console.error('Expected value to start with "');
    process.exit(1);
  }

  // Extract everything between the outer quotes
  // We need to handle escaped quotes \" and actual newlines
  let rawValue = '';
  let i = valueStart + 1; // skip opening quote
  let depth = 0; // track brace depth for nested JSON
  
  while (i < backupContent.length) {
    const ch = backupContent[i];
    const nextCh = backupContent[i + 1] || '';
    
    // Check for escaped quote \"
    if (ch === '\\' && nextCh === '"') {
      rawValue += '"'; // unescape: \" → "
      i += 2;
      continue;
    }
    
    // Check for escaped backslash \\
    if (ch === '\\' && nextCh === '\\') {
      rawValue += '\\\\';
      i += 2;
      continue;
    }
    
    // Check for escaped n \n (should stay as literal \n in JSON)
    if (ch === '\\' && nextCh === 'n') {
      rawValue += '\\n';
      i += 2;
      continue;
    }
    
    // Track brace depth
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    
    // Closing quote at depth 0 means end of JSON value
    if (ch === '"' && depth === 0) {
      break;
    }
    
    // Actual newline in the file - keep it as is (it's part of private_key)
    if (ch === '\n' || ch === '\r') {
      rawValue += ch;
      i++;
      continue;
    }
    
    rawValue += ch;
    i++;
  }

  console.log('Extracted raw JSON length:', rawValue.length);
  console.log('First 100 chars:', rawValue.substring(0, 100));
  console.log('Last 100 chars:', rawValue.substring(rawValue.length - 100));

  // Parse the raw value as JSON
  let creds;
  try {
    creds = JSON.parse(rawValue);
  } catch (e) {
    console.error('Direct parse failed:', e.message);
    
    // Try replacing actual newlines with \n
    const cleaned = rawValue.replace(/\r?\n/g, '\\n');
    try {
      creds = JSON.parse(cleaned);
      console.log('  Parsed after replacing newlines with \\n');
    } catch (e2) {
      console.error('Still invalid after newline fix:', e2.message);
      console.error('Sample around position 1:', JSON.stringify(rawValue.substring(0, 200)));
      process.exit(1);
    }
  }

  console.log('\nParsed service account JSON from backup:');
  console.log('  client_email:', creds.client_email);
  console.log('  project_id:', creds.project_id);
  console.log('  private_key_id:', creds.private_key_id);
  console.log('  private_key length:', creds.private_key?.length);
  console.log('  private_key has actual newlines:', creds.private_key?.includes('\n'));

  // Now JSON.stringify to properly escape newlines as \n
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
    console.log('  private_key ends correctly:', parsed.private_key?.trim().endsWith('-----END PRIVATE KEY-----'));
  } catch (e) {
    console.error('  Parse FAILED:', e.message);
    process.exit(1);
  }

  console.log('\n✅ GOOGLE_SERVICE_ACCOUNT_JSON is now properly formatted with REAL credentials!');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
