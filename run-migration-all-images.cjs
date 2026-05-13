// Run migration: add all_images column to batch_jobs table
const { Client } = require('pg');

const supabaseUrl = process.env.SUPABASE_URL || 'https://rbhfkwwnpmytmwueajje.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJiaGZrd3ducG15dG13dWVhamplIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Nzk3MzMyMSwiZXhwIjoyMDkzNTQ5MzIxfQ.MiEQFI3JGd8swPOuyQXlxj6vWjMS3gl44140pNe6Dig';

const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '').trim();
const encodedKey = encodeURIComponent(supabaseKey);

async function run() {
  console.log('Running migration: add all_images column to batch_jobs...');
  console.log('Project ref:', projectRef);
  
  const configs = [
    { cs: 'postgresql://postgres.' + projectRef + ':' + encodedKey + '@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres', label: 'Session pooler (5432) encoded' },
    { cs: 'postgresql://postgres.' + projectRef + ':' + encodedKey + '@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres', label: 'Transaction pooler (6543) encoded' },
    { cs: 'postgresql://postgres.' + projectRef + ':' + supabaseKey + '@db.' + projectRef + '.supabase.co:5432/postgres', label: 'Direct DB' },
  ];
  
  let client = null;
  for (const cfg of configs) {
    try {
      console.log('Trying ' + cfg.label + '...');
      const c = new Client({ connectionString: cfg.cs, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
      await c.connect();
      console.log('Connected via ' + cfg.label);
      client = c;
      break;
    } catch (err) {
      console.log(cfg.label + ' failed: ' + (err.message || '').substring(0, 150));
    }
  }
  
  if (!client) {
    console.log('\nCould not connect to database via any method');
    console.log('\n=== MANUAL STEP REQUIRED ===');
    console.log('Please run this SQL in the Supabase Dashboard SQL Editor:');
    console.log('  ALTER TABLE IF EXISTS public.batch_jobs');
    console.log("    ADD COLUMN IF NOT EXISTS all_images JSONB DEFAULT '[]'::jsonb;");
    console.log('Dashboard: https://supabase.com/dashboard/project/' + projectRef);
    return;
  }
  
  try {
    console.log('\nAdding all_images column...');
    await client.query(`
      ALTER TABLE IF EXISTS public.batch_jobs 
      ADD COLUMN IF NOT EXISTS all_images JSONB DEFAULT '[]'::jsonb;
    `);
    console.log('Migration SQL executed successfully!');
    
    const { rows } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'batch_jobs'
      ORDER BY ordinal_position;
    `);
    console.log('\nColumns in batch_jobs:');
    rows.forEach(r => console.log('  ' + r.column_name + ': ' + r.data_type));
    
    console.log('\nMigration complete!');
  } catch (err) {
    console.log('Migration failed: ' + (err.message || ''));
  } finally {
    await client.end();
  }
}

run().catch(console.error);
