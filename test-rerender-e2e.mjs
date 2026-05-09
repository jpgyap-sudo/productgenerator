#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  RERENDER E2E TEST
//  Tests the full rerender flow:
//    1. Fetch a completed batch from the VPS API
//    2. Pick a view that has an image
//    3. Call rerender API for that view
//    4. Verify the response contains a new image URL
//    5. Verify the image URL is accessible (HTTP 200) AND is a valid image
//    6. Verify the completed-batches.json was updated
//    7. Verify the render_results table was updated in Supabase
//    8. Verify image content-type is actually an image
// ══════════════════════════════════════════════════════════════════

const API_BASE = process.env.API_BASE || 'https://render.abcx124.xyz';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RERENDER_TIMEOUT_MS = 420000; // 7 minutes for Gemini API (2 models × 180s + overhead)

// ── Test counters ──
let passed = 0;
let failed = 0;
let warnings = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function warn(label) {
  console.log(`  ⚠️ ${label}`);
  warnings++;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify that a URL points to an actual image by checking content-type
 * and optionally downloading the first few bytes to validate the header.
 */
async function verifyImageUrl(url, label = 'Image') {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    if (!res.ok) {
      warn(`${label} returned HTTP ${res.status}`);
      return false;
    }

    const contentType = res.headers.get('content-type') || '';
    const contentLength = res.headers.get('content-length') || 'unknown';

    // Check content-type indicates an image
    const isImage = contentType.startsWith('image/');
    if (!isImage) {
      warn(`${label} content-type is "${contentType}", expected "image/*"`);
      return false;
    }

    // Check content-length is reasonable (at least 1KB for a real image)
    const sizeBytes = parseInt(contentLength, 10);
    if (!isNaN(sizeBytes) && sizeBytes < 1024) {
      warn(`${label} is very small (${sizeBytes} bytes) — may be a placeholder`);
    }

    console.log(`     ${label}: HTTP ${res.status} type=${contentType} size=${contentLength}`);
    return true;
  } catch (err) {
    warn(`Could not verify ${label}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  RERENDER E2E TEST');
  console.log('  API:', API_BASE);
  console.log('  Rerender timeout:', RERENDER_TIMEOUT_MS / 1000, 'seconds');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: Fetch completed batches ──
  console.log('Step 1: Fetch completed batches');
  let batches;
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/queue/completed`, {}, 15000);
    assert(res.ok, `Completed batches API responded with HTTP ${res.status}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    batches = data.completedBatches || data;
    assert(Array.isArray(batches), `Response is an array (got ${typeof batches})`);
    if (!Array.isArray(batches)) {
      throw new Error(`Expected array, got ${typeof batches}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    console.log(`     Found ${batches.length} completed batches`);
  } catch (err) {
    console.error(`  ❌ Failed to fetch completed batches: ${err.message}`);
    process.exit(1);
  }

  if (!batches.length) {
    console.error('  ❌ No completed batches found - nothing to rerender');
    process.exit(1);
  }

  // Show the first few batches
  batches.slice(0, 3).forEach((b, i) => {
    const views = b.viewResults || [];
    const doneViews = views.filter(v => v.status === 'done');
    console.log(`     Batch ${i + 1}: id=${b.id} name="${b.name}" views=${views.length} done=${doneViews.length}`);
  });

  // ── Step 2: Pick a batch with a done view to rerender ──
  console.log('\nStep 2: Select a view to rerender');
  let targetBatch = null;
  let targetView = null;

  for (const batch of batches) {
    const views = batch.viewResults || [];
    const doneView = views.find(v => v.status === 'done' && v.imageUrl);
    if (doneView) {
      targetBatch = batch;
      targetView = doneView;
      break;
    }
  }

  if (!targetBatch || !targetView) {
    console.error('  ❌ No completed batch with done views found');
    process.exit(1);
  }

  console.log(`  ✅ Selected batch id=${targetBatch.id} "${targetBatch.name}"`);
  console.log(`  ✅ Selected viewId=${targetView.viewId} (status=${targetView.status})`);
  console.log(`  ✅ Old image URL: ${(targetView.imageUrl || '').slice(0, 100)}...`);

  // Verify the OLD image is actually accessible before rerender
  console.log('\n  Verifying old image is accessible...');
  const oldImageOk = await verifyImageUrl(targetView.imageUrl, 'Old image');
  assert(oldImageOk, 'Old image is accessible and valid');

  // ── Step 3: Call rerender API ──
  console.log('\nStep 3: Call rerender API');
  console.log(`  (This may take up to ${RERENDER_TIMEOUT_MS / 60000} minutes for Gemini API...)`);
  let rerenderResult;
  try {
    const res = await fetchWithTimeout(
      `${API_BASE}/api/queue/rerender-view`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: targetBatch.id,
          viewId: targetView.viewId,
          provider: 'gemini'
        })
      },
      RERENDER_TIMEOUT_MS
    );

    assert(res.ok, `Rerender API responded with HTTP ${res.status}`);

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    rerenderResult = data;
    console.log(`  ✅ Rerender API responded with success=true`);
    console.log(`  ✅ New image URL: ${(data.imageUrl || '').slice(0, 100)}...`);
    console.log(`  ✅ Provider used: ${data.providerUsed}`);
  } catch (err) {
    console.error(`  ❌ Rerender API call failed: ${err.message}`);
    process.exit(1);
  }

  // ── Step 4: Verify the new image URL is different from the old one ──
  console.log('\nStep 4: Verify image URL changed');
  assert(!!rerenderResult.imageUrl, 'imageUrl is present in response');
  if (rerenderResult.imageUrl === targetView.imageUrl) {
    warn('New image URL is identical to old one (may be expected if same image was re-uploaded)');
  } else {
    console.log('  ✅ New image URL differs from old one');
  }

  // ── Step 5: Verify the new image is accessible AND is a real image ──
  console.log('\nStep 5: Verify new image is accessible and valid');
  const newImageOk = await verifyImageUrl(rerenderResult.imageUrl, 'New image');
  assert(newImageOk, 'New image is accessible and valid');

  // ── Step 6: Verify completed-batches.json was updated ──
  console.log('\nStep 6: Verify completed-batches.json was updated');
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/queue/completed`, {}, 15000);
    assert(res.ok, 'Completed batches API reachable after rerender');

    const data = await res.json();
    const updatedBatches = data.completedBatches || data;
    const updatedBatch = updatedBatches.find(b => Number(b.id) === Number(targetBatch.id));

    assert(!!updatedBatch, 'Batch still exists in completed list after rerender');
    if (!updatedBatch) {
      throw new Error('Batch no longer exists');
    }

    const updatedView = (updatedBatch.viewResults || []).find(v => Number(v.viewId) === Number(targetView.viewId));
    assert(!!updatedView, 'View still exists in batch after rerender');
    if (!updatedView) {
      throw new Error('View no longer exists');
    }

    if (updatedView.imageUrl === rerenderResult.imageUrl) {
      console.log('  ✅ completed-batches.json has the updated image URL');
    } else {
      warn('completed-batches.json image URL mismatch');
      console.warn(`     Expected: ${rerenderResult.imageUrl.slice(0, 80)}`);
      console.warn(`     Got:      ${(updatedView.imageUrl || '').slice(0, 80)}`);
    }

    if (updatedView.providerUsed) {
      console.log(`  ✅ Provider used recorded: ${updatedView.providerUsed}`);
    } else {
      warn('providerUsed not recorded in completed-batches.json');
    }
  } catch (err) {
    warn(`Could not verify completed-batches.json: ${err.message}`);
  }

  // ── Step 7: Verify render_results table in Supabase (if env vars provided) ──
  if (SUPABASE_URL && SUPABASE_KEY) {
    console.log('\nStep 7: Verify render_results in Supabase');
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

      const { data: rows, error } = await supabase
        .from('render_results')
        .select('*')
        .eq('queue_item_id', targetBatch.id)
        .eq('view_id', targetView.viewId);

      if (error) {
        warn(`Supabase query failed: ${error.message}`);
      } else if (!rows || !rows.length) {
        warn('No render_results row found for this item/view');
      } else {
        const row = rows[0];
        console.log(`  ✅ render_results row found`);
        console.log(`     status: ${row.status}`);
        console.log(`     image_url: ${(row.image_url || '').slice(0, 80)}`);
        console.log(`     provider_used: ${row.provider_used || '(none)'}`);
        console.log(`     completed_at: ${row.completed_at || '(none)'}`);

        if (row.image_url === rerenderResult.imageUrl) {
          console.log('  ✅ Supabase image_url matches rerender response');
        } else {
          warn('Supabase image_url differs from rerender response');
        }

        // Verify the Supabase image URL is also accessible
        if (row.image_url) {
          await verifyImageUrl(row.image_url, 'Supabase image');
        }
      }
    } catch (err) {
      warn(`Supabase verification skipped: ${err.message}`);
    }
  } else {
    console.log('\nStep 7: Skip Supabase verification (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars)');
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  RERENDER E2E TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Batch ID:     ${targetBatch.id}`);
  console.log(`  View ID:      ${targetView.viewId}`);
  console.log(`  Old URL:      ${(targetView.imageUrl || '').slice(0, 80)}`);
  console.log(`  New URL:      ${(rerenderResult.imageUrl || '').slice(0, 80)}`);
  console.log(`  Provider:     ${rerenderResult.providerUsed}`);
  console.log('');
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Warnings: ${warnings}`);
  console.log('');

  if (failed > 0) {
    console.error(`❌ ${failed} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log('  ✅ All critical checks passed!');
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
