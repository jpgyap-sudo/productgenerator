#!/usr/bin/env node
// Load .env FIRST before any imports
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

// Now import supabase (it reads process.env which is now populated)
const { supabase } = await import('./lib/supabase.js');

const { data, error } = await supabase.from('product_queue').select('*').limit(1);
if (error) {
  console.log('ERROR:', JSON.stringify(error, null, 2));
  process.exit(1);
}
if (data && data.length > 0) {
  console.log('Columns:', Object.keys(data[0]).join(', '));
} else {
  console.log('Table exists but is empty');
  const { data: ins, error: insErr } = await supabase
    .from('product_queue')
    .insert({ id: 999999, name: 'test', status: 'wait' })
    .select();
  if (insErr) {
    console.log('Insert error:', insErr.message);
  } else {
    console.log('Inserted, columns:', Object.keys(ins[0]).join(', '));
    await supabase.from('product_queue').delete().eq('id', 999999);
  }
}
