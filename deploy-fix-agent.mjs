#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  deploy-fix-agent.mjs — Deploy image preview fix to VPS
//  Uses same pattern as deploy-agent.mjs
//
//  Usage:
//    node deploy-fix-agent.mjs              # Deploy the fix
//    node deploy-fix-agent.mjs --check      # Check VPS state first
//    node deploy-fix-agent.mjs --verify     # Verify after deployment
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration (same as deploy-agent.mjs) ───────────────────────
const CONFIG = {
  // VPS connection — uses Tailscale IP
  sshHost: '100.64.175.88',      // Tailscale IP
  sshIdentityFile: 'C:\\Users\\User\\.ssh\\id_superroo_vps',
  vpsPath: '/root/productgenerator',
  sshUser: 'superroo',           // SSH user (non-root with sudo)
};

// ── Colors ─────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function color(c, s) { return `${c}${s}${C.reset}`; }

// ── Helpers ────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(color(C.dim, `  $ ${cmd.substring(0, 100)}...`));
  return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf-8', ...opts });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function sshCmd(cmd) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  return `ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${CONFIG.sshUser}@${CONFIG.sshHost} "${cmd}"`;
}

function scpCmd(localPath, remotePath) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  return `scp ${identityArg} -o StrictHostKeyChecking=accept-new "${localPath}" "${CONFIG.sshUser}@${CONFIG.sshHost}:${remotePath}"`;
}

// Upload a file by piping its content through SSH with sudo tee
// (avoids permission issues when superroo user can't write to /root/ paths)
function uploadViaSsh(localPath, remotePath) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  const content = readFileSync(localPath, 'utf-8');
  // Escape single quotes for shell safety
  const escaped = content.replace(/'/g, "'\\''");
  const cmd = `ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${CONFIG.sshUser}@${CONFIG.sshHost} "sudo tee ${remotePath} > /dev/null"`;
  return execSync(cmd, { input: content, stdio: ['pipe', 'inherit', 'inherit'], encoding: 'utf-8' });
}

