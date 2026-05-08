import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } });

const { data, error } = await supabase.from('product_queue').select('id, name, status, provider').eq('id', 777781).single();
if (error) console.error('Error:', error.message);
else console.log('Item 777781:', JSON.stringify(data, null, 2));

// Also check how many items are in active/wait status
const { data: activeItems, error: activeError } = await supabase
  .from('product_queue')
  .select('id, name, status')
  .in('status', ['active', 'wait'])
  .limit(10);
if (activeError) console.error('Active items error:', activeError.message);
else console.log('Active/wait items:', JSON.stringify(activeItems, null, 2));
