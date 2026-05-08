// ═══════════════════════════════════════════════════════════════════
//  Run Supabase migration via REST API
//  Uses Supabase Management API with service_role key
//  Usage: node run-migration-via-rest.mjs
// ═══════════════════════════════════════════════════════════════════
import dotenv from 'dotenv';
dotenv.config({ override: true });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '').trim();
console.log(`Project ref: ${projectRef}`);

// SQL statements to execute
const SQL_STATEMENTS = [
  // Add columns
  `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Dining Chair';`,
  `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS original_description TEXT DEFAULT '';`,
  `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS image_hash TEXT DEFAULT '';`,
  `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS duplicate_notices JSONB DEFAULT '[]'::jsonb;`,
  `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ DEFAULT NOW();`,
  // Create indexes
  `CREATE INDEX IF NOT EXISTS idx_matched_images_product_code ON public.matched_images(product_code);`,
  `CREATE INDEX IF NOT EXISTS idx_matched_images_image_name ON public.matched_images(image_name);`,
  `CREATE INDEX IF NOT EXISTS idx_matched_images_image_hash ON public.matched_images(image_hash);`,
  `CREATE INDEX IF NOT EXISTS idx_matched_images_saved_at ON public.matched_images(saved_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_matched_images_category ON public.matched_images(category);`,
];

async function callSupabaseRPC(method, params = {}) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function tryManagementAPI() {
  // Try Supabase Management API with service_role key (may not work)
  console.log('\nTrying Management API...');
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'SELECT 1 AS test' }),
    });
    const text = await res.text();
    console.log(`  Management API status: ${res.status}`);
    console.log(`  Response: ${text.substring(0, 300)}`);
    if (res.ok) return true;
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  return false;
}

async function trySQLQuery() {
  // Try direct SQL query via Supabase's pg_ddl or sql endpoint
  console.log('\nTrying pg_ddl RPC...');
  const r1 = await callSupabaseRPC('pg_ddl', { query: 'SELECT 1' });
  console.log(`  pg_ddl: ${r1.status} - ${r1.body.substring(0, 200)}`);
  
  if (r1.status === 404) {
    console.log('  pg_ddl not found, trying sql...');
    const r2 = await callSupabaseRPC('sql', { query: 'SELECT 1' });
    console.log(`  sql: ${r2.status} - ${r2.body.substring(0, 200)}`);
  }
  
  if (r1.status === 404) {
    console.log('  Trying exec_sql...');
    const r3 = await callSupabaseRPC('exec_sql', { query_text: 'SELECT 1' });
    console.log(`  exec_sql: ${r3.status} - ${r3.body.substring(0, 200)}`);
  }
}

async function tryDirectSQL() {
  // Try using the Supabase REST API to query the database directly
  // Some Supabase projects have the pg_graphql extension or we can use
  // the /rest/v1/ endpoint with a special header
  
  console.log('\nTrying direct SQL via query endpoint...');
  
  // Try the Supabase query endpoint (used by the SQL editor)
  const url = `${SUPABASE_URL}/rest/v1/`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept': 'application/json',
    },
  });
  console.log(`  REST root: ${res.status}`);
  
  // Try to query matched_images to confirm connectivity
  const res2 = await fetch(`${SUPABASE_URL}/rest/v1/matched_images?limit=1`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept': 'application/json',
    },
  });
  const text2 = await res2.text();
  console.log(`  matched_images query: ${res2.status} - ${text2.substring(0, 300)}`);
}

async function tryPgClient() {
  // Try pg module with various connection methods
  console.log('\nTrying pg module connections...');
  
  let pkg;
  try {
    pkg = await import('pg');
  } catch (e) {
    console.log(`  pg module not available: ${e.message}`);
    return false;
  }
  
  const { Client } = pkg.default;
  
  const configs = [
    {
      connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
      label: 'Session pooler (5432)',
      timeout: 15000,
    },
    {
      connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
      label: 'Transaction pooler (6543)',
      timeout: 15000,
    },
  ];
  
  for (const cfg of configs) {
    try {
      console.log(`  Trying ${cfg.label}...`);
      const c = new Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: cfg.timeout });
      await c.connect();
      console.log(`    ✓ Connected!`);
      
      // Run migration
      for (const sql of SQL_STATEMENTS) {
        const name = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] || 
                     sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1] || 
                     sql.substring(0, 40);
        console.log(`  Executing: ${name}...`);
        await c.query(sql);
        console.log(`    ✓ Done`);
      }
      
      // Verify
      const { rows } = await c.query(`
        SELECT column_name, data_type FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'matched_images'
        ORDER BY ordinal_position;
      `);
      console.log('\n  Columns:');
      for (const col of rows) {
        console.log(`    ${col.column_name} (${col.data_type})`);
      }
      
      await c.end();
      console.log('\n✓ Migration complete!');
      return true;
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
    }
  }
  return false;
}

async function main() {
  console.log('=== Supabase Migration Runner ===\n');
  
  // Step 1: Try pg module connections
  const pgOk = await tryPgClient();
  if (pgOk) return;
  
  // Step 2: Try REST API methods
  await tryManagementAPI();
  await trySQLQuery();
  await tryDirectSQL();
  
  console.log('\n✗ Could not execute migration via any method.');
  console.log('Please run this script on the VPS where pg connections work.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
