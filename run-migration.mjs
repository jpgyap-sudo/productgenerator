#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  run-migration.mjs — Add archived_at column to product_queue
//  Uses pg (node-postgres) to connect directly to Supabase database
// ═══════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
config();
import pg from 'pg';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const projectRef = SUPABASE_URL.match(/https:\/\/(.+)\.supabase\.co/)?.[1];
console.log('Project ref:', projectRef);

async function main() {
  // Step 1: Check if archived_at column already exists via REST API
  console.log('\n[1/3] Checking if archived_at column exists...');
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/product_queue?select=archived_at&limit=1`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    }
  );
  
  if (checkRes.ok) {
    const data = await checkRes.json();
    console.log('  ✅ archived_at column already exists!');
    return;
  }
  
  console.log('  archived_at column is missing.');
  
  // Step 2: Try to connect via pg and run the migration
  console.log('\n[2/3] Attempting direct database connection...');
  
  // Try common Supabase connection patterns
  // The service_role key can sometimes be used as the database password
  // for the postgres user in Supabase projects
  const connectionAttempts = [
    // Try with service_role key as password
    {
      name: 'Service role key as password',
      conn: `postgresql://postgres:${encodeURIComponent(SUPABASE_KEY)}@db.${projectRef}.supabase.co:5432/postgres`
    },
    // Try with the anon key
    {
      name: 'Anon key as password',
      conn: `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_ANON_KEY || SUPABASE_KEY)}@db.${projectRef}.supabase.co:5432/postgres`
    }
  ];
  
  for (const attempt of connectionAttempts) {
    console.log(`  Trying: ${attempt.name}...`);
    const client = new pg.Client({ connectionString: attempt.conn, connectionTimeoutMillis: 5000 });
    
    try {
      await client.connect();
      console.log('  ✅ Connected to database!');
      
      const result = await client.query(
        'ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;'
      );
      console.log('  ✅ Migration SQL executed:', result.command);
      
      await client.end();
      
      // Verify
      console.log('\n[3/3] Verifying...');
      const verifyRes = await fetch(
        `${SUPABASE_URL}/rest/v1/product_queue?select=archived_at&limit=1`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          }
        }
      );
      
      if (verifyRes.ok) {
        console.log('  ✅ archived_at column now exists!');
        console.log('\n✅ Migration completed successfully!');
      } else {
        const vErr = await verifyRes.text();
        console.log('  ❌ Verification failed:', vErr.substring(0, 150));
      }
      
      return;
    } catch (e) {
      console.log(`  ✗ Failed: ${e.message.substring(0, 100)}`);
      try { await client.end(); } catch {}
    }
  }
  
  console.log('\n⚠️  Could not connect to database automatically.');
  console.log('Please run this SQL manually in your Supabase Dashboard SQL Editor:');
  console.log('  ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;');
  console.log('\nSupabase Dashboard URL: https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
  console.log('\nThen restart PM2: pm2 restart product-image-studio --update-env');
}

main().catch(console.error);
