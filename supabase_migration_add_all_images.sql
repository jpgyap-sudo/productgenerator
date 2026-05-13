-- Migration: Add all_images column to batch_jobs table
-- This stores the ZIP images (with galleryUrl but without dataUrl) so the
-- batch-status API can return them when loading previous batch results.

ALTER TABLE IF EXISTS public.batch_jobs
  ADD COLUMN IF NOT EXISTS all_images JSONB DEFAULT '[]'::jsonb;
