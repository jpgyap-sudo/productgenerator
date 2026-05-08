import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});

const TEST_ID = 777777;
const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('=== END-TO-END DRIVE UPLOAD TEST ===\n');

  // Step 1: Insert a test item into product_queue
  console.log('1. Inserting test item into product_queue...');
  const { data: insertData, error: insertError } = await supabase
    .from('product_queue')
    .insert({
      id: TEST_ID,
      name: 'E2E_Test_Product',
      image_url: 'https://picsum.photos/1024',
      status: 'completed',
      description: 'End-to-end test for Google Drive upload'
    })
    .select();

  if (insertError) {
    console.error('❌ Insert failed:', insertError.message);
    process.exit(1);
  }
  console.log('✅ Test item inserted with id:', TEST_ID);

  // Step 2: Insert completed render rows into render_results table
  console.log('\n2. Inserting completed render rows into render_results...');
  const views = [
    { view_id: 'front', label: 'Front View' },
    { view_id: 'back', label: 'Back View' },
    { view_id: 'left', label: 'Left View' },
    { view_id: 'right', label: 'Right View' }
  ];

  for (const view of views) {
    const { error: viewError } = await supabase
      .from('render_results')
      .insert({
        queue_item_id: TEST_ID,
        view_id: view.view_id,
        label: view.label,
        status: 'done',
        image_url: 'https://picsum.photos/1024',
        provider: 'openai'
      });

    if (viewError) {
      console.error(`❌ Failed to insert view ${view.view_id}:`, viewError.message);
    } else {
      console.log(`   ✅ Inserted view: ${view.view_id}`);
    }
  }

  // Step 3: Call the Drive upload API
  console.log('\n3. Calling Drive upload API...');
  try {
    const response = await fetch(`${BASE_URL}/api/queue/upload-drive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: TEST_ID })
    });

    const result = await response.json();
    console.log('   Response status:', response.status);
    console.log('   Response:', JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('✅ Drive upload API succeeded!');
    } else if (result.archived) {
      console.log('ℹ️ Item was archived, fallback used:', result.message);
    } else {
      console.log('❌ Drive upload API failed:', result.error || result.message);
    }
  } catch (err) {
    console.error('❌ API call failed:', err.message);
  }

  // Step 4: Check the item's drive upload state in Supabase
  console.log('\n4. Checking drive upload state in Supabase...');
  await new Promise(r => setTimeout(r, 3000)); // Wait for async updates

  const { data: itemData, error: itemError } = await supabase
    .from('product_queue')
    .select('*')
    .eq('id', TEST_ID)
    .single();

  if (itemError) {
    console.error('❌ Failed to fetch item:', itemError.message);
  } else if (itemData) {
    console.log('   Item state:');
    console.log(`   - status: ${itemData.status}`);
    console.log(`   - drive_folder_id: ${itemData.drive_folder_id || '❌ NOT SET'}`);
    console.log(`   - drive_folder_name: ${itemData.drive_folder_name || '❌ NOT SET'}`);
    console.log(`   - drive_folder_url: ${itemData.drive_folder_url || '❌ NOT SET'}`);
    console.log(`   - drive_upload_status: ${itemData.drive_upload_status || '❌ NOT SET'}`);
    console.log(`   - drive_upload_done: ${itemData.drive_upload_done}/${itemData.drive_upload_total}`);

    if (itemData.drive_folder_url) {
      console.log('\n✅ DRIVE UPLOAD FULLY FUNCTIONAL!');
      console.log(`   Folder URL: ${itemData.drive_folder_url}`);
    } else {
      console.log('\n❌ Drive upload did not save folder info');
    }
  }

  // Step 5: Clean up test data
  console.log('\n5. Cleaning up test data...');
  await supabase.from('render_results').delete().eq('queue_item_id', TEST_ID);
  await supabase.from('product_queue').delete().eq('id', TEST_ID);
  console.log('✅ Test data cleaned up');

  console.log('\n=== TEST COMPLETE ===');
}

main().catch(console.error);
