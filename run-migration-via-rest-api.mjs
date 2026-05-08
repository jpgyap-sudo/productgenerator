// Run Supabase migration via REST API
// Uses the Supabase Management API database/query endpoint
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env

import { readFileSync } from 'fs';

// Read .env file - handle Windows line endings
const envContent = readFileSync('.env', 'utf-8');
const envVars = {};
envContent.split(/\r?\n/).forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    envVars[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
});

const SUPABASE_URL = envVars.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;
const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '').trim();

console.log('Supabase URL:', SUPABASE_URL);
console.log('Project ref:', projectRef);
console.log('Service role key (first 20 chars):', SUPABASE_SERVICE_ROLE_KEY.substring(0, 20) + '...');

// Migration SQL
const migrationSQL = `
ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Dining Chair';
ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS original_description TEXT DEFAULT '';
ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS image_hash TEXT DEFAULT '';
ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS duplicate_notices JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_matched_images_product_code ON public.matched_images(product_code);
CREATE INDEX IF NOT EXISTS idx_matched_images_image_name ON public.matched_images(image_name);
CREATE INDEX IF NOT EXISTS idx_matched_images_image_hash ON public.matched_images(image_hash);
CREATE INDEX IF NOT EXISTS idx_matched_images_saved_at ON public.matched_images(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_matched_images_category ON public.matched_images(category);
`;

async function tryMethod1() {
  // Method 1: Supabase Management API - database/query endpoint
  // This uses the service role key as a JWT bearer token
  console.log('\n=== Method 1: Management API database/query ===');
  try {
    const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
    const body = { query: migrationSQL };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text.substring(0, 500));
    if (res.ok) return true;
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function tryMethod2() {
  // Method 2: Supabase REST API - rpc/pg_ddl
  console.log('\n=== Method 2: REST API rpc/pg_ddl ===');
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/pg_ddl`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command: migrationSQL }),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text.substring(0, 500));
    if (res.ok) return true;
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function tryMethod3() {
  // Method 3: Supabase REST API - rpc/exec_sql
  console.log('\n=== Method 3: REST API rpc/exec_sql ===');
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/exec_sql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: migrationSQL }),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text.substring(0, 500));
    if (res.ok) return true;
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function tryMethod4() {
  // Method 4: Supabase REST API - rpc/sql
  console.log('\n=== Method 4: REST API rpc/sql ===');
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/sql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: migrationSQL }),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text.substring(0, 500));
    if (res.ok) return true;
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function tryMethod5() {
  // Method 5: Supabase REST API - rpc/run_sql
  console.log('\n=== Method 5: REST API rpc/run_sql ===');
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/run_sql`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql: migrationSQL }),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text.substring(0, 500));
    if (res.ok) return true;
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function tryMethod6() {
  // Method 6: Use Supabase CLI via npx
  console.log('\n=== Method 6: Supabase CLI ===');
  try {
    const { execSync } = await import('child_process');
    const result = execSync(`npx supabase db query "${migrationSQL.replace(/"/g, '\\"').replace(/\n/g, ' ')}" --project-ref ${projectRef} --token "${SUPABASE_SERVICE_ROLE_KEY}" 2>&1`, {
      timeout: 30000,
      encoding: 'utf-8',
    });
    console.log('Result:', result.substring(0, 500));
    return true;
  } catch (err) {
    console.log('Error:', err.message);
    if (err.stdout) console.log('stdout:', err.stdout.toString().substring(0, 500));
    if (err.stderr) console.log('stderr:', err.stderr.toString().substring(0, 500));
  }
  return false;
}

async function tryMethod7() {
  // Method 7: Use pg module directly (try all connection methods)
  console.log('\n=== Method 7: pg module direct connection ===');
  try {
    const pkg = await import('pg');
    const { Client } = pkg.default;

    const configs = [
      {
        connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
        label: 'Session pooler (5432)',
      },
      {
        connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
        label: 'Transaction pooler (6543)',
      },
    ];

    for (const cfg of configs) {
      try {
        console.log(`Trying ${cfg.label}...`);
        const client = new Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: 20000 });
        await client.connect();
        console.log(`Connected via ${cfg.label}!`);
        
        // Run migration
        const statements = migrationSQL.split(';').filter(s => s.trim());
        for (const stmt of statements) {
          if (stmt.trim()) {
            console.log(`Executing: ${stmt.trim().substring(0, 80)}...`);
            await client.query(stmt);
          }
        }
        
        // Verify
        const verify = await client.query(`
          SELECT column_name, data_type, is_nullable 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'matched_images'
          ORDER BY ordinal_position;
        `);
        console.log('\nColumns after migration:');
        verify.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));
        
        await client.end();
        return true;
      } catch (err) {
        console.log(`${cfg.label} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log('Error:', err.message);
  }
  return false;
}

async function main() {
  console.log('Starting migration...');
  console.log('Migration SQL:');
  console.log(migrationSQL);
  
  // Try methods in order of likelihood
  if (await tryMethod7()) {
    console.log('\n✅ Migration completed via pg module!');
    return;
  }
  
  if (await tryMethod1()) {
    console.log('\n✅ Migration completed via Management API!');
    return;
  }
  
  if (await tryMethod2()) {
    console.log('\n✅ Migration completed via rpc/pg_ddl!');
    return;
  }
  
  if (await tryMethod3()) {
    console.log('\n✅ Migration completed via rpc/exec_sql!');
    return;
  }
  
  if (await tryMethod4()) {
    console.log('\n✅ Migration completed via rpc/sql!');
    return;
  }
  
  if (await tryMethod5()) {
    console.log('\n✅ Migration completed via rpc/run_sql!');
    return;
  }
  
  console.log('\n❌ All methods failed.');
  console.log('\nAlternative: Use the Supabase Dashboard SQL Editor manually:');
  console.log(`1. Go to: https://supabase.com/dashboard/project/${projectRef}/sql/new`);
  console.log('2. Paste the migration SQL above');
  console.log('3. Click "Run"');
}

main().catch(console.error);
