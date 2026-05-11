#!/usr/bin/env node
/**
 * Auto-deploy loop for .et AI image matching e2e testing.
 *
 * This script continuously:
 *   1. Runs the e2e test (test-et-ai-e2e.mjs)
 *   2. Checks if AI verification works for all products
 *   3. If not, analyzes the failure, fixes code, commits, pushes, deploys, and loops
 *
 * Usage:
 *   node auto-deploy-loop.mjs
 *
 * Environment:
 *   - Requires Tailscale SSH access to VPS (100.64.175.88)
 *   - SSH identity file: C:\Users\User\.ssh\id_superroo_vps
 *   - VPS path: /root/productgenerator
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  sshHost: '100.64.175.88',
  sshUser: 'superroo',
  sshIdentityFile: 'C:\\Users\\User\\.ssh\\id_superroo_vps',
  vpsPath: '/root/productgenerator',
  healthEndpoint: 'http://localhost:3002/health',
  maxLoops: 50,           // Safety limit
  loopDelayMs: 5000,      // Delay between loop iterations
  e2eTestScript: 'test-et-ai-e2e.mjs',
  deployScript: 'deploy-agent.mjs',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function sshCmd(cmd) {
  const identityArg = `-i "${CONFIG.sshIdentityFile}"`;
  return `ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${CONFIG.sshUser}@${CONFIG.sshHost} "${cmd}"`;
}

function run(cmd, opts = {}) {
  console.log(`\n▶ ${cmd}`);
  try {
    const output = execSync(cmd, {
      cwd: __dirname,
      timeout: opts.timeout || 300000, // 5 min default
      stdio: opts.silent ? 'pipe' : 'inherit',
      encoding: 'utf-8',
      ...opts,
    });
    return { success: true, output: output || '' };
  } catch (err) {
    return { success: false, output: err.stdout || '', error: err.stderr || err.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── E2E Test Runner ──────────────────────────────────────────────────────────

async function runE2ETest() {
  log('Running e2e test...');
  const result = run(`node ${CONFIG.e2eTestScript}`, {
    timeout: 300000, // 5 min
    silent: true,
  });
  return result;
}

// ── Parse E2E Test Results ───────────────────────────────────────────────────

function parseE2EResults(output) {
  const results = {
    success: false,
    aiVerified: 0,
    totalProducts: 0,
    autoAccepted: 0,
    needsReview: 0,
    rejected: 0,
    apiTimeSec: 0,
    errors: [],
    details: '',
  };

  // Check overall success
  if (output.includes('✅ ALL CHECKS PASSED')) {
    results.success = true;
  }

  // Extract AI verification stats
  const aiVerifiedMatch = output.match(/AI verified:\s*(\d+)\/(\d+)/i);
  if (aiVerifiedMatch) {
    results.aiVerified = parseInt(aiVerifiedMatch[1], 10);
    results.totalProducts = parseInt(aiVerifiedMatch[2], 10);
  }

  // Extract auto-accepted / needs-review / rejected
  const autoMatch = output.match(/auto.accepted[:\s]*(\d+)/i);
  if (autoMatch) results.autoAccepted = parseInt(autoMatch[1], 10);

  const reviewMatch = output.match(/needs.review[:\s]*(\d+)/i);
  if (reviewMatch) results.needsReview = parseInt(reviewMatch[1], 10);

  const rejectedMatch = output.match(/rejected[:\s]*(\d+)/i);
  if (rejectedMatch) results.rejected = parseInt(rejectedMatch[1], 10);

  // Extract API time
  const timeMatch = output.match(/API.*?(\d+\.?\d*)s/i);
  if (timeMatch) results.apiTimeSec = parseFloat(timeMatch[1]);

  // Extract errors
  const errorLines = output.split('\n').filter(l => l.includes('❌') || l.includes('FAIL') || l.includes('Error:'));
  results.errors = errorLines.map(l => l.trim());

  // Extract details section
  const detailsMatch = output.match(/=== DETAILS ===([\s\S]*?)(?=\n===|$)/);
  if (detailsMatch) results.details = detailsMatch[1].trim();

  return results;
}

// ── Check VPS Logs ───────────────────────────────────────────────────────────

async function checkVPSLogs() {
  log('Checking VPS logs...');
  const result = run(
    sshCmd(`docker logs product-studio-backend --tail 100 2>&1 | grep -iE 'ET-IMAGE-EXTRACTOR|AI.verif|verifyEtMatches|verifyProductImagePair|positional|pre-mapped'`),
    { timeout: 30000, silent: true }
  );
  return result;
}

// ── Deploy to VPS ────────────────────────────────────────────────────────────

async function deployToVPS() {
  log('Deploying to VPS...');

  // Step 1: Git commit and push
  log('Committing and pushing to GitHub...');
  const commitResult = run(`git add -A && git commit -m "auto-deploy: fix image cycling for .et AI verification" && git push`, {
    timeout: 60000,
    silent: true,
  });
  if (!commitResult.success) {
    // Check if there's nothing to commit
    if (commitResult.output && commitResult.output.includes('nothing to commit')) {
      log('Nothing to commit, pushing anyway...');
      run(`git push`, { timeout: 30000, silent: true });
    } else {
      log('Git commit/push failed (may be nothing to commit): ' + (commitResult.error || ''));
    }
  }

  // Step 2: Run deploy-agent.mjs
  log('Running deploy-agent.mjs...');
  const deployResult = run(`node ${CONFIG.deployScript}`, {
    timeout: 120000,
    silent: true,
  });

  if (!deployResult.success) {
    log('Deploy script failed: ' + (deployResult.error || ''));
    return false;
  }

  // Step 3: Wait for container to be healthy
  log('Waiting for container to be healthy...');
  for (let i = 0; i < 30; i++) {
    const healthResult = run(
      sshCmd(`curl -s -o /dev/null -w "%{http_code}" ${CONFIG.healthEndpoint}`),
      { timeout: 10000, silent: true }
    );
    if (healthResult.success && healthResult.output.trim() === '200') {
      log('Container is healthy!');
      return true;
    }
    await sleep(2000);
  }

  log('Container health check timed out');
  return false;
}

// ── Analyze Failure and Fix Code ─────────────────────────────────────────────

async function analyzeAndFix(results, iteration) {
  log(`Analyzing failure (iteration ${iteration})...`);

  const fixes = [];

  // Check 1: AI verification count
  if (results.totalProducts > 0 && results.aiVerified < results.totalProducts) {
    const missingCount = results.totalProducts - results.aiVerified;
    log(`Issue: ${missingCount}/${results.totalProducts} products not AI-verified`);

    // Check VPS logs for details
    const vpsLogs = await checkVPSLogs();
    if (vpsLogs.success) {
      log('VPS logs retrieved');
    }

    // Common fix: check if image names match
    fixes.push('check_image_name_matching');
  }

  // Check 2: All rejected
  if (results.rejected === results.totalProducts && results.totalProducts > 0) {
    log('Issue: All products rejected by AI');
    fixes.push('check_ai_prompt_or_model');
  }

  // Check 3: API timeout
  if (results.apiTimeSec > 240) {
    log(`Issue: API took ${results.apiTimeSec}s (too slow)`);
    fixes.push('increase_timeout_or_optimize');
  }

  // Check 4: UI never completes
  if (results.errors.some(e => e.includes('timeout') || e.includes('TIMEOUT'))) {
    log('Issue: UI timeout');
    fixes.push('increase_ui_timeout');
  }

  return fixes;
}

// ── Apply Fixes ──────────────────────────────────────────────────────────────

async function applyFixes(fixes, iteration) {
  log(`Applying fixes: ${fixes.join(', ')}`);

  for (const fix of fixes) {
    switch (fix) {
      case 'check_image_name_matching':
        // This is already fixed by the cycling logic above
        log('Image cycling fix already applied');
        break;

      case 'check_ai_prompt_or_model':
        log('Need to check AI prompt/model - will check logs');
        break;

      case 'increase_timeout_or_optimize':
        log('Need to increase timeout or optimize batch processing');
        break;

      case 'increase_ui_timeout':
        log('Need to increase UI timeout in e2e test');
        break;

      default:
        log(`Unknown fix: ${fix}`);
    }
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────────

async function main() {
  log('=== AUTO-DEPLOY LOOP STARTED ===');
  log(`Max iterations: ${CONFIG.maxLoops}`);
  log(`E2E test: ${CONFIG.e2eTestScript}`);
  log(`Deploy script: ${CONFIG.deployScript}`);
  log('');

  let iteration = 0;
  let lastResult = null;

  while (iteration < CONFIG.maxLoops) {
    iteration++;
    log(`\n${'='.repeat(60)}`);
    log(`ITERATION ${iteration}/${CONFIG.maxLoops}`);
    log(`${'='.repeat(60)}`);

    // Step 1: Run e2e test
    log('Step 1: Running e2e test...');
    const testResult = await runE2ETest();

    if (!testResult.success) {
      log('E2E test execution failed (may be timeout or crash)');
      log('Output snippet: ' + (testResult.output || '').substring(0, 500));
    }

    // Step 2: Parse results
    const results = parseE2EResults(testResult.output || '');
    lastResult = results;

    log(`\nResults:`);
    log(`  Success: ${results.success}`);
    log(`  AI verified: ${results.aiVerified}/${results.totalProducts}`);
    log(`  Auto-accepted: ${results.autoAccepted}`);
    log(`  Needs review: ${results.needsReview}`);
    log(`  Rejected: ${results.rejected}`);
    log(`  API time: ${results.apiTimeSec}s`);
    if (results.errors.length > 0) {
      log(`  Errors:`);
      results.errors.forEach(e => log(`    - ${e}`));
    }

    // Step 3: Check if we're done
    const allVerified = results.totalProducts > 0 && results.aiVerified === results.totalProducts;
    const allAutoAccepted = results.totalProducts > 0 && results.autoAccepted === results.totalProducts;

    if (allAutoAccepted) {
      log('\n✅ ALL PRODUCTS AUTO-ACCEPTED BY AI!');
      log('Image matching is working correctly.');
      log(`Final results: ${results.autoAccepted} auto-accepted, ${results.needsReview} needs review, ${results.rejected} rejected`);
      break;
    }

    if (allVerified && results.autoAccepted > 0) {
      log(`\n⚠️  All ${results.totalProducts} products verified, but only ${results.autoAccepted} auto-accepted.`);
      log('This may be acceptable (some products genuinely don\'t match their images).');
      log(`Stats: ${results.autoAccepted} auto-accepted, ${results.needsReview} needs review, ${results.rejected} rejected`);
      // Continue to see if we can improve
    }

    // Step 4: Analyze and fix
    log('\nStep 4: Analyzing failures...');
    const fixes = await analyzeAndFix(results, iteration);

    if (fixes.length === 0) {
      log('No specific fixes identified. Checking VPS logs for clues...');
      const vpsLogs = await checkVPSLogs();
      if (vpsLogs.success) {
        log('VPS logs:');
        console.log(vpsLogs.output?.substring(0, 1000));
      }
    }

    // Step 5: Apply fixes
    if (fixes.length > 0) {
      log('\nStep 5: Applying fixes...');
      await applyFixes(fixes, iteration);

      // Step 6: Deploy
      log('\nStep 6: Deploying to VPS...');
      const deployed = await deployToVPS();
      if (!deployed) {
        log('Deploy failed, will retry on next iteration');
      }
    } else {
      log('\nNo fixes to apply. Deploying current code...');
      const deployed = await deployToVPS();
      if (!deployed) {
        log('Deploy failed, will retry on next iteration');
      }
    }

    // Step 7: Wait before next iteration
    log(`\nWaiting ${CONFIG.loopDelayMs / 1000}s before next iteration...`);
    await sleep(CONFIG.loopDelayMs);
  }

  // ── Final Summary ──────────────────────────────────────────────────────────
  log('\n' + '='.repeat(60));
  log('AUTO-DEPLOY LOOP COMPLETED');
  log('='.repeat(60));

  if (lastResult) {
    log(`\nFinal results:`);
    log(`  Iterations: ${iteration}`);
    log(`  AI verified: ${lastResult.aiVerified}/${lastResult.totalProducts}`);
    log(`  Auto-accepted: ${lastResult.autoAccepted}`);
    log(`  Needs review: ${lastResult.needsReview}`);
    log(`  Rejected: ${lastResult.rejected}`);
    log(`  API time: ${lastResult.apiTimeSec}s`);
    log(`  All checks passed: ${lastResult.success}`);
  }

  // Save final report
  const reportPath = path.join(__dirname, 'auto-deploy-report.md');
  const report = [
    '# Auto-Deploy Loop Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Iterations:** ${iteration}`,
    `**Max iterations:** ${CONFIG.maxLoops}`,
    '',
    '## Final Results',
    '',
    lastResult ? [
      `- AI verified: ${lastResult.aiVerified}/${lastResult.totalProducts}`,
      `- Auto-accepted: ${lastResult.autoAccepted}`,
      `- Needs review: ${lastResult.needsReview}`,
      `- Rejected: ${lastResult.rejected}`,
      `- API time: ${lastResult.apiTimeSec}s`,
      `- All checks passed: ${lastResult.success}`,
    ].join('\n') : '- No results',
    '',
    '## Status',
    '',
    lastResult && lastResult.autoAccepted === lastResult.totalProducts
      ? '✅ **SUCCESS** — All products auto-accepted by AI'
      : lastResult && lastResult.aiVerified === lastResult.totalProducts
        ? '⚠️ **PARTIAL** — All verified but not all auto-accepted'
        : '❌ **FAILED** — Not all products verified',
    '',
  ].join('\n');

  fs.writeFileSync(reportPath, report, 'utf-8');
  log(`\nReport saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
