#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  deploy-agent.mjs — One-command commit, push & deploy to VPS
//
//  Usage:
//    node deploy-agent.mjs "commit message"     # Commit + push + deploy
//    node deploy-agent.mjs                       # Prompt for commit message
//    node deploy-agent.mjs --no-push             # Deploy local files without push
//    node deploy-agent.mjs --no-deploy           # Commit + push only
//    node deploy-agent.mjs --help                # Show help
//
//  Prerequisites:
//    - SSH key-based auth to VPS (configured in ~/.ssh/config)
//    - Git repo with remote configured
//    - rsync installed locally
//    - PM2 installed on VPS
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';

// ── Configuration ──────────────────────────────────────────────────
const CONFIG = {
  // VPS connection — uses SSH host alias from ~/.ssh/config
  sshHost: 'superroo-vps',       // SSH host alias (see ~/.ssh/config)
  vpsPath: '/root/productgenerator',
  pm2ProcessName: 'product-image-studio',

  // Git
  gitBranch: 'main',
  gitRemote: 'origin',

  // Files to exclude from rsync
  rsyncExcludes: [
    'node_modules',
    'logs',
    '.env',
    '.git',
    '*.log',
    'vps-env.txt',
    'vps-setup.sh',
    'vps-deploy-all.sh',
    'test-*.mjs',
    '*.pdf',
    '*.zip',
    'fal_docs.html',
    'fix_env.py',
    'product_studio_queue*',
    'deepseek.js',
    'drive.js',
    'fal-webhook.js',
    'process-item.js',
    'process.js',
    'status.js',
    'submit.js',
    'supabase.js',
    'upload-drive.js',
  ],

  // Health check
  healthEndpoint: 'http://localhost:3000/health',
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
  console.log(color(C.dim, `  $ ${cmd}`));
  return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf-8', ...opts });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function step(n, total, label) {
  console.log(`\n${color(C.cyan, `[${n}/${total}]`)} ${color(C.bold, label)}`);
}

function ok(msg) {
  console.log(`  ${color(C.green, '✓')} ${msg}`);
}

function warn(msg) {
  console.log(`  ${color(C.yellow, '⚠')} ${msg}`);
}

