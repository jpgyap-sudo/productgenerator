import { config } from 'dotenv';
config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const projectRef = supabaseUrl.match(/https:\/\/(.+)\.supabase\.co/)?.[1];

async function run() {
  // Try the Supabase Management API with service_role key
  console.log('Trying Management API with service_role key...');
  
  // Try to list projects (this will likely fail, but shows if the key works)
  try {
    const response = await fetch('https://api.supabase.com/v1/projects', {
      headers: {
        'Authorization': `Bearer ${supabaseKey}`
      }
    });
    console.log('List projects status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 300));
  } catch (e) {
    console.log('Failed:', e.message);
  }
  
  // Try to run SQL via Management API
  console.log('\nTrying to run SQL via Management API...');
  const sql = [
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_id TEXT DEFAULT '';",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_name TEXT DEFAULT '';",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_url TEXT DEFAULT '';",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_status TEXT DEFAULT '';",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_done INTEGER DEFAULT 0;",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_total INTEGER DEFAULT 0;",
    "ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_error TEXT DEFAULT '';",
    "INSERT INTO public.app_config (key, value, updated_at) VALUES ('drive_folder_counter', '1', NOW()) ON CONFLICT (key) DO NOTHING;"
  ].join('\n');
  
  try {
    const sqlResponse = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({ query: sql })
    });
    console.log('SQL status:', sqlResponse.status);
    const sqlText = await sqlResponse.text();
    console.log('Response:', sqlText.substring(0, 500));
    
    if (sqlResponse.ok) {
      console.log('\nMigration completed successfully!');
      return;
    }
  } catch (e) {
    console.log('Failed:', e.message);
  }
  
  // If all else fails, provide manual instructions
  console.log('\n' + '='.repeat(60));
  console.log('MANUAL MIGRATION REQUIRED');
  console.log('='.repeat(60));
  console.log('Please run this SQL in the Supabase Dashboard:');
  console.log('https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
  console.log('\n' + sql);
}

run().catch(console.error);
