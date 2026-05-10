-- ============================================================
--  Pause/Resume Support - Supabase Migration SQL
--
--  Adds columns to batch_jobs table for pause/resume support:
--    1. paused_at - Timestamp when batch was paused
--    2. resume_state - JSON snapshot of progress to restore on resume
--    3. Updates status CHECK constraint to include 'paused'
--
--  Run this in your Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- ---- 1. ADD PAUSED_AT AND RESUME_STATE COLUMNS -----------------

ALTER TABLE public.batch_jobs
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_state TEXT DEFAULT '';

-- ---- 2. UPDATE STATUS CHECK CONSTRAINT TO INCLUDE 'PAUSED' -----

ALTER TABLE public.batch_jobs
  DROP CONSTRAINT IF EXISTS batch_jobs_status_check;

ALTER TABLE public.batch_jobs
  ADD CONSTRAINT batch_jobs_status_check
  CHECK (status IN (
    'queued',
    'extracting_pdf',
    'fingerprinting_zip',
    'filtering_candidates',
    'verifying_with_openai',
    'retrying_failed',
    'paused',
    'needs_review',
    'completed',
    'failed'
  ));
