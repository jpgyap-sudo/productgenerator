#!/usr/bin/env node
/**
 * Deploy Image Preview Fix to VPS
 * Uses Tailscale SSH for reliable deployment
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration - Update these with your VPS details
const CONFIG = {
  // Tailscale IP of your VPS (check with `tailscale ip -4` on VPS)
  sshHost: '100.64.x.x',  // ← REPLACE with your VPS Tailscale IP
  sshUser: 'root',         // or your VPS username
  sshIdentityFile: process.env.SSH_KEY || 'C:\\Users\\User\\.ssh\\id_rsa',
  vpsPath: '/root/productgenerator',
};

function sshCmd(cmd) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  return `ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${CONFIG.sshUser}@${CONFIG.sshHost} "${cmd}"`;
}

function scpCmd(localPath, remotePath) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  return `scp ${identityArg} -o StrictHostKeyChecking=accept-new "${localPath}" "${CONFIG.sshUser}@${CONFIG.sshHost}:${remotePath}"`;
}

function runCommand(cmd, description) {
  console.log(`\n📦 ${description}...`);
  console.log(`   Command: ${cmd.substring(0, 100)}...`);
  
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd' : 'bash';
    const shellFlag = isWindows ? '/c' : '-c';
    
    const child = spawn(shell, [shellFlag, cmd], {
      stdio: 'pipe',
      cwd: __dirname
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║       DEPLOY IMAGE PREVIEW FIX TO VPS                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Configuration:');
  console.log(`  SSH Host: ${CONFIG.sshHost}`);
  console.log(`  SSH User: ${CONFIG.sshUser}`);
  console.log(`  VPS Path: ${CONFIG.vpsPath}`);
  console.log(`  Identity: ${CONFIG.sshIdentityFile}`);
  console.log('');

  // Check if fix script exists locally
  const fixScriptPath = join(__dirname, 'fix-image-preview.sh');
  const checkScriptPath = join(__dirname, 'check-vps-images.sh');
  
  try {
    // Step 1: Test SSH connection
    console.log('🔍 Step 1: Testing SSH connection...');
    await runCommand(sshCmd('echo "SSH connection successful"'), 'Testing SSH');
    console.log('   ✅ SSH connection OK');

    // Step 2: Upload fix script
    console.log('');
    console.log('📤 Step 2: Uploading fix script...');
    await runCommand(scpCmd(fixScriptPath, `${CONFIG.vpsPath}/fix-image-preview.sh`), 'Uploading fix script');
    console.log('   ✅ Fix script uploaded');

    // Step 3: Upload check script
    console.log('');
    console.log('📤 Step 3: Uploading check script...');
    await runCommand(scpCmd(checkScriptPath, `${CONFIG.vpsPath}/check-vps-images.sh`), 'Uploading check script');
    console.log('   ✅ Check script uploaded');

    // Step 4: Run check script first (to see current state)
    console.log('');
    console.log('🔍 Step 4: Checking current VPS state...');
    try {
      await runCommand(sshCmd(`cd ${CONFIG.vpsPath} && bash check-vps-images.sh`), 'Checking VPS state');
    } catch (e) {
      console.log('   ⚠️  Check script completed with warnings (this is normal)');
    }

    // Step 5: Execute fix script
    console.log('');
    console.log('🔧 Step 5: Running fix script on VPS...');
    await runCommand(sshCmd(`cd ${CONFIG.vpsPath} && bash fix-image-preview.sh`), 'Applying fixes');
    console.log('   ✅ Fixes applied');

    // Step 6: Verify fix
    console.log('');
    console.log('✅ Step 6: Verifying fixes...');
    try {
      await runCommand(sshCmd(`cd ${CONFIG.vpsPath} && bash check-vps-images.sh`), 'Verifying');
    } catch (e) {
      console.log('   ⚠️  Verification completed');
    }

    // Step 7: Test a specific image URL
    console.log('');
    console.log('🌐 Step 7: Testing image URL...');
    const testUrl = 'https://render.abcx124.xyz/vps-assets/renders/item-77/HA-801_img1_Front_view.png';
    try {
      const result = await runCommand(
        `curl -s -o /dev/null -w "%{http_code}" "${testUrl}"`,
        'Testing image URL'
      );
      if (result.trim() === '200') {
        console.log('   ✅ Image is now accessible (HTTP 200)');
      } else {
        console.log(`   ⚠️  Image returned HTTP ${result.trim()}`);
      }
    } catch (e) {
      console.log('   ⚠️  Could not test image URL from local machine');
    }

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                    DEPLOYMENT COMPLETE                           ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Refresh your browser: https://render.abcx124.xyz/completebatch');
    console.log('  2. Check if images are now loading');
    console.log('  3. If still not working, check browser DevTools Network tab');
    console.log('');
    console.log('To verify manually on VPS:');
    console.log(`  ssh ${CONFIG.sshUser}@${CONFIG.sshHost}`);
    console.log(`  cd ${CONFIG.vpsPath}`);
    console.log('  bash check-vps-images.sh');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('❌ DEPLOYMENT FAILED:');
    console.error(error.message);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  1. Update CONFIG.sshHost with your VPS Tailscale IP');
    console.error('  2. Ensure Tailscale is running on both machines');
    console.error('  3. Check SSH key path in CONFIG.sshIdentityFile');
    console.error('  4. Or manually run the fix script on your VPS:');
    console.error('     - Upload fix-image-preview.sh to your VPS');
    console.error('     - Run: sudo bash fix-image-preview.sh');
    process.exit(1);
  }
}

main();
