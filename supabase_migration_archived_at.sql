-- ═══════════════════════════════════════════════════════════════════
--  Supabase Migration: Add archived_at column to matched_images
--  Run this in the Supabase Dashboard SQL Editor
-- ═══════════════════════════════════════════════════════════════════

-- Add archived_at column for soft-delete support
ALTER TABLE public.matched_images
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;

-- Index for fast archived/non-archived filtering
CREATE INDEX IF NOT EXISTS idx_matched_images_archived_at
  ON public.matched_images(archived_at)
  WHERE archived_at IS NOT NULL;
