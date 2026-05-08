import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws }
});
const { data, error } = await supabase.from('product_queue').select('*').limit(1);
if (error) console.error('Error:', error.message);
else {
  console.log('Columns in product_queue:');
  Object.keys(data[0]).forEach(k => console.log(' -', k));
}
