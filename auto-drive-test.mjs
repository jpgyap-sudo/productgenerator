#!/usr/bin/env node
/**
 * Autonomous Drive Upload Test Loop
 * 
 * Discovers the render_results schema, adapts the test, runs it,
 * and loops until Drive upload works end-to-end.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});

const BASE_URL = 'http://localhost:3000';
const TEST_ID = 777777;
const MAX_RETRIES = 5;

// View IDs as integers (matching the DB schema)
const VIEWS = [
  { view_id: 1, label: 'Front View' },
  { view_id: 2, label: 'Back View' },
  { view_id: 3, label: 'Left View' },
  { view_id: 4, label: 'Right View' }
];

async function discoverRenderColumns() {
  console.log('\n[1/5] Discovering render_results schema...');
  
  // First insert a parent queue item to satisfy FK constraint
  const { error: parentError } = await supabase
    .from('product_queue')
    .insert({
      id: 666666,
      name: 'schema-discovery',
      image_url: 'https://example.com/test.png',
      status: 'completed',
      description: 'temp'
    });

  if (parentError) {
    console.error('  ❌ Cannot insert parent:', parentError.message);
    return null;
  }

  // Try inserting with integer view_id
  const testInsert = {
    queue_item_id: 666666,
    view_id: 1,
    status: 'done',
    image_url: 'https://example.com/test.png'
  };

  const { data, error } = await supabase
    .from('render_results')
    .insert(testInsert)
    .select();

  if (error) {
    // Try without select
    const { error: e2 } = await supabase
      .from('render_results')
      .insert(testInsert);
    
    if (e2) {
      console.error('  ❌ Cannot insert into render_results:', e2.message);
      await supabase.from('product_queue').delete().eq('id', 666666);
      return null;
    }
    
    // Fetch to see columns
    const { data: d } = await supabase
      .from('render_results')
      .select('*')
      .eq('queue_item_id', 666666)
      .limit(1);
    
    await supabase.from('render_results').delete().eq('queue_item_id', 666666);
    await supabase.from('product_queue').delete().eq('id', 666666);
    
    if (d && d.length > 0) {
      console.log('  ✅ Discovered columns:', Object.keys(d));
      console.log('  ✅ Sample row:', JSON.stringify(d[0], null, 2));
      return d[0];
    }
    return null;
  }

  await supabase.from('render_results').delete().eq('queue_item_id', 666666);
  await supabase.from('product_queue').delete().eq('id', 666666);
  
  if (data && data.length > 0) {
    console.log('  ✅ Discovered columns:', Object.keys(data[0]));
    console.log('  ✅ Sample row:', JSON.stringify(data[0], null, 2));
    return data[0];
  }
  return null;
}

async function runTest(columns) {
  console.log('\n[2/5] Setting up test data...');

  // Clean up any leftover test data
  await supabase.from('render_results').delete().eq('queue_item_id', TEST_ID);
  await supabase.from('product_queue').delete().eq('id', TEST_ID);

  // Insert test item
  const { error: insertError } = await supabase
    .from('product_queue')
    .insert({
      id: TEST_ID,
      name: 'E2E_Test_Product',
      image_url: 'https://picsum.photos/1024',
      status: 'completed',
      description: 'End-to-end test for Google Drive upload'
    });

  if (insertError) {
    console.error('  ❌ Insert item failed:', insertError.message);
    return false;
  }
  console.log('  ✅ Test item inserted');

  // Build insert payload based on discovered columns
  const knownCols = Object.keys(columns);

  for (const view of VIEWS) {
    const payload = {
      queue_item_id: TEST_ID,
      view_id: view.view_id,
      status: 'done',
      image_url: 'https://picsum.photos/1024'
    };
    
    // Only add columns that exist
    if (knownCols.includes('label')) payload.label = view.label;
    if (knownCols.includes('provider')) payload.provider = 'openai';

    const { error: viewError } = await supabase
      .from('render_results')
      .insert(payload);

    if (viewError) {
      console.error(`  ❌ Insert view ${view.view_id} failed:`, viewError.message);
      return false;
    }
    console.log(`  ✅ Inserted view: ${view.view_id} (${view.label})`);
  }

  // Call Drive upload API
  console.log('\n[3/5] Calling Drive upload API...');
  
  try {
    const response = await fetch(`${BASE_URL}/api/queue/upload-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: TEST_ID })
    });

    const result = await response.json();
    console.log('  Response status:', response.status);
    console.log('  Response:', JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('\n✅ DRIVE UPLOAD SUCCEEDED!');
      if (result.folderUrl) {
        console.log(`   Folder URL: ${result.folderUrl}`);
      }
      return true;
    } else if (result.alreadyUploaded) {
      console.log('\n✅ Already uploaded (previous test)');
      return true;
    } else {
      console.log('\n❌ Drive upload failed:', result.error || result.message);
      return false;
    }
  } catch (err) {
    console.error('\n❌ API call failed:', err.message);
    return false;
  }
}

async function verifyState() {
  console.log('\n[4/5] Verifying Drive state in Supabase...');
  await new Promise(r => setTimeout(r, 2000));

  const { data, error } = await supabase
    .from('product_queue')
    .select('*')
    .eq('id', TEST_ID)
    .single();

  if (error) {
    console.error('  ❌ Fetch failed:', error.message);
    return false;
  }

  console.log('  Item state:');
  console.log(`   - status: ${data.status}`);
  console.log(`   - drive_folder_id: ${data.drive_folder_id || '❌ NOT SET'}`);
  console.log(`   - drive_folder_name: ${data.drive_folder_name || '❌ NOT SET'}`);
  console.log(`   - drive_folder_url: ${data.drive_folder_url || '❌ NOT SET'}`);
  console.log(`   - drive_upload_status: ${data.drive_upload_status}`);
  console.log(`   - drive_upload_done: ${data.drive_upload_done}/${data.drive_upload_total}`);

  if (data.drive_folder_url) {
    console.log('\n✅ STATE VERIFIED - Drive info saved in Supabase!');
    return true;
  }
  return false;
}

async function cleanup() {
  console.log('\n[5/5] Cleaning up test data...');
  await supabase.from('render_results').delete().eq('queue_item_id', TEST_ID);
  await supabase.from('product_queue').delete().eq('id', TEST_ID);
  console.log('  ✅ Cleanup complete');
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  AUTONOMOUS DRIVE UPLOAD TEST LOOP      ║');
  console.log('╚══════════════════════════════════════════╝');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ATTEMPT ${attempt}/${MAX_RETRIES}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Step 1: Discover schema
    const columns = await discoverRenderColumns();
    if (!columns) {
      console.log('  ⏳ Cannot discover schema, retrying in 3s...');
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    // Step 2-3: Run test
    const testPassed = await runTest(columns);
    
    // Step 4: Verify state
    const stateVerified = await verifyState();

    // Step 5: Cleanup
    await cleanup();

    if (testPassed && stateVerified) {
      console.log('\n╔══════════════════════════════════════════╗');
      console.log('║  ✅ ALL TESTS PASSED!                    ║');
      console.log('║  Google Drive upload is fully functional ║');
      console.log('╚══════════════════════════════════════════╝');
      process.exit(0);
    }

    if (attempt < MAX_RETRIES) {
      console.log(`\n  ⏳ Test failed, waiting 5s before retry ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log('\n❌ All attempts exhausted. Drive upload test failed.');
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
