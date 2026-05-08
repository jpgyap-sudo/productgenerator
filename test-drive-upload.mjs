import 'dotenv/config';
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from './lib/supabase.js';
import { uploadRendersToDrive, getNextFolderCounter } from './lib/drive.js';
import { VIEWS } from './lib/fal.js';

const TEST_ITEM_ID = 888888;

async function testDriveUpload() {
  console.log('=== Testing Google Drive Upload ===\n');

  // 1. Check if GOOGLE_SERVICE_ACCOUNT_JSON is set
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log('❌ GOOGLE_SERVICE_ACCOUNT_JSON is NOT set');
    return;
  }
  console.log('✅ GOOGLE_SERVICE_ACCOUNT_JSON is set');

  // 2. Get the next folder counter
  try {
    const counter = await getNextFolderCounter();
    console.log(`✅ Next folder counter: ${counter}`);
  } catch (err) {
    console.log(`❌ getNextFolderCounter failed: ${err.message}`);
    return;
  }

  // 3. Test upload with sample data
  const testViews = VIEWS.map(v => ({
    viewId: v.id,
    viewLabel: v.label,
    imageUrl: 'https://v3.fal.media/files/panda/3x4kf5kRj8vqFzYz9k9k9k_test_image.png'  // placeholder
  }));

  console.log(`\nTest views: ${testViews.length}`);
  console.log('Views:', testViews.map(v => `${v.viewId}: ${v.viewLabel}`).join(', '));

  // 4. Try the actual upload
  console.log('\nAttempting Drive upload...');
  try {
    const result = await uploadRendersToDrive(TEST_ITEM_ID, 'Test_Product', testViews, {
      folderName: '999_Test_Product',
      onProgress: (progress) => {
        console.log(`  Progress: ${progress.status} ${progress.uploaded}/${progress.total} - ${progress.message}`);
      }
    });
    console.log(`\n✅ Drive upload SUCCESS!`);
    console.log(`  Folder ID: ${result.folderId}`);
    console.log(`  Folder Name: ${result.folderName}`);
    console.log(`  Folder URL: ${result.folderUrl}`);
    console.log(`  Files uploaded: ${result.files.length}`);
    result.files.forEach(f => console.log(`    - ${f.name}: ${f.webViewLink || f.id}`));
  } catch (err) {
    console.log(`\n❌ Drive upload FAILED: ${err.message}`);
    console.log(err.stack);
  }
}

testDriveUpload().catch(e => console.error('Fatal:', e));
