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
import { createInterface } from 'readline';
import { setTimeout as sleep } from 'timers/promises';
import { existsSync } from 'fs';

// ── Configuration ──────────────────────────────────────────────────
const CONFIG = {
  // VPS connection — uses Tailscale IP (public IP port 22 is firewalled)
  sshHost: '100.64.175.88',      // Tailscale IP (public IP port 22 is firewalled)
  sshIdentityFile: 'C:\\Users\\User\\.ssh\\id_superroo_vps',  // SSH key
  vpsPath: '/root/productgenerator',
  pm2ProcessName: 'product-image-studio',

  // Git
  gitBranch: 'main',
  gitRemote: 'origin',

  // Files to exclude from rsync
  rsyncExcludes: [
    'node_modules',
    'furniture-render/node_modules',
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
  ],

  // Health check (port 3001 — SuperRoo Cloud Dashboard uses port 3000)
  healthEndpoint: 'http://localhost:3001/health',
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

function sshCmd(cmd) {
  const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
  return `ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new superroo@${CONFIG.sshHost} "${cmd}"`;
}

function commandExists(command) {
  const checkCmd = process.platform === 'win32'
    ? `where ${command}`
    : `command -v ${command}`;
  return Boolean(runCapture(checkCmd));
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

  const TOTAL_STEPS = flags.noDeploy ? 3 : 6;

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
      // Check if the error is just "nothing to commit" — continue with deploy
      const commitOutput = runCapture(`git status --porcelain`);
      if (commitOutput === '') {
        warn('Nothing to commit — continuing with deploy.');
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

    // ── Build frontend before syncing ──
    const frontendStep = deployStepOffset;
    step(frontendStep, TOTAL_STEPS, 'Building frontend (furniture-render)...');
    if (!flags.dryRun) {
      try {
        const furnitureDir = './furniture-render';
        if (existsSync(`${furnitureDir}/node_modules`)) {
          run(`cd ${furnitureDir} && npx vite build`);
        } else {
          warn('furniture-render/node_modules not found, installing deps first...');
          run(`cd ${furnitureDir} && npm install && npx vite build`);
        }
        ok('Frontend built');
      } catch (e) {
        fail(`Frontend build failed: ${e.message}`);
        process.exit(1);
      }
    } else {
      ok('Would build frontend');
    }

    // ── Step 4 (or 3): Rsync files to VPS ──
    const rsyncStep = deployStepOffset + 1;
    step(rsyncStep, TOTAL_STEPS, 'Syncing files to VPS...');

    if (!flags.dryRun) {
      try {
        if (commandExists('rsync')) {
          const excludeArgs = CONFIG.rsyncExcludes.map(e => `--exclude='${e}'`).join(' ');
          const sshOpts = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}" -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new` : '-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new';
          const rsyncCmd = `rsync -avz --delete ${excludeArgs} -e "ssh ${sshOpts}" ./ superroo@${CONFIG.sshHost}:${CONFIG.vpsPath}/`;
          run(rsyncCmd);
          ok('Files synced to VPS with rsync');
        } else {
          warn('rsync not found; using git archive over SSH fallback');
          // Use sudo tar because files in /root/productgenerator are owned by root
          const archiveCmd = `git archive --format=tar HEAD | ${sshCmd('mkdir -p ' + CONFIG.vpsPath + ' && sudo tar -xf - -C ' + CONFIG.vpsPath)}`;
          run(archiveCmd);
          ok('Committed files synced to VPS with git archive');
        }
      } catch (e) {
        fail(`File sync failed: ${e.message}`);
        process.exit(1);
      }
    } else {
      ok(`Would rsync to ${CONFIG.sshHost}:${CONFIG.vpsPath}`);
    }

    // ── Sync .env file (not in git, needed for Docker) ──
    if (!flags.dryRun) {
      try {
        if (existsSync('.env')) {
          // Use type + ssh sudo tee because files in /root/ are owned by root
          const identityArg = CONFIG.sshIdentityFile ? `-i "${CONFIG.sshIdentityFile}"` : '';
          const pipeCmd = `type .env | ssh ${identityArg} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new superroo@${CONFIG.sshHost} "sudo tee ${CONFIG.vpsPath}/.env > /dev/null && sudo chmod 600 ${CONFIG.vpsPath}/.env"`;
          run(pipeCmd, { silent: true });
          ok('.env file synced to VPS');
        } else {
          warn('No local .env file found; keeping existing remote .env');
        }
      } catch (e) {
        warn(`Failed to sync .env: ${e.message}`);
      }
    }

    // ── Step 5 (or 4): Restart process + health check ──
    const healthStep = deployStepOffset + 2;
    step(healthStep, TOTAL_STEPS, 'Restarting application and running health check...');

    if (!flags.dryRun) {
      try {
        // Ensure logs directory exists with proper permissions
        run(sshCmd('sudo mkdir -p ' + CONFIG.vpsPath + '/logs && sudo chown superroo:superroo ' + CONFIG.vpsPath + '/logs'), { silent: true });

        // Detect Docker vs PM2 and restart accordingly
        const dockerActive = runCapture(sshCmd('docker ps -q --filter name=product-studio-backend 2>/dev/null || true'));
        if (dockerActive) {
          warn('Detected Docker deployment, rebuilding container...');
          run(sshCmd('cd ' + CONFIG.vpsPath + ' && docker compose build && docker compose up -d'), { silent: false });
          ok('Docker container rebuilt and restarted');
        } else {
          warn('Docker container not running; starting with Docker...');
          run(sshCmd('cd ' + CONFIG.vpsPath + ' && docker compose up -d'), { silent: false });
          ok('Docker container started');
        }

        // Wait for startup
        console.log(`  ${color(C.dim, 'Waiting 3s for app to start...')}`);
        await sleep(3000);

        // Health check
        const httpCode = runCapture(sshCmd(`curl -s -o /dev/null -w '%{http_code}' ${CONFIG.healthEndpoint}`));
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
    console.log(`${color(C.green, `  App is running at https://render.abcx124.xyz`)}`);
  }
  console.log(`${color(C.green, '═══════════════════════════════════════════════════════════════')}`);
}

main().catch(e => {
  console.error(color(C.red, `\nFatal error: ${e.message}`));
  process.exit(1);
});
