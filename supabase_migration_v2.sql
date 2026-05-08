-- ═══════════════════════════════════════════════════════════════════
--  Supabase Migration v2: Add matched_images table
--  Run this in the Supabase Dashboard SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. MATCHED IMAGES TABLE ────────────────────────────────────────
-- Stores the original product image + description pairs after matching.
-- This creates a persistent record of "what was matched" for future reference.
CREATE TABLE IF NOT EXISTS public.matched_images (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_name    TEXT NOT NULL,
  product_brand   TEXT DEFAULT '',
  product_code    TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  image_url       TEXT DEFAULT '',       -- URL in Supabase Storage
  image_data_url  TEXT DEFAULT '',       -- Original data URL (for backward compat)
  image_name      TEXT DEFAULT '',       -- Original filename from ZIP
  image_width     INTEGER DEFAULT 0,
  image_height    INTEGER DEFAULT 0,
  image_size      INTEGER DEFAULT 0,
  match_score     INTEGER DEFAULT 0,
  match_type      TEXT DEFAULT '',
  source_batch    TEXT DEFAULT '',       -- e.g. "agent-upload" or "batch-processor"
  source_pdf      TEXT DEFAULT '',       -- Original PDF filename
  source_zip      TEXT DEFAULT '',       -- Original ZIP filename
  queue_item_id   BIGINT DEFAULT NULL,   -- Links to product_queue after submission
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_matched_images_created_at ON public.matched_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matched_images_product_code ON public.matched_images(product_code);
CREATE INDEX IF NOT EXISTS idx_matched_images_queue_item_id ON public.matched_images(queue_item_id);

-- Allow anonymous access (RLS policy)
ALTER TABLE public.matched_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on matched_images" ON public.matched_images;

CREATE POLICY "Allow all on matched_images"
  ON public.matched_images
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 2. ADD original_image_url TO product_queue ─────────────────────
-- Links each queue item back to its original matched image
ALTER TABLE public.product_queue
ADD COLUMN IF NOT EXISTS original_image_url TEXT DEFAULT '';

ALTER TABLE public.product_queue
ADD COLUMN IF NOT EXISTS matched_image_id BIGINT DEFAULT NULL;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

-- ── 3. VERIFICATION ────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'matched_images'
-- ORDER BY ordinal_position;
