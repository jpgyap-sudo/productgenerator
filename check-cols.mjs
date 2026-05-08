import 'dotenv/config';
import { supabase } from './lib/supabase.js';

async function test() {
  // Insert a test row to discover columns
  const { data: insData, error: insError } = await supabase
    .from('product_queue')
    .insert({ id: 999999, name: '__schema_test__', status: 'wait', image_url: 'https://example.com/test.jpg' })
    .select();
  if (insError) {
    console.log('Insert error:', JSON.stringify(insError));
    return;
  }
  console.log('Inserted columns:', Object.keys(insData[0]).join(', '));
  console.log('Full row:', JSON.stringify(insData[0], null, 2));
  // Clean up
  await supabase.from('product_queue').delete().eq('id', 999999);
}
test().catch(e => console.log('Exception:', e.message));