function fail(msg) {
  console.log(`  ${color(C.red, '✗')} ${msg}`);
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // ── Help ──
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${color(C.bold, 'deploy-agent.mjs')} — Commit, push & deploy to VPS in one command

${color(C.bold, 'Usage:')}
  node deploy-agent.mjs "commit message"       Commit + push + deploy
  node deploy-agent.mjs                         Prompt for commit message
  node deploy-agent.mjs --no-push               Deploy local files without push
  node deploy-agent.mjs --no-deploy             Commit + push only
  node deploy-agent.mjs --help                  Show this help

${color(C.bold, 'Flags:')}
  --no-push       Skip git push, deploy current local files
  --no-deploy     Commit + push to GitHub only, skip VPS deploy
  --force         Skip confirmation prompts
  --dry-run       Show what would be done without doing it

${color(C.bold, 'Config:')}
  Edit the CONFIG object at the top of this file to change:
  - sshHost: SSH host alias (default: superroo-vps)
  - vpsPath: Remote path (default: /root/productgenerator)
  - pm2ProcessName: PM2 process name (default: product-image-studio)
`);
    process.exit(0);
  }

  const flags = {
    noPush: args.includes('--no-push'),
    noDeploy: args.includes('--no-deploy'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  };

  // Extract commit message from args (filter out flags)
  let commitMsg = args.filter(a => !a.startsWith('--')).join(' ') || '';

  const TOTAL_STEPS = flags.noDeploy ? 3 : 5;

  console.log(color(C.cyan, '═══════════════════════════════════════════════════════════════'));
  console.log(color(C.cyan, `  ${color(C.bold, 'Deploy Agent')} — Commit → Push → Deploy`));
  console.log(color(C.cyan, `  Target: ${CONFIG.sshHost}:${CONFIG.vpsPath}`));
  console.log(color(C.cyan, `  PM2:    ${CONFIG.pm2ProcessName}`));
  if (flags.dryRun) console.log(`  ${color(C.yellow, 'DRY RUN — no changes will be made')}`);
  console.log(color(C.cyan, '═══════════════════════════════════════════════════════════════'));

  // ── Step 1: Check git status ──
  step(1, TOTAL_STEPS, 'Checking git status...');

  const status = runCapture('git status --porcelain');
  if (!status) {
    warn('No uncommitted changes found.');
    if (!flags.force) {
      const answer = await prompt('  Continue anyway? (y/N) ');
      if (answer.toLowerCase() !== 'y') {
        console.log(color(C.yellow, '\nAborted.'));
        process.exit(0);
      }
    }
  } else {
    const modifiedCount = status.split('\n').length;
    ok(`${modifiedCount} file(s) modified`);
    console.log(color(C.dim, status));
  }

  // ── Step 2: Commit ──
  step(2, TOTAL_STEPS, 'Committing changes...');

  if (!commitMsg) {
    commitMsg = await prompt('  Commit message: ');
    if (!commitMsg.trim()) {
      commitMsg = `Update ${new Date().toISOString().split('T')[0]}`;
      warn(`Using default message: "${commitMsg}"`);
    }
  }

  if (!flags.dryRun) {
    try {
      run(`git add -A`);
      run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
      ok(`Committed: "${commitMsg}"`);
    } catch (e) {
      if (e.message.includes('nothing to commit')) {
        warn('Nothing to commit.');
      } else {
        fail(`Commit failed: ${e.message}`);
        process.exit(1);
      }
    }
  } else {
    ok(`Would commit: "${commitMsg}"`);
  }

  // ── Step 3: Push to GitHub ──
  if (!flags.noPush) {
    step(3, TOTAL_STEPS, 'Pushing to GitHub...');

    if (!flags.dryRun) {
      try {
        run(`git push ${CONFIG.gitRemote} ${CONFIG.gitBranch}`);
        ok(`Pushed to ${CONFIG.gitRemote}/${CONFIG.gitBranch}`);
      } catch (e) {
        fail(`Push failed: ${e.message}`);
        const answer = await prompt('  Continue with deploy anyway? (y/N) ');
        if (answer.toLowerCase() !== 'y') {
          console.log(color(C.yellow, '\nAborted.'));
          process.exit(1);
        }
      }
    } else {
      ok(`Would push to ${CONFIG.gitRemote}/${CONFIG.gitBranch}`);
    }
  } else {
    step(3, TOTAL_STEPS, 'Skipping git push (--no-push)');
    warn('Deploying current local files without pushing to GitHub');
  }

  // ── Deploy to VPS ──
  if (!flags.noDeploy) {
    const deployStepOffset = flags.noPush ? 3 : 4;

    // ── Step 4 (or 3): Rsync files to VPS ──
    step(deployStepOffset, TOTAL_STEPS, 'Syncing files to VPS...');

    const excludeArgs = CONFIG.rsyncExcludes.map(e => `--exclude='${e}'`).join(' ');

    if (!flags.dryRun) {
      try {
        const rsyncCmd = `rsync -avz --delete ${excludeArgs} -e "ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new" ./ ${CONFIG.sshHost}:${CONFIG.vpsPath}/`;
        run(rsyncCmd);
        ok('Files synced to VPS');
      } catch (e) {
        fail(`Rsync failed: ${e.message}`);
        process.exit(1);
      }
    } else {
      ok(`Would rsync to ${CONFIG.sshHost}:${CONFIG.vpsPath}`);
    }

    // ── Step 5 (or 4): Restart PM2 + health check ──
    const healthStep = deployStepOffset + 1;
    step(healthStep, TOTAL_STEPS, 'Restarting PM2 and running health check...');

    if (!flags.dryRun) {
      try {
        // Restart PM2
        run(`ssh ${CONFIG.sshHost} "cd ${CONFIG.vpsPath} && pm2 startOrReload ecosystem.config.cjs --update-env"`, { silent: false });
        ok('PM2 restarted');

        // Wait for startup
        console.log(`  ${color(C.dim, 'Waiting 3s for app to start...')}`);
        run('sleep 3', { silent: true });

        // Health check
        const httpCode = runCapture(`ssh ${CONFIG.sshHost} "curl -s -o /dev/null -w '%{http_code}' ${CONFIG.healthEndpoint}"`);
        if (httpCode === '200') {
          ok(`Health check passed (HTTP ${httpCode})`);
        } else {
          fail(`Health check failed (HTTP ${httpCode || 'no response'})`);
          warn(`Check logs: ssh ${CONFIG.sshHost} "pm2 logs ${CONFIG.pm2ProcessName} --lines 20"`);
          process.exit(1);
        }
      } catch (e) {
        fail(`Deploy failed: ${e.message}`);
        process.exit(1);
      }
    } else {
      ok('Would restart PM2 and run health check');
    }
  } else {
    const skipStep = flags.noPush ? 3 : 4;
    step(skipStep, TOTAL_STEPS, 'Skipping VPS deploy (--no-deploy)');
    ok('Changes committed and pushed to GitHub only');
  }

  // ── Done ──
  console.log(`\n${color(C.green, '═══════════════════════════════════════════════════════════════')}`);
  console.log(`${color(C.green, `  ${color(C.bold, 'Deployment complete!')}`)}`);
  if (!flags.noDeploy) {
    console.log(`${color(C.green, `  App is running at https://productgenerator.blond.vercel.app`)}`);
  }
  console.log(`${color(C.green, '═══════════════════════════════════════════════════════════════')}`);
}

main().catch(e => {
  console.error(color(C.red, `\nFatal error: ${e.message}`));
  process.exit(1);
});
