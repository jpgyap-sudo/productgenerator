-- ═══════════════════════════════════════════════════════════════════
--  Product Image Studio — Supabase Setup SQL
--  Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. QUEUE TABLE ─────────────────────────────────────────────────
-- Stores queue items for persistence across sessions/devices.
CREATE TABLE IF NOT EXISTS public.product_queue (
  id            BIGINT PRIMARY KEY,
  name          TEXT NOT NULL,
  image_url     TEXT DEFAULT '',
  status        TEXT DEFAULT 'wait',
  description   TEXT DEFAULT '',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Allow anonymous access (RLS policy)
ALTER TABLE public.product_queue ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (to avoid errors on re-run)
DROP POLICY IF EXISTS "Allow all on product_queue" ON public.product_queue;

CREATE POLICY "Allow all on product_queue"
  ON public.product_queue
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 2. APP CONFIG TABLE ────────────────────────────────────────────
-- Stores app-level configuration like the fal.ai API key.
CREATE TABLE IF NOT EXISTS public.app_config (
  key           TEXT PRIMARY KEY,
  value         TEXT DEFAULT '',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on app_config" ON public.app_config;

CREATE POLICY "Allow all on app_config"
  ON public.app_config
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 3. STORAGE BUCKET ──────────────────────────────────────────────
-- Creates a public bucket for product images.
-- You can also create this manually: Storage → Create bucket → "product_images" → Public
INSERT INTO storage.buckets (id, name, public)
VALUES ('product_images', 'product_images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public access to the bucket
DROP POLICY IF EXISTS "Allow public access to product_images" ON storage.objects;

CREATE POLICY "Allow public access to product_images"
  ON storage.objects
  FOR ALL
  USING (bucket_id = 'product_images')
  WITH CHECK (bucket_id = 'product_images');

-- ═══════════════════════════════════════════════════════════════════
--  VERIFICATION QUERIES (run these to confirm setup)
-- ═══════════════════════════════════════════════════════════════════

-- Check tables exist:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';

-- Check RLS is enabled:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';

-- Check storage bucket:
-- SELECT * FROM storage.buckets WHERE id = 'product_images';
