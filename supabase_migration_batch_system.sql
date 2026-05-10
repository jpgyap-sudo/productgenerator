-- ═══════════════════════════════════════════════════════════════════
--  Batch Matching System — Supabase Migration SQL
--
--  Adds tables for the new batch matching pipeline:
--    1. batch_jobs — Tracks batch processing state, progress, ETA
--    2. zip_image_fingerprints — Stores visual fingerprints per image
--    3. product_matches — Stores verification results per product
--
--  Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. BATCH JOBS TABLE ───────────────────────────────────────────
-- Tracks the entire batch processing lifecycle.
CREATE TABLE IF NOT EXISTS public.batch_jobs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status            TEXT DEFAULT 'queued'
                    CHECK (status IN (
                      'queued',
                      'extracting_pdf',
                      'fingerprinting_zip',
                      'filtering_candidates',
                      'verifying_with_openai',
                      'retrying_failed',
                      'needs_review',
                      'completed',
                      'failed'
                    )),
  stage             TEXT DEFAULT 'Queued',
  progress_percent  INTEGER DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  total_products    INTEGER DEFAULT 0,
  total_images      INTEGER DEFAULT 0,
  completed_products INTEGER DEFAULT 0,
  failed_items      INTEGER DEFAULT 0,
  retry_items       INTEGER DEFAULT 0,
  source_pdf        TEXT DEFAULT '',
  source_zip        TEXT DEFAULT '',
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  estimated_seconds_total    INTEGER DEFAULT 0,
  estimated_seconds_remaining INTEGER DEFAULT 0,
  current_item      TEXT DEFAULT '',
  last_error        TEXT DEFAULT '',
  activity_log      JSONB DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Index for listing batches by status
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON public.batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_created_at ON public.batch_jobs(created_at DESC);

-- RLS
ALTER TABLE public.batch_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on batch_jobs" ON public.batch_jobs;

CREATE POLICY "Allow all on batch_jobs"
  ON public.batch_jobs
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 2. ZIP IMAGE FINGERPRINTS TABLE ───────────────────────────────
-- Stores visual fingerprints for each ZIP image (extracted once via OpenAI Vision).
-- These fingerprints are used for fast candidate filtering without repeated AI calls.
CREATE TABLE IF NOT EXISTS public.zip_image_fingerprints (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  image_name      TEXT NOT NULL,
  image_path      TEXT DEFAULT '',
  visual_json     JSONB,
  status          TEXT DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message   TEXT DEFAULT '',
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for looking up fingerprints by batch and image name
CREATE INDEX IF NOT EXISTS idx_zip_fingerprints_batch ON public.zip_image_fingerprints(batch_id);
CREATE INDEX IF NOT EXISTS idx_zip_fingerprints_image ON public.zip_image_fingerprints(image_name);

-- RLS
ALTER TABLE public.zip_image_fingerprints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on zip_image_fingerprints" ON public.zip_image_fingerprints;

CREATE POLICY "Allow all on zip_image_fingerprints"
  ON public.zip_image_fingerprints
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 3. PRODUCT MATCHES TABLE ──────────────────────────────────────
-- Stores the verification results for each product in a batch.
CREATE TABLE IF NOT EXISTS public.product_matches (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id            BIGINT NOT NULL REFERENCES public.batch_jobs(id) ON DELETE CASCADE,
  product_code        TEXT DEFAULT '',
  product_name        TEXT DEFAULT '',
  product_description TEXT DEFAULT '',
  selected_image_id   TEXT,
  selected_image_name TEXT,
  top_candidates      JSONB,
  confidence          INTEGER DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  reason              TEXT DEFAULT '',
  status              TEXT DEFAULT 'pending'
                      CHECK (status IN (
                        'pending',
                        'auto_accepted',
                        'needs_review',
                        'rejected',
                        'retry_needed',
                        'no_candidates'
                      )),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Index for looking up matches by batch
CREATE INDEX IF NOT EXISTS idx_product_matches_batch ON public.product_matches(batch_id);
CREATE INDEX IF NOT EXISTS idx_product_matches_status ON public.product_matches(status);

-- RLS
ALTER TABLE public.product_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on product_matches" ON public.product_matches;

CREATE POLICY "Allow all on product_matches"
  ON public.product_matches
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ── 4. VERIFICATION QUERIES ───────────────────────────────────────
-- Run these to confirm setup:

-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('batch_jobs', 'zip_image_fingerprints', 'product_matches');

-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'batch_jobs';

-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'zip_image_fingerprints';

-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'product_matches';
