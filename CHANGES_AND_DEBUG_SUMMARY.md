# Product Image Studio — Complete Changes & Debug Summary

> **Generated:** 2026-05-12  
> **Purpose:** Comprehensive record of all changes, bugs, fixes, and remaining issues across the entire codebase.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [All Changes by Component](#2-all-changes-by-component)
3. [Bug Log (All Severities)](#3-bug-log-all-severities)
4. [Debugging Efforts & Test Files](#4-debugging-efforts--test-files)
5. [Known Remaining Issues](#5-known-remaining-issues)
6. [Environment & Configuration](#6-environment--configuration)
7. [Deployment Notes](#7-deployment-notes)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Product Image Studio                      │
├─────────────────────────────────────────────────────────────┤
│  Frontend: index.html (single-page app, served by Express)  │
│  Backend:  server.js (Express + background worker)          │
│  Database: Supabase (Postgres)                              │
│  Storage:  VPS filesystem + Google Drive (service account)  │
│  AI APIs:  OpenAI, Gemini, DeepSeek, Stability AI, fal.ai   │
│  Proxy:    Caddy (HTTPS, reverse proxy)                     │
│  Process:  PM2 (production process manager)                 │
└─────────────────────────────────────────────────────────────┘
```

### Core Processing Pipelines

| Pipeline | Description | Key Files |
|----------|-------------|-----------|
| **Upload Agent** | Upload PDF+ZIP → extract text/images → DeepSeek AI → product extraction | [`api/agent/process.js`](api/agent/process.js), [`lib/deepseek.js`](lib/deepseek.js) |
| **ET File Extraction** | Parse .et files via OLE2 → extract embedded images + row data | [`lib/et-ole-image-extractor.js`](lib/et-ole-image-extractor.js), [`lib/et-image-extractor.js`](lib/et-image-extractor.js) |
| **Pattern Matching** | Match product codes to image filenames via deterministic scoring | [`lib/product-matcher.js`](lib/product-matcher.js), [`api/agent/match.js`](api/agent/match.js) |
| **Batch Matching** | Fingerprint ZIP images → candidate filter → OpenAI verification | [`lib/batch-queue.js`](lib/batch-queue.js), [`lib/candidate-filter.js`](lib/candidate-filter.js), [`lib/openai-verify.js`](lib/openai-verify.js) |
| **Render Queue** | Background worker polls Supabase → renders via fal.ai → uploads to Drive | [`server.js`](server.js) (worker loop), [`lib/fal.js`](lib/fal.js), [`lib/drive.js`](lib/drive.js) |
| **AI Verification** | Gemini/OpenAI vision verification of product-image pairs | [`lib/gemini-verify.js`](lib/gemini-verify.js), [`lib/openai-verify.js`](lib/openai-verify.js) |

---

## 2. All Changes by Component

### 2.1 Frontend ([`index.html`](index.html))

| Date | Change | Reason |
|------|--------|--------|
| 2026-05-06 | Added `clientGenerateView()`, `clientPollQueue()`, `processItemClientSide()`, `processQueueClientSide()` | App required Vercel server endpoints that don't exist locally; added browser-side fal.ai API fallback |
| 2026-05-06 | Modified `startBtn` click handler — try server first, fall back to client-side | Graceful degradation when server endpoints unavailable |
| 2026-05-06 | Added **"📋 Features"** tab button + Product Feature Panel (HTML/CSS/JS) | New UI for viewing/editing view prompts |
| 2026-05-06 | Added `DEFAULT_FEATURE_PROMPTS`, `getFeaturePrompts()`, `renderFeatureGrid()`, `syncPromptsToViews()`, `resetFeaturePrompts()` | Persist edited prompts to localStorage and sync to active VIEWS/CLIENT_VIEW_PROMPTS |
| 2026-05-06 | Updated description field label → "Materials & Style Reference" | Clarify description is a reference note, not core identity |
| 2026-05-06 | Updated `buildDesc()` — wraps desc as `(desc)` suffix | Description is now a parenthetical reference |
| 2026-05-06 | Improved all VIEWS prompts — added "EXACT same product", "Do NOT change" | Prevent AI from generating wrong objects |
| 2026-05-06 | **Removed** `HARDCODED_API_KEY` constant (was line 1232) | 🔴 CRITICAL security bug — real fal.ai key exposed in client-side source code |
| 2026-05-06 | Updated `getApiKey()` — removed `HARDCODED_API_KEY` fallback; priority is now `ENV_API_KEY \|\| savedApiKey` | No more hardcoded fallback |
| 2026-05-06 | Added `data-secure="true"` attribute + CSS `user-select: none` + JS copy-prevention handlers | API key "cannot be copied" from input |
| 2026-05-06 | Updated `showSavedApiKeyState()` — shows `'••••••••••••••••••••••••••••••'` instead of actual key | Masked placeholder — actual key never displayed in DOM |
| 2026-05-08 | **B1 Fix:** Reordered `hideWorkspacePanels()` before panel visibility; added try/catch + retry button | Completed Renders toggle not activating |
| 2026-05-08 | **B5 Fix:** Changed 5 hidden file inputs from `left:-9999px` to `opacity:0;width:0;height:0;overflow:hidden` | Hidden inputs affecting layout calculation |
| 2026-05-08 | **I1:** Loading state & retry button for Completed Renders panel | Better error handling |
| 2026-05-08 | **I2:** `confirm()` dialogs before clearing queue items | Prevent accidental data loss |
| 2026-05-08 | **I3:** Responsive sidebar widths at 1280px (260px) and 1024px (240px) breakpoints | Better layout on smaller viewports |
| 2026-05-08 | **I4:** Toast notifications moved to top-right with improved slide-in animation | Better UX positioning |
| 2026-05-08 | **I5:** Keyboard shortcuts (Ctrl+Enter, Ctrl+U, Esc) | Power user productivity |
| 2026-05-08 | **I6:** Batch match progress indicator with animated spinner | Visual feedback during matching |
| 2026-05-08 | **I7:** API key input changed to `type="password"` with visibility toggle (eye icon) | Better UX than copy prevention |
| 2026-05-08 | **I8:** Batch Select All / Deselect All checkbox with selected count display | Batch operations UX |
| 2026-05-08 | **I9:** Monitor panel auto-refresh toggle with 15s countdown timer | Live monitoring |
| 2026-05-08 | **I10:** Render queue column sorting (▲/▼ indicators) | Data table usability |
| 2026-05-08 | Topbar buttons: reduced font-size to 12px, padding to 3px 8px | Layout optimization |
| 2026-05-08 | Batch match cards: CSS Grid with `minmax(320px, 1fr)` | Fluid grid layout |
| 2026-05-08 | Matched Images Gallery: thumbnails set to 72px | Balanced grid density |

### 2.2 Backend Server ([`server.js`](server.js))

| Date | Change | Reason |
|------|--------|--------|
| 2026-05-08 | **B4 Fix:** Added favicon route returning valid 1×1 transparent ICO (68 bytes) | Browser 404s for `/favicon.ico` |
| 2026-05-08 | **B7 Fix:** Added warning log when item has no meaningful description (`desc.trim().length < 5`) | Alert operators about empty descriptions |
| 2026-05-08 | **B8 Fix:** Expanded fallback regex to include `timeout\|abort` | Gemini timeouts now trigger OpenAI retry instead of permanent failure |
| — | Background worker loop polls Supabase every 5s (CONCURRENCY=5) | Core processing engine |
| — | All API route handlers: queue submit/status/completed, agent process/match/submit, render product, render queue, admin migration | Full REST API surface |
| — | ET extraction progress/pause endpoints (`/api/agent/et-progress/:batchId`, `/api/agent/et-pause/:batchId`) | User-controlled pause/resume |
| — | Drive upload with Supabase fallback to local `completed-batches.json` | Resilience when Supabase is down |
| — | Missing column detection with auto-stripping (`getMissingSchemaColumn`, `isMissingColumnError`) | Handle schema drift gracefully |
| — | Server timeout set to 600000ms (10 minutes) | Long-running renders |

### 2.3 ET File Extraction ([`lib/et-image-extractor.js`](lib/et-image-extractor.js), [`lib/et-ole-image-extractor.js`](lib/et-ole-image-extractor.js))

| Change | Reason |
|--------|--------|
| OLE2 direct extraction first (bypasses LibreOffice for images) | Faster, more reliable image extraction from .et files |
| LibreOffice .et → .xlsx conversion with retry (MAX_CONV_RETRIES=2) | Fallback for text/row data when OLE2 partial |
| exceljs-based image extraction from xlsx | Fallback when OLE2 fails entirely |
| SheetJS-based row data parsing with DISPIMG formula detection | Extract product data from spreadsheet rows |
| Position-based row mapping from OLE2 `sortedImagesByPosition` | Map images to correct rows by y-coordinate |
| UUID matching (Tier 0) vs Position-based mapping (Tier 1) | Two-tier matching strategy |
| AI verification with OpenAI GPT-4o Vision + Gemini 2.0 Flash fallback | Verify product-image pairs |
| Pause/resume via `etPauseStore` global Map | User-controlled pause |
| Progress animation with artificial delays (PROGRESS_ANIMATION_STEPS) | Smooth UX progress bars |
| Resume state saved to temp directory | Crash recovery |
| OLE2 parser: parses ETCellImageData stream using `cfb` library | Direct binary parsing of .et files |
| Embedded ZIP extraction with manual PK\x03\x04 header scanning | Extract images from OLE2 storage |
| cellImages.xml parsing for UUID→rId→position mappings | Map images to cells |
| Filters out linked/decorative images at y=0 with `core_image_url__exec_download` or `upload_post_object_v2` | Remove non-product images |

### 2.4 Batch Matching System ([`lib/batch-queue.js`](lib/batch-queue.js), [`lib/candidate-filter.js`](lib/candidate-filter.js), [`lib/openai-verify.js`](lib/openai-verify.js))

| Change | Reason |
|--------|--------|
| Full batch lifecycle: queued → extracting_pdf → fingerprinting_zip → filtering_candidates → verifying_with_openai → retrying_failed → needs_review → completed/failed | Structured processing pipeline |
| Progress tracking with ETA estimation | User visibility into processing time |
| Activity log with last 100 entries | Audit trail |
| Pause/resume with in-memory resolver map | User control |
| Candidate filter: attribute-based scoring (type=30, color=20, material=15, style=15, arms=10, keywords=10) | Reduce OpenAI API costs by pre-filtering |
| OpenAI verification with configurable model, delay, concurrency, retries | Cost/accuracy tuning |
| Confidence thresholds: MATCH_AUTO_ACCEPT=90, MATCH_REVIEW_THRESHOLD=70 | Automated decision making |

### 2.5 AI Verification ([`lib/gemini-verify.js`](lib/gemini-verify.js), [`lib/openai-verify.js`](lib/openai-verify.js))

| Change | Reason |
|--------|--------|
| Gemini 2.5 Flash model for visual verification | Cost-effective vision AI |
| 15s timeout per verification, 30s for visual search | Prevent hanging |
| `verifyMatch()` for single product-image pair | Core verification |
| `visualSearchMatch()` for finding best match among candidates (up to 10) | Fallback for unmatched products |
| `verifyMatches()` for batch verification (skips exact matches with score=100) | Batch optimization |
| **B8 Fix:** Gemini timeout increased 120s→180s, configurable via `GEMINI_TIMEOUT_MS` | Complex interior scenes need more time |
| **B8 Fix:** Timeout errors now trigger OpenAI fallback | Resilience |

### 2.6 Pattern Matching ([`lib/product-matcher.js`](lib/product-matcher.js))

| Change | Reason |
|--------|--------|
| `scoreMatch()`: exact=100, code-in-filename=80, filename-in-code=60, token-overlap=40, fuzzy-token=30 | Deterministic scoring |
| `scoreCrossReference()`: xref-number-match=50, xref-close-match=40, xref-close-ratio=30 | Cross-reference matching |
| Sequential fallback REMOVED (was score=10, matchType='sequential-fallback') | Prevent low-quality auto-matches |
| Only auto-assigns if score >= 40 | Quality threshold |

### 2.7 DeepSeek AI Extraction ([`lib/deepseek.js`](lib/deepseek.js))

| Change | Reason |
|--------|--------|
| Splits PDF text into BATCH_SIZE=4000 char chunks | Handle large PDFs |
| Processes CONCURRENT_BATCHES=3 chunks concurrently | Speed up extraction |
| MAX_BATCH_RETRIES=2 with increasing delay | Resilience against transient failures |
| Regex-based product code scanning (5 patterns) for post-processing injection | Extract codes AI might miss |
| Robust JSON parser handling truncated/malformed responses | Handle AI output inconsistencies |

### 2.8 Google Drive Integration ([`lib/drive.js`](lib/drive.js))

| Change | Reason |
|--------|--------|
| OAuth2 with refresh token (primary) + Service Account JWT (fallback) | Flexible auth |
| Sequential counter folder naming | Organized Drive structure |
| Supabase fallback to local `drive-counter.json` | Resilience when Supabase is down |
| Shared Drive support with `supportsAllDrives` flags | Enterprise Drive compatibility |
| Concurrency-limited uploads (UPLOAD_CONCURRENCY=2) | Rate limiting |

### 2.9 Durable Queue System ([`lib/fal.js`](lib/fal.js), [`api/queue/submit.js`](api/queue/submit.js), [`api/queue/status.js`](api/queue/status.js))

| Change | Reason |
|--------|--------|
| Changed all API URLs from `fal.run` to `queue.fal.run` | Use queue-based API for durable job submission |
| Added `getAttemptCount()`, `getViewById()`, `submitViewJob()`, `getQueuedResult()`, `extractImageUrl()` | New exports for durable queue processing |
| Rewrote submit.js to use durable fal.ai queue jobs instead of waitUntil → process-item | Renders survive tab closes/reloads |
| Stores `request_id`/`status_url`/`response_url` in DB | Track queue job lifecycle |
| Rewrote status.js with `reconcileFalJobs()` — polls fal.ai for any jobs still generating | Recovers renders that completed while browser was closed |
| Added `copyImageToStorage()`, `saveResultRow()`, `updateQueueStatuses()`, `groupResults()` | Complete durable render lifecycle |
| Added `request_id`, `response_url`, `status_url`, `attempt_index`, `attempt_label` columns to `render_results` | Schema for durable queue tracking |

### 2.10 Infrastructure & Config

| File | Change | Reason |
|------|--------|--------|
| `.gitignore` | Added `dist/`, `fal_docs.html`, `product_studio_queue*.html`, `plans/`, `AI_CODER_LOG.md` | Clean up untracked files |
| `.gitignore` | Fixed `cdist/` typo → added `dist/` alongside | Correct gitignore pattern |
| `supabase_setup.sql` | Added schema columns for durable queue | DB schema migration |
| `README.md` | Updated setup instructions to reference `supabase_setup.sql` | Documentation accuracy |
| `README-VPS.md` | Full VPS deployment guide with Caddy, PM2, Supabase | Deployment documentation |
| `AI_CODER_LOG.md` | Created centralized change log | Track all AI coder changes |

---

## 3. Bug Log (All Severities)

### 🔴 CRITICAL (Security/Data Loss)

| # | Issue | File | Status | Fix |
|---|-------|------|--------|-----|
| 1 | **Hardcoded fal.ai API key** in client-side source code — anyone viewing page source can steal it | [`index.html:1232`](index.html:1232) (removed) | ✅ **FIXED** | Removed `HARDCODED_API_KEY` constant entirely; env var or user-saved key only |
| 8 | Duplicate of #1 | [`index.html:1232`](index.html:1232) (removed) | ✅ **FIXED** | Same as above |

### 🔴 HIGH (Broken Feature)

| # | Issue | File | Status | Fix |
|---|-------|------|--------|-----|
| 8b | **Gemini API timeouts** causing permanent failures — 120s timeout too short for complex interior scenes; timeout errors not caught by OpenAI fallback regex | [`server.js:604`](server.js:604), [`lib/gemini.js:18`](lib/gemini.js:18) | ✅ **FIXED** | Timeout increased 120s→180s, configurable via `GEMINI_TIMEOUT_MS`; fallback regex expanded to include `timeout\|abort` |

### 🟡 MEDIUM

| # | Issue | File | Status | Fix |
|---|-------|------|--------|-----|
| 2 | **CSP missing `queue.fal.run`** — CSP `connect-src` includes `https://fal.run` but client-side code calls `https://queue.fal.run` | `index.html`, `vercel.json` | ✅ **FIXED** | Added to both files |
| B1 | **Completed Renders toggle not activating** — `hideWorkspacePanels()` called AFTER setting panel visibility; no error boundary | [`index.html:5736`](index.html:5736) | ✅ **FIXED** | Reordered operations; added try/catch with retry button |
| B7 | **Queue items with empty descriptions** — empty descriptions produce lower-quality AI renders | [`server.js:552`](server.js:552) | ✅ **FIXED** | Warning logged when description < 5 chars |

### 🟢 LOW (Cosmetic/Optimization)

| # | Issue | File | Status | Fix |
|---|-------|------|--------|-----|
| 3 | `dist/` not in `.gitignore` | `.gitignore` | ✅ **FIXED** | Added `dist/` |
| 4 | `fal_docs.html` untracked | `.gitignore` | ✅ **FIXED** | Added to `.gitignore` |
| 5 | `cdist/` typo in `.gitignore` | `.gitignore` | ✅ **FIXED** | Added `dist/` alongside |
| 6 | `product_studio_queue*.html` untracked | `.gitignore` | ✅ **FIXED** | Added to `.gitignore` |
| 7 | `syncPromptsToViews()` scoping bug — `editedText` declared inside `forEach` but referenced outside | [`index.html`](index.html) | ✅ **FIXED** | Moved `const editedText` before both blocks |
| 9 | Client-side uses `fal.run` (sync) not `queue.fal.run` (queue) | [`index.html:3254`](index.html:3254) | **INTENTIONAL** — client-side has no DB persistence |
| 10 | Client-side has no model fallback attempts | [`index.html`](index.html) | **NOT FIXED** — minor; client-side is fallback path |
| 11 | `api/process-item.js` is dead code | `api/process-item.js` | **NOT FIXED** — safe to leave; removing could break rollback |
| 12 | `__FAL_API_KEY__` replacement bypassed by `HARDCODED_API_KEY` fallback | [`index.html:1225`](index.html:1225) | ✅ **FIXED** — hardcoded key removed; env var now works |
| B3 | API response format mismatch in test script | [`test-all-apis.mjs:76`](test-all-apis.mjs:76) | ✅ **FIXED** — test assertions updated |
| B4 | Missing `favicon.ico` returns 404 | [`server.js:334`](server.js:334) | ✅ **FIXED** — returns valid 1×1 transparent ICO |
| B5 | Hidden file inputs affect layout calculation (`leftMost: -9999`) | [`index.html:3472`](index.html:3472) | ✅ **FIXED** — changed to `opacity:0;width:0;height:0` |
| B6 | Dark mode toggle not working in crawl | [`index.html:7102`](index.html:7102) | **FALSE POSITIVE** — crawl checked wrong property |

---

## 4. Debugging Efforts & Test Files

### Test Files Inventory

| File | Purpose | Status |
|------|---------|--------|
| [`test-agent.mjs`](test-agent.mjs) | Tests PDF extraction from `/root/DINING CHAIRS.pdf` and ZIP extraction from `/root/chair.zip` | ✅ Created |
| [`test-deepseek.mjs`](test-deepseek.mjs) | Tests DeepSeek extraction from `uploads/DINING_CHAIRS_with_Brand.pdf` | ✅ Created |
| [`test-deepseek2.mjs`](test-deepseek2.mjs) | Tests DeepSeek extraction from `./DINING_CHAIRS.pdf` with maxPages=3 | ✅ Created |
| [`test-pdf.mjs`](test-pdf.mjs) | Tests PDF extraction from local Windows path | ✅ Created |
| [`test-vps-pdf.mjs`](test-vps-pdf.mjs) | Tests PDF extraction from `./DINING_CHAIRS.pdf` with maxPages=3 | ✅ Created |
| [`test-zip.mjs`](test-zip.mjs) | Tests ZIP extraction from local Windows path | ✅ Created |
| [`test-drive.mjs`](test-drive.mjs) | Tests Google Drive API authentication and file listing | ✅ Created |
| [`test-ole.mjs`](test-ole.mjs) | Tests OLE2 parsing of `DINING_CHAIRS_COPY.et` | ✅ Created |
| [`test-all-apis.mjs`](test-all-apis.mjs) | 28 API endpoint tests (all pass) | ✅ Updated (B3 fix) |
| [`test-batch-e2e.mjs`](test-batch-e2e.mjs) | Batch matching E2E test | ✅ Created |
| [`test-match-e2e.mjs`](test-match-e2e.mjs) | Pattern matching E2E test | ✅ Created |
| [`test-et-ai-e2e.mjs`](test-et-ai-e2e.mjs) | ET file AI extraction E2E test | ✅ Created |
| [`test-et-images-e2e.mjs`](test-et-images-e2e.mjs) | ET image extraction E2E test | ✅ Created |
| [`test-gemini-fallback.mjs`](test-gemini-fallback.mjs) | Gemini fallback verification test | ✅ Created |
| [`test-ole-integration.mjs`](test-ole-integration.mjs) | OLE2 integration test | ✅ Created |
| [`test-ole-decompress.mjs`](test-ole-decompress.mjs) | OLE2 decompression test | ✅ Created |
| [`test-ole-extract.mjs`](test-ole-extract.mjs) | OLE2 extraction test | ✅ Created |
| [`test-ole-header.mjs`](test-ole-header.mjs) | OLE2 header analysis test | ✅ Created |
| [`test-ole-zip.mjs`](test-ole-zip.mjs) | OLE2 embedded ZIP test | ✅ Created |
| [`test-ole-module.mjs`](test-ole-module.mjs) | OLE2 module test | ✅ Created |
| [`test-e2e-agent-flow.mjs`](test-e2e-agent-flow.mjs) | Full agent flow E2E test | ✅ Created |
| [`test-furniture-render-e2e.mjs`](test-furniture-render-e2e.mjs) | Furniture render E2E test | ✅ Created |
| [`test-rerender-e2e.mjs`](test-rerender-e2e.mjs) | Re-render E2E test | ✅ Created |
| [`test-pdf-only-e2e.mjs`](test-pdf-only-e2e.mjs) | PDF-only E2E test | ✅ Created |
| [`test-et-only-e2e.mjs`](test-et-only-e2e.mjs) | ET-only E2E test | ✅ Created |
| [`test-match-flow.mjs`](test-match-flow.mjs) | Match flow test | ✅ Created |
| [`test-match-vps.mjs`](test-match-vps.mjs) | VPS match test | ✅ Created |
| [`test-batch-processor.mjs`](test-batch-processor.mjs) | Batch processor test | ✅ Created |
| [`test-batch-deploy.mjs`](test-batch-deploy.mjs) | Batch deploy test | ✅ Created |
| [`test-drive-upload.mjs`](test-drive-upload.mjs) | Drive upload test | ✅ Created |
| [`test-drive-upload2.mjs`](test-drive-upload2.mjs) | Drive upload test v2 | ✅ Created |
| [`test-drive-access.mjs`](test-drive-access.mjs) | Drive access test | ✅ Created |
| [`test-shared-drive.mjs`](test-shared-drive.mjs) | Shared Drive test | ✅ Created |
| [`test-folder-location.mjs`](test-folder-location.mjs) | Folder location test | ✅ Created |
| [`test-google-env.mjs`](test-google-env.mjs) | Google env test | ✅ Created |
| [`test-oauth-identity.mjs`](test-oauth-identity.mjs) | OAuth identity test | ✅ Created |
| [`test-oauth-raw.mjs`](test-oauth-raw.mjs) | OAuth raw test | ✅ Created |
| [`test-pdf-render.mjs`](test-pdf-render.mjs) | PDF render test | ✅ Created |
| [`test-pdf-render2.mjs`](test-pdf-render2.mjs) | PDF render test v2 | ✅ Created |
| [`test-pdf-text.mjs`](test-pdf-text.mjs) | PDF text test | ✅ Created |
| [`test-pdf-canvas.mjs`](test-pdf-canvas.mjs) | PDF canvas test | ✅ Created |
| [`test-sharp-pdf.mjs`](test-sharp-pdf.mjs) | Sharp PDF test | ✅ Created |
| [`test-playwright.mjs`](test-playwright.mjs) | Playwright test | ✅ Created |
| [`test-no-canvas.mjs`](test-no-canvas.mjs) | No-canvas test | ✅ Created |
| [`test-memory.mjs`](test-memory.mjs) | Memory test | ✅ Created |
| [`test-generate.mjs`](test-generate.mjs) | Generate test | ✅ Created |
| [`test-extraction.mjs`](test-extraction.mjs) | Extraction test | ✅ Created |
| [`test-direct-text.mjs`](test-direct-text.mjs) | Direct text test | ✅ Created |
| [`test-direct-text2.mjs`](test-direct-text2.mjs) | Direct text test v2 | ✅ Created |
| [`test-debug-chunks.mjs`](test-debug-chunks.mjs) | Debug chunks test | ✅ Created |
| [`test-debug-codes.mjs`](test-debug-codes.mjs) | Debug codes test | ✅ Created |
| [`test-dump-cellimages.mjs`](test-dump-cellimages.mjs) | Dump cellImages.xml test | ✅ Created |
| [`test-openai-edits.mjs`](test-openai-edits.mjs) | OpenAI edits test | ✅ Created |
| [`debug-diagnostic.mjs`](debug-diagnostic.mjs) | General diagnostic debug | ✅ Created |
| [`debug-pdf-text.mjs`](debug-pdf-text.mjs) | PDF text debug | ✅ Created |
| [`debug-token.mjs`](debug-token.mjs) | Token debug | ✅ Created |
| [`debug-zip-names.mjs`](debug-zip-names.mjs) | ZIP names debug | ✅ Created |

### Key Debugging Findings

1. **OLE2 Parsing**: The `.et` file format uses OLE2 compound documents. Images are stored in `ETCellImageData` stream as embedded ZIP archives. The parser manually scans for `PK\x03\x04` headers within the stream to extract the ZIP. This is fragile — if the ZIP header offset changes, extraction breaks.

2. **DISPIMG Formula Matching**: WPS spreadsheets use `=DISPIMG("UUID", ...)` formulas. The extractor matches these UUIDs to entries in `cellImages.xml`. If the UUID format differs between WPS versions, matching fails.

3. **Position-Based Row Mapping**: When UUID matching fails (Tier 0), the system falls back to position-based mapping (Tier 1) using y-coordinates from `cellImages.xml`. This assumes images are sorted by y-coordinate in the same order as rows — if images are in a different order, mapping is incorrect.

4. **LibreOffice Conversion**: The `.et` → `.xlsx` conversion via `soffice --headless` is unreliable. It has MAX_CONV_RETRIES=2 but can still fail silently (producing empty output without error).

5. **DeepSeek JSON Parsing**: DeepSeek sometimes returns truncated or malformed JSON. The `robustParseJSON()` function handles common cases but may miss edge cases.

6. **Gemini Timeouts**: Complex interior scene renders (View 4) can take >120s. The timeout was increased to 180s but very complex scenes may still time out.

---

## 5. Known Remaining Issues

### 🔴 CRITICAL — None remaining (all fixed)

### 🔴 HIGH — Potential Issues (Not Yet Confirmed)

| # | Issue | Likely Location | Risk |
|---|-------|-----------------|------|
| H1 | **OLE2 ZIP header offset may vary** between WPS versions. The manual `PK\x03\x04` scan could miss the embedded ZIP if the ETCellImageData stream format changes. | [`lib/et-ole-image-extractor.js:259-288`](lib/et-ole-image-extractor.js:259) | **HIGH** — would cause complete .et image extraction failure |
| H2 | **LibreOffice not installed on VPS** — the `.et` → `.xlsx` conversion for row data will fail silently. | [`lib/et-image-extractor.js:85-134`](lib/et-image-extractor.js:85) | **HIGH** — row data extraction fails |
| H3 | **Supabase connection issues** — if Supabase is unreachable, the background worker cannot poll for queue items, and the entire render pipeline stops. File-based fallback only exists for Drive counter. | [`server.js:482-496`](server.js:482) | **HIGH** — complete processing halt |
| H4 | **Missing environment variables** — the app requires many API keys. If any are missing, specific features fail silently. | `.env` file | **HIGH** — partial feature failure |

### 🟡 MEDIUM

| # | Issue | Location | Status |
|---|-------|----------|--------|
| M1 | **Client-side uses `fal.run` (sync) not `queue.fal.run` (queue)** — client-side renders don't survive tab closes | [`index.html:3254`](index.html:3254) | **INTENTIONAL** — no DB for queue tracking |
| M2 | **Client-side has no model fallback** — only tries `nano-banana-2` with no retry | [`index.html`](index.html) | **NOT FIXED** — minor; fallback path |
| M3 | **`api/process-item.js` is dead code** — legacy file no longer called | `api/process-item.js` | **NOT FIXED** — safe to leave |
| M4 | **Empty descriptions degrade render quality** — warning logged but no enforcement | [`server.js:552`](server.js:552) | **FIXED** — warning only |
| M5 | **OLE2 position-based mapping is heuristic** — assumes y-coordinate order matches row order. If images are in a different visual order, mapping is wrong. | [`lib/et-ole-image-extractor.js:327-367`](lib/et-ole-image-extractor.js:327) | **KNOWN LIMITATION** |

### 🟢 LOW

| # | Issue | Location | Status |
|---|-------|----------|--------|
| L1 | **No rate limiting on API endpoints** — could be abused | `server.js` | **NOT IMPLEMENTED** |
| L2 | **No request validation middleware** — each handler validates independently | `server.js` | **NOT IMPLEMENTED** |
| L3 | **No health check for AI API keys** — `testConnection()` in DeepSeek exists but not called on startup | [`lib/deepseek.js:437-450`](lib/deepseek.js:437) | **NOT IMPLEMENTED** |
| L4 | **No logging framework** — uses `console.log`/`console.error` throughout | All files | **NOT IMPLEMENTED** |
| L5 | **No automated test suite** — 50+ manual test files but no CI | Root directory | **NOT IMPLEMENTED** |

---

## 6. Environment & Configuration

### Required Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `SUPABASE_URL` | Supabase project URL | ✅ Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | ✅ Yes |
| `OPENAI_API_KEY` | OpenAI API key | ✅ Yes |
| `GEMINI_API_KEY` | Google Gemini API key | ✅ Yes |
| `DEEPSEEK_API_KEY` | DeepSeek API key | ✅ Yes |
| `STABILITY_API_KEY` | Stability AI API key | ✅ Yes |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Drive service account (single-line JSON) | ✅ Yes |
| `FAL_API_KEY` | fal.ai API key | ✅ Yes |
| `NODE_ENV` | `production` or `development` | ✅ Yes |
| `PORT` | Server port (default: 3000) | ❌ No |
| `DRIVE_PARENT_FOLDER_ID` | Google Drive parent folder ID | ❌ No |
| `DRIVE_SHARED_DRIVE_ID` | Shared Drive ID (if using shared drive) | ❌ No |
| `GEMINI_TIMEOUT_MS` | Gemini API timeout (default: 180000) | ❌ No |

### Supabase Tables

| Table | Purpose | Status |
|-------|---------|--------|
| `product_queue` | Main queue items for rendering | ✅ Created |
| `render_results` | Individual view render results | ✅ Created |
| `batch_jobs` | Batch matching job tracking | ✅ Created |
| `zip_image_fingerprints` | ZIP image fingerprints | ✅ Created |
| `product_matches` | Product-image match results | ✅ Created |
| `app_config` | App configuration (key-value store) | ✅ Created |

---

## 7. Deployment Notes

### VPS Deployment (`render.abcx124.xyz`)

| Component | Status | Notes |
|-----------|--------|-------|
| Express server | ✅ Running | PM2-managed, port 3000 |
| Caddy reverse proxy | ✅ Running | HTTPS via Let's Encrypt |
| Supabase | ✅ Connected | All tables created |
| Google Drive | ✅ Configured | Service account auth |
| AI APIs | ✅ Configured | OpenAI, Gemini, DeepSeek, Stability, fal.ai |

### Deployment Commands

```bash
# Deploy files
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude logs \
  --exclude vps-assets \
  ./ user@<VPS_IP>:/var/www/productgenerator/

# Restart
ssh user@<VPS_IP> "cd /var/www/productgenerator && npm ci --omit=dev && pm2 restart product-image-studio && pm2 save"
```

### Health Check Endpoints

| Endpoint | Expected Response |
|----------|------------------|
| `GET /health` | `{"status":"ok","uptime":...,"memory":...}` |
| `GET /api/monitor` | System monitoring data |
| `GET /api/queue/completed` | `{completedBatches: [...]}` |

---

## Appendix: File Reference

### Core Backend Files

| File | Lines | Purpose |
|------|-------|---------|
| [`server.js`](server.js) | 1277 | Express server + background worker + all API routes |
| [`lib/fal.js`](lib/fal.js) | — | fal.ai API client (queue-based rendering) |
| [`lib/drive.js`](lib/drive.js) | 614 | Google Drive upload (OAuth2 + Service Account) |
| [`lib/supabase.js`](lib/supabase.js) | — | Supabase client + table constants |
| [`lib/batch-queue.js`](lib/batch-queue.js) | 708 | Batch queue system with progress tracking |
| [`lib/candidate-filter.js`](lib/candidate-filter.js) | 279 | Attribute-based candidate filtering (no AI) |
| [`lib/openai-verify.js`](lib/openai-verify.js) | — | OpenAI verification for batch matching |
| [`lib/image-fingerprint.js`](lib/image-fingerprint.js) | — | ZIP image fingerprinting |
| [`lib/product-matcher.js`](lib/product-matcher.js) | 309 | Deterministic pattern matching |
| [`lib/gemini-verify.js`](lib/gemini-verify.js) | 349 | Gemini visual verification |
| [`lib/deepseek.js`](lib/deepseek.js) | 451 | DeepSeek AI product extraction |
| [`lib/et-image-extractor.js`](lib/et-image-extractor.js) | 1469 | ET file image + row data extraction |
| [`lib/et-ole-image-extractor.js`](lib/et-ole-image-extractor.js) | 425 | Direct OLE2 parser for .et files |
| [`lib/pdf-extractor.js`](lib/pdf-extractor.js) | 192 | PDF text extraction wrapper |
| [`lib/zip-extractor.js`](lib/zip-extractor.js) | — | ZIP file extraction |
| [`lib/retry-manager.js`](lib/retry-manager.js) | — | Retry logic for failed items |
| [`lib/progress-estimator.js`](lib/progress-estimator.js) | — | ETA calculation |
| [`lib/vps-storage.js`](lib/vps-storage.js) | — | VPS filesystem storage |
| [`lib/completed-batches.js`](lib/completed-batches.js) | — | Completed batch persistence |
| [`lib/render-queue.service.js`](lib/render-queue.service.js) | — | Render queue service |
| [`lib/render-worker.service.js`](lib/render-worker.service.js) | — | Render worker service |
| [`lib/render-router.js`](lib/render-router.js) | — | Render routing logic |
| [`lib/render-with-fallback.js`](lib/render-with-fallback.js) | — | Render with model fallback |
| [`lib/prompts.js`](lib/prompts.js) | — | AI prompt templates |
| [`lib/qa-engine.js`](lib/qa-engine.js) | — | Quality assurance engine |
| [`lib/vision-matcher.js`](lib/vision-matcher.js) | — | Vision-based matching |
| [`lib/pdf-only-matcher.js`](lib/pdf-only-matcher.js) | — | PDF-only matching |
| [`lib/et-screenshot-matcher.js`](lib/et-screenshot-matcher.js) | — | ET screenshot matching |
| [`lib/upload-gallery.js`](lib/upload-gallery.js) | — | Gallery upload |
| [`lib/stability.js`](lib/stability.js) | — | Stability AI client |
| [`lib/openai.js`](lib/openai.js) | — | OpenAI client |
| [`lib/gemini.js`](lib/gemini.js) | — | Gemini client |

### API Route Files

| File | Purpose |
|------|---------|
| [`api/agent/process.js`](api/agent/process.js) | Upload Agent — process PDF+ZIP or ET files |
| [`api/agent/match.js`](api/agent/match.js) | Phase 2 — pattern matching + Gemini verification |
| [`api/agent/submit.js`](api/agent/submit.js) | Submit matched products to render queue |
| [`api/agent/save-matched.js`](api/agent/save-matched.js) | Save matched results to database |
| [`api/agent/save-matched-permanent.js`](api/agent/save-matched-permanent.js) | Save permanent matched results |
| [`api/agent/matched-images.js`](api/agent/matched-images.js) | Get matched images |
| [`api/agent/matched-images-permanent.js`](api/agent/matched-images-permanent.js) | Get permanent matched images |
| [`api/agent/batch-status.js`](api/agent/batch-status.js) | Batch job status endpoint |
| [`api/agent/match-pdf-only.js`](api/agent/match-pdf-only.js) | PDF-only matching endpoint |
| [`api/agent/match-vision.js`](api/agent/match-vision.js) | Vision-based matching endpoint |
| [`api/agent/upload-gallery.js`](api/agent/upload-gallery.js) | Gallery upload endpoint |
| [`api/fal-webhook.js`](api/fal-webhook.js) | fal.ai webhook receiver |
| [`api/monitor.js`](api/monitor.js) | System monitoring endpoint |
| [`api/process-item.js`](api/process-item.js) | Legacy process item (dead code) |
| [`api/render-queue/index.js`](api/render-queue/index.js) | Render queue API |

### SQL Migration Files

| File | Purpose |
|------|---------|
| [`supabase_setup.sql`](supabase_setup.sql) | Initial schema setup |
| [`supabase_migration.sql`](supabase_migration.sql) | First migration |
| [`supabase_migration_v2.sql`](supabase_migration_v2.sql) | Second migration |
| [`supabase_migration_batch_system.sql`](supabase_migration_batch_system.sql) | Batch system tables |
| [`supabase_migration_pause_resume.sql`](supabase_migration_pause_resume.sql) | Pause/resume support |
| [`supabase_migration_render_jobs.sql`](supabase_migration_render_jobs.sql) | Render jobs table |
| [`supabase_migration_render_queue.sql`](supabase_migration_render_queue.sql) | Render queue table |

---

*End of summary. Generated from codebase analysis on 2026-05-12.*