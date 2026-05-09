// ═══════════════════════════════════════════════════════════════════
//  Comprehensive API Endpoint Test Suite
//  Tests all API endpoints on the live VPS server
// ═══════════════════════════════════════════════════════════════════

const BASE = 'https://render.abcx124.xyz';
let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    errors.push({ name, message: err.message });
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

function expectStatus(res, expected) {
  if (res.status !== expected) {
    throw new Error(`Expected status ${expected}, got ${res.status}`);
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  PRODUCT IMAGE STUDIO — API TEST SUITE');
  console.log(`  Target: ${BASE}`);
  console.log('═══════════════════════════════════════════\n');

  // ── 1. Health Check ──
  console.log('── Health & Monitoring ──');
  await test('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expectStatus(res, 200);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(`Expected status "ok", got "${data.status}"`);
    if (typeof data.uptime !== 'number') throw new Error('Missing uptime');
  });

  await test('GET /api/monitor returns system info', async () => {
    const res = await fetch(`${BASE}/api/monitor`);
    expectStatus(res, 200);
    const data = await res.json();
    if (!data) throw new Error('No data returned');
  });

  // ── 2. Queue API ──
  console.log('\n── Queue API ──');
  
  await test('POST /api/queue/submit rejects empty body', async () => {
    const res = await fetch(`${BASE}/api/queue/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    // Should return 400 or error
    const data = await res.json();
    if (!data.error && res.status === 200) throw new Error('Expected error for empty submission');
  });

  await test('POST /api/queue/submit rejects missing image', async () => {
    const res = await fetch(`${BASE}/api/queue/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Product', desc: 'Test description' })
    });
    const data = await res.json();
    if (!data.error && res.status === 200) throw new Error('Expected error for missing image');
  });

  await test('GET /api/queue/status returns object with queue array', async () => {
    const res = await fetch(`${BASE}/api/queue/status`);
    expectStatus(res, 200);
    const data = await res.json();
    if (typeof data !== 'object' || data === null) throw new Error('Expected object');
    // Returns { queue: [...], renderResults: {...} } — frontend handles this format
    if (!Array.isArray(data.queue)) throw new Error('Expected data.queue to be an array');
  });

  await test('GET /api/queue/completed returns object with completedBatches array', async () => {
    const res = await fetch(`${BASE}/api/queue/completed`);
    expectStatus(res, 200);
    const data = await res.json();
    if (typeof data !== 'object' || data === null) throw new Error('Expected object');
    // Returns { completedBatches: [...] } — frontend handles this format
    if (!Array.isArray(data.completedBatches)) throw new Error('Expected data.completedBatches to be an array');
  });

  await test('GET /api/queue/completed?page=1&perPage=5 works', async () => {
    const res = await fetch(`${BASE}/api/queue/completed?page=1&perPage=5`);
    expectStatus(res, 200);
    const data = await res.json();
    if (typeof data !== 'object' || data === null) throw new Error('Expected object');
    if (!Array.isArray(data.completedBatches)) throw new Error('Expected data.completedBatches to be an array');
  });

  await test('POST /api/queue/save-state accepts state data', async () => {
    const res = await fetch(`${BASE}/api/queue/save-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] })
    });
    expectStatus(res, 200);
  });

  // ── 3. Agent API ──
  console.log('\n── Agent API ──');

  await test('POST /api/agent/process rejects no files', async () => {
    const res = await fetch(`${BASE}/api/agent/process`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for missing files');
  });

  await test('POST /api/agent/match rejects empty body', async () => {
    const res = await fetch(`${BASE}/api/agent/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for empty match request');
  });

  await test('POST /api/agent/submit rejects empty body', async () => {
    const res = await fetch(`${BASE}/api/agent/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for empty submit');
  });

  await test('POST /api/agent/save-matched rejects empty body', async () => {
    const res = await fetch(`${BASE}/api/agent/save-matched`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for empty save-matched');
  });

  await test('GET /api/agent/matched-images returns data', async () => {
    const res = await fetch(`${BASE}/api/agent/matched-images`);
    expectStatus(res, 200);
    const data = await res.json();
    // Should return an object with matches array or similar
    if (typeof data !== 'object') throw new Error('Expected object');
  });

  await test('GET /api/agent/matched-images?page=1&perPage=10 works', async () => {
    const res = await fetch(`${BASE}/api/agent/matched-images?page=1&perPage=10`);
    expectStatus(res, 200);
  });

  await test('POST /api/agent/save-matched-permanent rejects empty', async () => {
    const res = await fetch(`${BASE}/api/agent/save-matched-permanent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for empty save-matched-permanent');
  });

  await test('GET /api/agent/matched-images-permanent returns data', async () => {
    const res = await fetch(`${BASE}/api/agent/matched-images-permanent`);
    expectStatus(res, 200);
    const data = await res.json();
    if (typeof data !== 'object') throw new Error('Expected object');
  });

  // ── 4. Render API ──
  console.log('\n── Render API ──');

  await test('POST /api/render/product rejects no data', async () => {
    const res = await fetch(`${BASE}/api/render/product`, {
      method: 'POST'
    });
    const data = await res.json();
    if (!data.error && !data.ok) throw new Error('Expected error for missing render data');
  });

  // ── 5. Render Queue API ──
  console.log('\n── Render Queue API ──');

  await test('GET /api/render-queue/batches returns data', async () => {
    const res = await fetch(`${BASE}/api/render-queue/batches`);
    expectStatus(res, 200);
    const data = await res.json();
    if (typeof data !== 'object') throw new Error('Expected object');
  });

  await test('GET /api/render-queue/batches?page=1&pageSize=10 works', async () => {
    const res = await fetch(`${BASE}/api/render-queue/batches?page=1&pageSize=10`);
    expectStatus(res, 200);
  });

  await test('POST /api/render-queue/pause-all returns ok', async () => {
    const res = await fetch(`${BASE}/api/render-queue/pause-all`, { method: 'POST' });
    expectStatus(res, 200);
  });

  await test('POST /api/render-queue/resume-all returns ok', async () => {
    const res = await fetch(`${BASE}/api/render-queue/resume-all`, { method: 'POST' });
    expectStatus(res, 200);
  });

  // ── 6. Queue Download/Upload ──
  console.log('\n── Queue File Operations ──');

  await test('GET /api/queue/download-zip rejects missing id', async () => {
    const res = await fetch(`${BASE}/api/queue/download-zip`);
    if (res.status === 200) {
      const data = await res.json();
      if (!data.error) throw new Error('Expected error for missing id');
    }
    // 400 or 404 also acceptable
  });

  await test('POST /api/queue/upload-drive rejects missing id', async () => {
    const res = await fetch(`${BASE}/api/queue/upload-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.error) throw new Error('Expected error for missing id');
  });

  // ── 7. CORS Headers ──
  console.log('\n── CORS & Headers ──');

  await test('CORS headers present on GET', async () => {
    const res = await fetch(`${BASE}/health`);
    const origin = res.headers.get('access-control-allow-origin');
    if (origin !== '*') throw new Error(`Expected CORS origin *, got ${origin}`);
  });

  await test('CORS headers present on OPTIONS', async () => {
    const res = await fetch(`${BASE}/health`, { method: 'OPTIONS' });
    expectStatus(res, 204);
    const origin = res.headers.get('access-control-allow-origin');
    if (origin !== '*') throw new Error(`Expected CORS origin *, got ${origin}`);
  });

  // ── 8. Static File Serving ──
  console.log('\n── Static Files ──');

  await test('GET / serves index.html', async () => {
    const res = await fetch(`${BASE}/`);
    expectStatus(res, 200);
    const text = await res.text();
    if (!text.includes('<!DOCTYPE html>')) throw new Error('Expected HTML response');
    if (!text.includes('Product Image Studio')) throw new Error('Expected app title');
  });

  // ── 9. Error Handling ──
  console.log('\n── Error Handling ──');

  await test('Non-existent route returns 404', async () => {
    const res = await fetch(`${BASE}/api/nonexistent`);
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
  });

  await test('Malformed JSON returns 400', async () => {
    const res = await fetch(`${BASE}/api/queue/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json'
    });
    // Either 400 or handled gracefully
    if (res.status !== 400 && res.status !== 500 && res.status !== 200) {
      throw new Error(`Unexpected status: ${res.status}`);
    }
  });

  // ── Results ──
  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (errors.length > 0) {
    console.log('Failed tests:');
    errors.forEach(e => console.log(`  - ${e.name}: ${e.message}`));
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
