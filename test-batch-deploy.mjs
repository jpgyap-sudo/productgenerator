// ══════════════════════════════════════════════════════════════════
//  Batch Deployment Verification Test
//  Tests that the batch pipeline is correctly deployed on VPS
// ══════════════════════════════════════════════════════════════════
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import fs from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL || '', SUPABASE_KEY || '', {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

async function test() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  BATCH DEPLOYMENT VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let failed = 0;

  // ── Test 1: Supabase tables ──
  console.log('Test 1: Supabase tables');
  for (const table of ['batch_jobs', 'zip_image_fingerprints', 'product_matches']) {
    const { data, error } = await supabase.from(table).select('id').limit(1);
    if (error) {
      console.log(`  ❌ ${table}: ${error.message}`);
      failed++;
    } else {
      console.log(`  ✅ ${table}: exists`);
      passed++;
    }
  }

  // ── Test 2: Environment variables ──
  console.log('\nTest 2: Environment variables');
  const requiredVars = [
    'OPENAI_FINGERPRINT_MODEL',
    'OPENAI_VERIFY_MODEL',
    'OPENAI_VERIFY_DELAY_MS',
    'OPENAI_MAX_CONCURRENCY',
    'OPENAI_MAX_RETRIES',
    'MATCH_AUTO_ACCEPT',
    'MATCH_REVIEW_THRESHOLD',
    'MAX_CANDIDATES_PER_PRODUCT',
    'MIN_CANDIDATE_SCORE'
  ];
  for (const v of requiredVars) {
    if (process.env[v]) {
      console.log(`  ✅ ${v}=${process.env[v]}`);
      passed++;
    } else {
      console.log(`  ❌ ${v}: missing`);
      failed++;
    }
  }

  // ── Test 3: Library files exist ──
  console.log('\nTest 3: Library files');
  const libFiles = [
    'lib/batch-queue.js',
    'lib/image-fingerprint.js',
    'lib/candidate-filter.js',
    'lib/openai-verify.js',
    'lib/progress-estimator.js',
    'lib/retry-manager.js',
    'lib/pdf-image-extractor.js',
    'lib/vision-matcher.js'
  ];
  for (const f of libFiles) {
    if (fs.existsSync(f)) {
      console.log(`  ✅ ${f}`);
      passed++;
    } else {
      console.log(`  ❌ ${f}: missing`);
      failed++;
    }
  }

  // ── Test 4: Import validation ──
  console.log('\nTest 4: Import validation');
  const imports = [
    { name: 'batch-queue', path: './lib/batch-queue.js', exports: ['createBatchJob', 'runBatchPipeline', 'getBatchState'] },
    { name: 'image-fingerprint', path: './lib/image-fingerprint.js', exports: ['fingerprintImage', 'fingerprintAllImages'] },
    { name: 'candidate-filter', path: './lib/candidate-filter.js', exports: ['filterCandidates', 'filterAllCandidates'] },
    { name: 'openai-verify', path: './lib/openai-verify.js', exports: ['verifyMatch', 'verifyAllProducts'] },
    { name: 'progress-estimator', path: './lib/progress-estimator.js', exports: ['createProgressEstimator', 'formatDuration'] },
    { name: 'retry-manager', path: './lib/retry-manager.js', exports: ['createRetryManager', 'withRetry'] }
  ];
  for (const mod of imports) {
    try {
      const m = await import(mod.path);
      const missing = mod.exports.filter(e => typeof m[e] !== 'function');
      if (missing.length === 0) {
        console.log(`  ✅ ${mod.name}: all exports found`);
        passed++;
      } else {
        console.log(`  ❌ ${mod.name}: missing exports: ${missing.join(', ')}`);
        failed++;
      }
    } catch (err) {
      console.log(`  ❌ ${mod.name}: import failed - ${err.message}`);
      failed++;
    }
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