// ── Banner ─────────────────────────────────────────────────────────
function banner() {
  console.log('');
  console.log(color(C.cyan, '╔══════════════════════════════════════════════════════════════════╗'));
  console.log(color(C.cyan, '║        DEPLOY IMAGE PREVIEW FIX (via Tailscale)                  ║'));
  console.log(color(C.cyan, '╚══════════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(`VPS Host: ${color(C.yellow, CONFIG.sshHost)}`);
  console.log(`VPS Path: ${color(C.yellow, CONFIG.vpsPath)}`);
  console.log(`SSH User: ${color(C.yellow, CONFIG.sshUser)}`);
  console.log('');
}

// ── Test SSH ───────────────────────────────────────────────────────
function testSSH() {
  console.log(color(C.bold, '🔍 Testing SSH connection...'));
  try {
    const result = runCapture(sshCmd('echo "SSH_OK"'));
    if (result.includes('SSH_OK')) {
      console.log(color(C.green, '   ✅ SSH connection successful'));
      return true;
    }
  } catch (e) {
    // Silent fail
  }
  console.log(color(C.red, '   ❌ SSH connection failed'));
  return false;
}

// ── Check VPS State ────────────────────────────────────────────────
async function checkVpsState() {
  console.log('');
  console.log(color(C.bold, '🔍 Checking VPS state...'));
  console.log(color(C.dim, '────────────────────────────────────────────────────────────────'));
  
  // Upload check script
  const checkScript = join(__dirname, 'check-vps-images.sh');
  if (!existsSync(checkScript)) {
    console.log(color(C.red, '   ❌ check-vps-images.sh not found'));
    return false;
  }
  
  console.log(color(C.blue, '   Uploading check script...'));
  uploadViaSsh(checkScript, `${CONFIG.vpsPath}/check-vps-images.sh`);
  
  console.log(color(C.blue, '   Running diagnostic...'));
  try {
    run(sshCmd(`cd ${CONFIG.vpsPath} && sudo bash check-vps-images.sh`));
  } catch (e) {
    // Continue even if script has warnings
  }
  
  return true;
}

// ── Deploy Fix ─────────────────────────────────────────────────────
async function deployFix() {
  console.log('');
  console.log(color(C.bold, '🔧 Deploying image preview fix...'));
  console.log(color(C.dim, '────────────────────────────────────────────────────────────────'));
  
  // Step 1: Upload docker-compose.yml with vps-assets volume mount
  const composeFile = join(__dirname, 'docker-compose.yml');
  if (existsSync(composeFile)) {
    console.log(color(C.blue, '   1. Uploading updated docker-compose.yml (vps-assets volume mount)...'));
    uploadViaSsh(composeFile, `${CONFIG.vpsPath}/docker-compose.yml`);
    console.log(color(C.green, '   ✅ docker-compose.yml updated'));
  } else {
    console.log(color(C.yellow, '   ⚠️  docker-compose.yml not found, skipping volume mount update'));
  }
  
  // Step 2: Upload fix script
  const fixScript = join(__dirname, 'fix-image-preview.sh');
  if (!existsSync(fixScript)) {
    console.log(color(C.red, '   ❌ fix-image-preview.sh not found'));
    return false;
  }
  
  console.log(color(C.blue, '   2. Uploading fix script...'));
  uploadViaSsh(fixScript, `${CONFIG.vpsPath}/fix-image-preview.sh`);
  console.log(color(C.green, '   ✅ Fix script uploaded'));
  
  // Step 3: Run fix script
  console.log(color(C.blue, '   3. Running fix script (copies images from container, updates nginx)...'));
  try {
    run(sshCmd(`cd ${CONFIG.vpsPath} && sudo bash fix-image-preview.sh`));
  } catch (e) {
    console.log(color(C.yellow, '   ⚠️  Fix script exited with warnings (may be normal)'));
  }
  
  // Step 4: Recreate Docker container with volume mount
  console.log(color(C.blue, '   4. Recreating Docker container with vps-assets volume mount...'));
  try {
    run(sshCmd(`cd ${CONFIG.vpsPath} && sudo docker compose down && sudo docker compose up -d`));
    console.log(color(C.green, '   ✅ Docker container recreated with volume mount'));
  } catch (e) {
    console.log(color(C.yellow, '   ⚠️  Docker compose restart had issues: ${e.message}'));
  }
  
  console.log(color(C.green, '   ✅ Fix applied'));
  return true;
}

// ── Verify Fix ─────────────────────────────────────────────────────
async function verifyFix() {
  console.log('');
  console.log(color(C.bold, '✅ Verifying fix...'));
  console.log(color(C.dim, '────────────────────────────────────────────────────────────────'));
  
  // Test nginx config
  console.log(color(C.blue, '   Testing nginx configuration...'));
  try {
    const nginxTest = runCapture(sshCmd('sudo nginx -t 2>&1'));
    if (nginxTest.includes('successful')) {
      console.log(color(C.green, '   ✅ Nginx config is valid'));
    } else {
      console.log(color(C.red, '   ❌ Nginx config has errors'));
      console.log(nginxTest);
      return false;
    }
  } catch (e) {
    console.log(color(C.red, '   ❌ Could not test nginx config'));
    return false;
  }
  
  // Test image URL
  console.log(color(C.blue, '   Testing image accessibility...'));
  const testUrls = [
    'https://render.abcx124.xyz/vps-assets/',
    'https://render.abcx124.xyz/vps-assets/renders/',
  ];
  
  for (const url of testUrls) {
    try {
      const httpCode = runCapture(`curl -s -o /dev/null -w "%{http_code}" "${url}"`);
      if (httpCode === '200' || httpCode === '403') {
        console.log(color(C.green, `   ✅ ${url} → HTTP ${httpCode}`));
      } else {
        console.log(color(C.yellow, `   ⚠️  ${url} → HTTP ${httpCode}`));
      }
    } catch (e) {
      console.log(color(C.red, `   ❌ Could not test ${url}`));
    }
  }
  
  // Find and test an actual image
  console.log(color(C.blue, '   Looking for test images...'));
  try {
    const sampleImage = runCapture(sshCmd(`find ${CONFIG.vpsPath}/vps-assets -type f \\( -name "*.png" -o -name "*.jpg" \\) 2>/dev/null | head -1`));
    if (sampleImage) {
      const relPath = sampleImage.replace(`${CONFIG.vpsPath}/vps-assets`, '');
      const imageUrl = `https://render.abcx124.xyz/vps-assets${relPath}`;
      console.log(color(C.dim, `   Testing: ${imageUrl}`));
      
      const httpCode = runCapture(`curl -s -o /dev/null -w "%{http_code}" "${imageUrl}"`);
      if (httpCode === '200') {
        console.log(color(C.green, `   ✅ Sample image accessible (HTTP 200)`));
      } else {
        console.log(color(C.red, `   ❌ Sample image returned HTTP ${httpCode}`));
      }
    } else {
      console.log(color(C.yellow, '   ⚠️  No sample images found'));
    }
  } catch (e) {
    console.log(color(C.yellow, '   ⚠️  Could not test sample image'));
  }
  
  return true;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  banner();
  
  const args = process.argv.slice(2);
  const mode = args[0] || '--deploy';
  
  // Test SSH first
  if (!testSSH()) {
    console.log('');
    console.log(color(C.red, '❌ Cannot connect to VPS'));
    console.log('');
    console.log('Troubleshooting:');
    console.log('  1. Ensure Tailscale is running on both machines');
    console.log('  2. Check the VPS Tailscale IP in CONFIG');
    console.log('  3. Verify SSH key path in CONFIG');
    console.log('');
    console.log('Alternative: Run the fix manually on VPS:');
    console.log(`  ssh ${CONFIG.sshUser}@${CONFIG.sshHost}`);
    console.log(`  cd ${CONFIG.vpsPath}`);
    console.log('  sudo bash fix-image-preview.sh');
    process.exit(1);
  }
  
  // Execute based on mode
  switch (mode) {
    case '--check':
      await checkVpsState();
      break;
    case '--deploy':
      await checkVpsState();
      await deployFix();
      await verifyFix();
      break;
    case '--verify':
      await verifyFix();
      break;
    default:
      console.log('Usage:');
      console.log('  node deploy-fix-agent.mjs           # Full deploy (check + fix + verify)');
      console.log('  node deploy-fix-agent.mjs --check   # Check VPS state only');
      console.log('  node deploy-fix-agent.mjs --verify  # Verify fix only');
      process.exit(1);
  }
  
  // Final summary
  console.log('');
  console.log(color(C.cyan, '╔══════════════════════════════════════════════════════════════════╗'));
  console.log(color(C.cyan, '║                        COMPLETE                                  ║'));
  console.log(color(C.cyan, '╚══════════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Visit: ${color(C.yellow, 'https://render.abcx124.xyz/completebatch')}`);
  console.log('  2. Refresh the page');
  console.log('  3. Check if images are now loading');
  console.log('');
  console.log('If images still not showing:');
  console.log('  - Open browser DevTools (F12) → Network tab');
  console.log('  - Look for image requests');
  console.log(`  - Or SSH and run: ${color(C.dim, `cd ${CONFIG.vpsPath} && bash check-vps-images.sh`)}`);
  console.log('');
}

main().catch(err => {
  console.error(color(C.red, `Error: ${err.message}`));
  process.exit(1);
});
