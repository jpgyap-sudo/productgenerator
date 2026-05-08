// ═══════════════════════════════════════════════════════════════════
//  Run Supabase migration using the existing lib/supabase.js client
//  This uses the same Supabase client as the server
//  Usage: node run-migration-via-server.mjs
// ═══════════════════════════════════════════════════════════════════
import dotenv from 'dotenv';
dotenv.config({ override: true });

// Import the shared Supabase client
import supabase from './lib/supabase.js';

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

async function runMigration() {
  console.log('Running migration via Supabase client...\n');

  // Step 1: Check current columns
  console.log('Current columns in matched_images:');
  const { data: columns, error: colError } = await supabase
    .rpc('get_columns', { table_name: 'matched_images', schema_name: 'public' });
  
  if (colError) {
    console.log(`  (rpc not available: ${colError.message})`);
  } else {
    for (const col of columns || []) {
      console.log(`  ${col.column_name} (${col.data_type})`);
    }
  }

  // Step 2: Try to execute SQL via the REST API
  // Since we can't execute raw SQL via Supabase JS client,
  // we need to use the pg module directly
  console.log('\nTrying pg module connection...');
  
  try {
    const pkg = await import('pg');
    const { Client } = pkg.default;
    
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '').trim();
    
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
    
    let client = null;
    for (const cfg of configs) {
      try {
        console.log(`  Trying ${cfg.label}...`);
        const c = new Client({ connectionString: cfg.connectionString, connectionTimeoutMillis: 15000 });
        await c.connect();
        console.log(`    ✓ Connected!`);
        client = c;
        break;
      } catch (err) {
        console.log(`    ✗ ${err.message}`);
      }
    }
    
    if (!client) {
      throw new Error('Could not connect to database');
    }
    
    // Run migration
    for (const sql of SQL_STATEMENTS) {
      const name = sql.match(/ADD COLUMN IF NOT EXISTS (\w+)/)?.[1] || 
                   sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/)?.[1] || 
                   sql.substring(0, 50);
      console.log(`  Executing: ${name}...`);
      await client.query(sql);
      console.log(`    ✓ Done`);
    }
    
    // Verify
    const { rows } = await client.query(`
      SELECT column_name, data_type FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'matched_images'
      ORDER BY ordinal_position;
    `);
    console.log('\n  Updated columns:');
    for (const col of rows) {
      console.log(`    ${col.column_name} (${col.data_type})`);
    }
    
    await client.end();
    console.log('\n✓ Migration complete!');
    
  } catch (err) {
    console.error(`\n✗ Migration failed: ${err.message}`);
    console.log('\nAlternative: Create a temporary migration endpoint in server.js');
    console.log('Add this route to server.js:');
    console.log(`
app.post('/api/admin/run-migration', async (req, res) => {
  try {
    const pkg = await import('pg');
    const { Client } = pkg.default;
    const projectRef = process.env.SUPABASE_URL.replace('https://', '').replace('.supabase.co', '').trim();
    const client = new Client({
      connectionString: \`postgresql://postgres.\${projectRef}:\${process.env.SUPABASE_SERVICE_ROLE_KEY}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres\`,
      connectionTimeoutMillis: 15000
    });
    await client.connect();
    // ... run SQL statements ...
    await client.end();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`);
    process.exit(1);
  }
}

runMigration();
