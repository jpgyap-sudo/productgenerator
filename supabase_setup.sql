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
  sub_text      TEXT DEFAULT '',
  provider      TEXT DEFAULT 'fal',
  resolution    TEXT DEFAULT '1K',
  drive_folder_id   TEXT DEFAULT '',
  drive_folder_name TEXT DEFAULT '',
  drive_upload_status TEXT DEFAULT '',
  drive_upload_done   INTEGER DEFAULT 0,
  drive_upload_total  INTEGER DEFAULT 0,
  drive_upload_error  TEXT DEFAULT '',
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

-- ── 3. RENDER RESULTS TABLE ────────────────────────────────────────
-- Stores per-view generation results for each queue item.
-- Used by the server-side processing architecture for polling-based status updates.
CREATE TABLE IF NOT EXISTS public.render_results (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_item_id   BIGINT NOT NULL REFERENCES public.product_queue(id) ON DELETE CASCADE,
  view_id         INTEGER NOT NULL CHECK (view_id BETWEEN 1 AND 5),
  status          TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'generating', 'done', 'error')),
  image_url       TEXT DEFAULT '',
  error_message   TEXT DEFAULT '',
  request_id      TEXT DEFAULT '',
  response_url    TEXT DEFAULT '',
  status_url      TEXT DEFAULT '',
  cancel_url      TEXT DEFAULT '',
  queue_position  INTEGER,
  resolution      TEXT DEFAULT '1K',
  attempt_index   INTEGER DEFAULT 0,
  attempt_label   TEXT DEFAULT '',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (queue_item_id, view_id)
);

-- Index for fast lookups by queue_item_id
CREATE INDEX IF NOT EXISTS idx_render_results_queue_item_id ON public.render_results(queue_item_id);

-- Migration for stores that already created render_results before durable fal jobs.
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS request_id TEXT DEFAULT '';
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS response_url TEXT DEFAULT '';
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS status_url TEXT DEFAULT '';
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS cancel_url TEXT DEFAULT '';
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS queue_position INTEGER;
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT '1K';
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS attempt_index INTEGER DEFAULT 0;
ALTER TABLE public.render_results ADD COLUMN IF NOT EXISTS attempt_label TEXT DEFAULT '';

ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'fal';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS resolution TEXT DEFAULT '1K';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_status TEXT DEFAULT '';
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_done INTEGER DEFAULT 0;
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_total INTEGER DEFAULT 0;
ALTER TABLE public.product_queue ADD COLUMN IF NOT EXISTS drive_upload_error TEXT DEFAULT '';

ALTER TABLE public.render_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on render_results" ON public.render_results;

CREATE POLICY "Allow all on render_results"
  ON public.render_results
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 4. DRIVE FOLDER COUNTER ──────────────────────────────────────────
-- Initializes the counter for Google Drive folder naming (HA01, HA02, ...)
INSERT INTO public.app_config (key, value, updated_at)
VALUES ('drive_folder_counter', '1', NOW())
ON CONFLICT (key) DO NOTHING;

-- ── 5. STORAGE BUCKET ──────────────────────────────────────────────
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

-- Check render_results table:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'render_results';
