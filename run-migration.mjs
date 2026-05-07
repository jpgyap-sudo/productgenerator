#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  run-migration.mjs — Run Supabase SQL migration
//  Adds missing columns to product_queue table
//
//  Usage: node run-migration.mjs
// ═══════════════════════════════════════════════════════════════════

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const sql = `
-- Add missing columns for Google Drive upload feature
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_id TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_name TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_folder_url TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_status TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_done INTEGER DEFAULT 0;
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_total INTEGER DEFAULT 0;
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_error TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;

-- Initialize the counter for Google Drive folder naming
INSERT INTO public.app_config (key, value, updated_at)
VALUES ('drive_folder_counter', '1', NOW())
ON CONFLICT (key) DO NOTHING;
`;

console.log('╔═══════════════════════════════════════════════════════════════╗');
console.log('║  Supabase Migration                                           ║');
console.log('╚═══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('Please run the following SQL in your Supabase Dashboard SQL Editor:');
console.log('  https://supabase.com/dashboard/project/rbhfkwwnpmytmwueajje/sql/new');
console.log('');
console.log('SQL to execute:');
console.log('────────────────────────────────────────────────────────────────');
console.log(sql);
console.log('────────────────────────────────────────────────────────────────');
console.log('');
console.log('Or run via psql if you have the connection string:');
console.log('  psql "postgresql://postgres:YOUR_PASSWORD@db.rbhfkwwnpmytmwueajje.supabase.co:5432/postgres" -c "' + sql.replace(/\n/g, ' ') + '"');
