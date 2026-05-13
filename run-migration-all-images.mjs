// Run migration: add all_images column to batch_jobs table
// Uses Supabase client with service role key
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL || 'https://rbhfkwwnpmytmwueajje.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJiaGZrd3ducG15dG13dWVhamplIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Nzk3MzMyMSwiZXhwIjoyMDkzNTQ5MzIxfQ.MiEQFI3JGd8swPOuyQXlxj6vWjMS3gl44140pNe6Dig';

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

async function run() {
  console.log('Running migration: add all_images column to batch_jobs...');
  
  // Method 1: Try using the /rest/v1/sql endpoint
  try {
    const sqlUrl = supabaseUrl + '/rest/v1/sql';
    console.log('Trying SQL endpoint:', sqlUrl);
    
    const response = await fetch(sqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'params=single-object'
      },
      body: JSON.stringify({
        query: "ALTER TABLE IF EXISTS public.batch_jobs ADD COLUMN IF NOT EXISTS all_images JSONB DEFAULT '[]'::jsonb;"
      })
    });
    
    console.log('Status:', response.status);
    const text = await response.text();
    console.log('Response:', text.substring(0, 500));
    
    if (response.ok) {
      console.log('Migration successful via SQL endpoint!');
    } else {
      console.log('SQL endpoint failed, trying alternative...');
    }
  } catch (err) {
    console.log('SQL endpoint error:', err.message);
  }
  
  // Method 2: Try using the Supabase client to check if column exists
  try {
    const { data, error } = await supabase
      .from('batch_jobs')
      .select('id')
      .limit(1);
    
    if (error) {
      console.log('Supabase query error:', error.message);
    } else {
      console.log('Supabase connection OK');
    }
  } catch (err) {
    console.log('Supabase client error:', err.message);
  }
  
  // Method 3: Use pg module with direct connection
  try {
    const { Pool } = require('pg');
    
    // Construct connection string from Supabase project
    // Format: postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
    // We don't have the password, so this won't work without it
    console.log('pg module available but no direct DB password');
  } catch (err) {
    console.log('pg module not available');
  }
  
  console.log('\n=== MANUAL STEP IF ABOVE FAILED ===');
  console.log('Please run this SQL in the Supabase Dashboard SQL Editor:');
  console.log('  ALTER TABLE IF EXISTS public.batch_jobs');
  console.log("    ADD COLUMN IF NOT EXISTS all_images JSONB DEFAULT '[]'::jsonb;");
  console.log('Dashboard: https://supabase.com/dashboard/project/rbhfkwwnpmytmwueajje');
}

run().catch(console.error);
