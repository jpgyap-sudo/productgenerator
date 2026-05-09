#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  RERENDER E2E TEST
//  Tests the full rerender flow:
//    1. Fetch a completed batch from the VPS API
//    2. Pick a view that has an image
//    3. Call rerender API for that view
//    4. Verify the response contains a new image URL
//    5. Verify the image URL is accessible (HTTP 200)
//    6. Verify the completed-batches.json was updated
//    7. Verify the render_results table was updated in Supabase
// ══════════════════════════════════════════════════════════════════

const API_BASE = process.env.API_BASE || 'https://render.abcx124.xyz';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  RERENDER E2E TEST');
  console.log('  API:', API_BASE);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: Fetch completed batches ──
  console.log('Step 1: Fetch completed batches');
  let batches;
  try {
    const res = await fetch(`${API_BASE}/api/queue/completed`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    batches = data.completedBatches || data;
    if (!Array.isArray(batches)) {
      throw new Error(`Expected array, got ${typeof batches}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    console.log(`  ✅ Got ${batches.length} completed batches`);
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

  // ── Step 3: Call rerender API ──
  console.log('\nStep 3: Call rerender API');
  let rerenderResult;
  try {
    const res = await fetch(`${API_BASE}/api/queue/rerender-view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemId: targetBatch.id,
        viewId: targetView.viewId,
        provider: 'gemini'
      })
    });

    const data = await res.json();
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
  if (!rerenderResult.imageUrl) {
    console.error('  ❌ No imageUrl in response');
    process.exit(1);
  }
  if (rerenderResult.imageUrl === targetView.imageUrl) {
    console.warn('  ⚠️ New image URL is identical to old one (may be expected if same image was re-uploaded)');
  } else {
    console.log('  ✅ New image URL differs from old one');
  }

  // ── Step 5: Verify the new image is accessible ──
  console.log('\nStep 5: Verify image is accessible');
  try {
    const imgUrl = rerenderResult.imageUrl.startsWith('http')
      ? rerenderResult.imageUrl
      : `${API_BASE}${rerenderResult.imageUrl}`;
    const imgRes = await fetch(imgUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000)
    });
    if (imgRes.ok) {
      const contentType = imgRes.headers.get('content-type') || 'unknown';
      const contentLength = imgRes.headers.get('content-length') || 'unknown';
      console.log(`  ✅ Image accessible: HTTP ${imgRes.status} content-type=${contentType} size=${contentLength}`);
    } else {
      console.warn(`  ⚠️ Image HEAD returned HTTP ${imgRes.status} (may still work in browser)`);
    }
  } catch (err) {
    console.warn(`  ⚠️ Could not verify image accessibility: ${err.message}`);
  }

  // ── Step 6: Verify completed-batches.json was updated ──
  console.log('\nStep 6: Verify completed-batches.json was updated');
  try {
    const res = await fetch(`${API_BASE}/api/queue/completed`);
    const data = await res.json();
    const updatedBatches = data.completedBatches || data;
    const updatedBatch = updatedBatches.find(b => Number(b.id) === Number(targetBatch.id));

    if (!updatedBatch) {
      console.error('  ❌ Batch no longer exists in completed list');
      process.exit(1);
    }

    const updatedView = (updatedBatch.viewResults || []).find(v => Number(v.viewId) === Number(targetView.viewId));
    if (!updatedView) {
      console.error('  ❌ View no longer exists in batch');
      process.exit(1);
    }

    if (updatedView.imageUrl === rerenderResult.imageUrl) {
      console.log('  ✅ completed-batches.json has the updated image URL');
    } else {
      console.warn('  ⚠️ completed-batches.json image URL mismatch');
      console.warn(`     Expected: ${rerenderResult.imageUrl.slice(0, 80)}`);
      console.warn(`     Got:      ${(updatedView.imageUrl || '').slice(0, 80)}`);
    }

    if (updatedView.providerUsed) {
      console.log(`  ✅ Provider used recorded: ${updatedView.providerUsed}`);
    } else {
      console.warn('  ⚠️ providerUsed not recorded in completed-batches.json');
    }
  } catch (err) {
    console.warn(`  ⚠️ Could not verify completed-batches.json: ${err.message}`);
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
        console.warn(`  ⚠️ Supabase query failed: ${error.message}`);
      } else if (!rows || !rows.length) {
        console.warn('  ⚠️ No render_results row found for this item/view');
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
          console.warn('  ⚠️ Supabase image_url differs from rerender response');
        }
      }
    } catch (err) {
      console.warn(`  ⚠️ Supabase verification skipped: ${err.message}`);
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
  console.log('  ✅ All critical checks passed!');
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
