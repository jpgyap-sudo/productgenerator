-- ═══════════════════════════════════════════════════════════════════
--  Supabase Migration: Add missing columns to product_queue table
--  Run this in the Supabase Dashboard SQL Editor
--  ═══════════════════════════════════════════════════════════════════

-- Add drive_folder_id column (TEXT, nullable)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_folder_id TEXT;

-- Add brand column (TEXT, nullable, default '')
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS brand TEXT DEFAULT '';

-- Add provider column (TEXT, nullable, default 'openai')
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'openai';

-- Add resolution column (TEXT, nullable, default '1K')
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT '1K';

-- Add drive_folder_name column (TEXT, nullable)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_folder_name TEXT;

-- Add drive_folder_url column (TEXT, nullable)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_folder_url TEXT;

-- Add drive_upload_status column (TEXT, nullable, default '')
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_upload_status TEXT DEFAULT '';

-- Add drive_upload_done column (INTEGER, nullable, default 0)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_upload_done INTEGER DEFAULT 0;

-- Add drive_upload_total column (INTEGER, nullable, default 0)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_upload_total INTEGER DEFAULT 0;

-- Add drive_upload_error column (TEXT, nullable, default '')
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS drive_upload_error TEXT DEFAULT '';

-- Add archived_at column (TIMESTAMPTZ, nullable)
ALTER TABLE product_queue
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;

-- Refresh PostgREST schema cache so API writes see new columns immediately
NOTIFY pgrst, 'reload schema';

-- Verify the columns were added
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'product_queue'
ORDER BY ordinal_position;
