import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});

async function main() {
  // Check columns by selecting from product_queue
  const { data, error } = await supabase
    .from('product_queue')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Query error:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
    console.log('Existing columns:', Object.keys(data[0]));
  } else {
    console.log('No rows found, trying to insert a test row...');
    const { data: insertData, error: insertError } = await supabase
      .from('product_queue')
      .insert({
        id: 888888,
        name: 'verify-cols-test',
        image_url: 'https://example.com/test.png',
        status: 'pending',
        description: 'test'
      })
      .select();

    if (insertError) {
      console.error('Insert error:', insertError.message);
      process.exit(1);
    }

    console.log('Inserted test row. Columns:', Object.keys(insertData[0]));

    // Clean up
    await supabase.from('product_queue').delete().eq('id', 888888);
  }

  // Also check app_config for drive_folder_counter
  const { data: configData, error: configError } = await supabase
    .from('app_config')
    .select('*')
    .eq('key', 'drive_folder_counter');

  if (configError) {
    console.error('Config query error:', configError.message);
  } else {
    console.log('drive_folder_counter:', configData);
  }
}

main().catch(console.error);
