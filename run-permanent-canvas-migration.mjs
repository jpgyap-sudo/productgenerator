// ═══════════════════════════════════════════════════════════════════
//  Run Supabase migration for permanent canvas columns
//  Uses pg module (already installed) - no Supabase client needed
//  Usage: node run-permanent-canvas-migration.mjs
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

async function runMigration() {
  console.log('Running permanent canvas migration via pg module...\n');

  // Dynamic import of pg (ESM compatible)
  const pkg = await import('pg');
  const { Client } = pkg.default;

  // Try different connection methods
  const configs = [
    // Session pooler (port 5432)
    {
      connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
      label: 'Session pooler (5432)'
    },
    // Transaction pooler (port 6543)
    {
      connectionString: `postgresql://postgres.${projectRef}:${SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
      label: 'Transaction pooler (6543)'
    },
    // Direct DB
    {
      connectionString: `postgresql://postgres:${SUPABASE_SERVICE_ROLE_KEY}@db.${projectRef}.supabase.co:5432/postgres`,
      label: 'Direct DB'
    },
  ];

  let connected = false;
  let client = null;

  for (const cfg of configs) {
    if (connected) break;
    try {
      console.log(`\n  Trying ${cfg.label}...`);
      const c = new Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: 10000 });
      await c.connect();
      console.log(`    ✓ Connected via ${cfg.label}`);
      client = c;
      connected = true;
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
    }
  }

  if (!client) {
    throw new Error('Could not connect to database via any method');
  }

  // Step 2: Add columns
  const alterStatements = [
    `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Dining Chair';`,
    `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS original_description TEXT DEFAULT '';`,
    `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS image_hash TEXT DEFAULT '';`,
    `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS duplicate_notices JSONB DEFAULT '[]'::jsonb;`,
    `ALTER TABLE public.matched_images ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ DEFAULT NOW();`,
  ];

  for (const sql of alterStatements) {
    const colName = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] || 'unknown';
    console.log(`  Adding column: ${colName}...`);
    await client.query(sql);
    console.log(`    ✓ ${colName} added`);
  }

  // Step 3: Create indexes
  const indexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_matched_images_product_code ON public.matched_images(product_code);`,
    `CREATE INDEX IF NOT EXISTS idx_matched_images_image_name ON public.matched_images(image_name);`,
    `CREATE INDEX IF NOT EXISTS idx_matched_images_image_hash ON public.matched_images(image_hash);`,
    `CREATE INDEX IF NOT EXISTS idx_matched_images_saved_at ON public.matched_images(saved_at DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_matched_images_category ON public.matched_images(category);`,
  ];

  for (const sql of indexStatements) {
    const idxName = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1] || 'unknown';
    console.log(`  Creating index: ${idxName}...`);
    await client.query(sql);
    console.log(`    ✓ ${idxName} created`);
  }

  // Step 4: Verify
  const { rows } = await client.query(`
    SELECT column_name, data_type, is_nullable 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'matched_images'
    ORDER BY ordinal_position;
  `);

  console.log('\n  Current matched_images columns:');
  for (const col of rows) {
    console.log(`    ${col.column_name} (${col.data_type})`);
  }

  console.log('\n✓ Migration complete!');
  await client.end();
}

runMigration().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
