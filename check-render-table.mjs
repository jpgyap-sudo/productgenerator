import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});

async function main() {
  // Try inserting with minimal columns
  const { data, error } = await supabase
    .from('render_results')
    .insert({
      queue_item_id: 666666,
      view_id: 'front',
      status: 'done',
      image_url: 'https://example.com/test.png'
    })
    .select();

  if (error) {
    console.error('Error:', error.message);
    // Try without select
    const { error: e2 } = await supabase
      .from('render_results')
      .insert({
        queue_item_id: 666666,
        view_id: 'front',
        status: 'done',
        image_url: 'https://example.com/test.png'
      });
    if (e2) {
      console.error('Error2:', e2.message);
    } else {
      // Fetch to see columns
      const { data: d } = await supabase.from('render_results').select('*').eq('queue_item_id', 666666).limit(1);
      if (d && d.length > 0) {
        console.log('Columns:', Object.keys(d[0]));
        console.log('Row:', JSON.stringify(d[0], null, 2));
      }
    }
  } else {
    console.log('Columns:', Object.keys(data[0]));
    console.log('Row:', JSON.stringify(data[0], null, 2));
  }

  // Cleanup
  await supabase.from('render_results').delete().eq('queue_item_id', 666666);
}

main().catch(console.error);
