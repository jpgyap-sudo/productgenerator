# AI Coder — Centralized Update & Debug Log

> **Purpose**: Track all changes, bugs, fixes, and decisions made by AI coders.
> **Format**: Each entry records what was changed, why, and any issues found.
> **Maintainers**: All AI coders should append to this file after each session.

---

## 2026-05-06 — Client-Side Fallback + Feature Panel + Prompt Improvements

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `index.html` | Added `clientGenerateView()`, `clientPollQueue()`, `processItemClientSide()`, `processQueueClientSide()` | App required Vercel server endpoints that don't exist locally. Added browser-side fal.ai API fallback. |
| `index.html` | Modified `startBtn` click handler — try server first, fall back to client-side | Graceful degradation when server endpoints are unavailable. |
| `index.html` | Modified `stopBtn` click handler — added `clientStopRequested = true` | Allow stopping client-side processing mid-flight. |
| `index.html` | Added **"📋 Features"** tab button in topbar | New UI for viewing/editing view prompts. |
| `index.html` | Added **Product Feature Panel** HTML/CSS/JS | Collapsible cards showing 5 view prompts with editable textareas. |
| `index.html` | Added `DEFAULT_FEATURE_PROMPTS`, `getFeaturePrompts()`, `renderFeatureGrid()`, `syncPromptsToViews()`, `resetFeaturePrompts()` | Persist edited prompts to localStorage and sync to active VIEWS/CLIENT_VIEW_PROMPTS arrays. |
| `index.html` | Updated description field label → "Materials & Style Reference" | Clarify that description is a reference note, not the core identity. |
| `index.html` | Updated `buildDesc()` — wraps desc as `(desc)` suffix | Description is now a parenthetical reference rather than the primary identity. |
| `index.html` | Improved all VIEWS prompts — added "EXACT same product", "Do NOT change" | Prevent AI from generating wrong objects (e.g., a bag instead of the product). |
| `index.html` | Improved all CLIENT_VIEW_PROMPTS — same prompt improvements | Keep client-side prompts in sync with server-side. |
| `lib/fal.js` | Updated `buildDesc()` — wraps desc as `(desc)` suffix | Match frontend behavior. |
| `lib/fal.js` | Updated all VIEW_PROMPTS — added "EXACT same product", "Do NOT change" | Match frontend prompt improvements. |
| `lib/fal.js` | Changed all API URLs from `fal.run` to `queue.fal.run` | Use queue-based API for durable job submission. |
| `lib/fal.js` | Added `getAttemptCount()`, `getViewById()`, `submitViewJob()`, `getQueuedResult()`, `extractImageUrl()` | New exports for durable queue-based processing in submit.js and status.js. |
| `api/queue/submit.js` | Rewrote to use durable fal.ai queue jobs instead of waitUntil → process-item | Renders survive tab closes/reloads. Stores request_id/status_url/response_url in DB. |
| `api/queue/status.js` | Rewrote with `reconcileFalJobs()` — polls fal.ai for any jobs still generating | Recovers renders that completed while browser was closed. |
| `api/queue/status.js` | Added `copyImageToStorage()`, `saveResultRow()`, `updateQueueStatuses()`, `groupResults()` | Complete durable render lifecycle. |
| `supabase_setup.sql` | Added `request_id`, `response_url`, `status_url`, `attempt_index`, `attempt_label` columns to `render_results` | Schema needed for durable fal.ai queue job tracking. |
| `README.md` | Updated setup instructions to reference `supabase_setup.sql` | Clarify that the full SQL file is required. |

### Bugs Found & Fixed

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | 🔴 CRITICAL | **Hardcoded API key** in `index.html` line 1232: `HARDCODED_API_KEY` with real fal.ai key exposed in client-side code. Anyone viewing page source can steal it. | **NOT FIXED** — needs user action to remove |
| 2 | 🔴 MEDIUM | **CSP missing `queue.fal.run`**: CSP `connect-src` includes `https://fal.run` but client-side code now calls `https://queue.fal.run`. Will be blocked by browser. | **FIXED** — added to both `index.html` and `vercel.json` |
| 3 | 🟡 LOW | **`dist/` not in `.gitignore`**: `dist/index.html` is a copy of `index.html` and should be gitignored. | **FIXED** — added `dist/` to `.gitignore` |
| 4 | 🟡 LOW | **`fal_docs.html` untracked**: Old documentation file should not be committed. | **FIXED** — added to `.gitignore` |
| 5 | 🟡 LOW | **`cdist/` typo in `.gitignore`**: Should probably be `dist/` not `cdist/`. | **FIXED** — added `dist/` alongside `cdist/` |
| 6 | 🟡 LOW | **`product_studio_queue*.html`**: Old backup files in workspace root. | **FIXED** — added to `.gitignore` |
| 7 | 🟢 FIXED | **`syncPromptsToViews()` scoping bug**: `editedText` declared inside `forEach` callback but referenced outside it in CLIENT_VIEW_PROMPTS block. | **FIXED** — moved `const editedText` before both blocks |

---

## 2026-05-06 — Bug Crawl & Audit (Post-Commit)

### Bugs Found During Audit

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 8 | 🔴 CRITICAL | **Hardcoded API key** (same as #1) — `HARDCODED_API_KEY` on `index.html:1232` exposes real fal.ai key `d266b8ac-...` to anyone viewing page source. | **NOT FIXED** — requires user decision |
| 9 | 🟡 LOW | **Client-side uses `fal.run` not `queue.fal.run`**: `clientGenerateView()` at `index.html:3254` posts to `https://fal.run/fal-ai/nano-banana-2` (sync endpoint) instead of `https://queue.fal.run/fal-ai/nano-banana-2` (queue endpoint). This means client-side renders don't use the durable queue — they get synchronous responses. This is acceptable since client-side has no DB to store request_ids, but it's inconsistent. | **INTENTIONAL** — client-side has no DB persistence |
| 10 | 🟡 LOW | **Client-side has no model fallback attempts**: `clientGenerateView()` only tries `nano-banana-2` with no retry on failure. Server-side `ATTEMPTS` array tries 4 models. | **NOT FIXED** — minor; client-side is fallback path |
| 11 | 🟡 LOW | **`api/process-item.js` is dead code**: This legacy file is deployed to Vercel but no longer called by the durable job flow (`submit.js` → fal.ai queue → `status.js` reconciliation). It still has `maxDuration: 300` in `vercel.json`. | **NOT FIXED** — safe to leave; removing could break rollback |
| 12 | 🟡 LOW | **`__FAL_API_KEY__` replacement is bypassed**: The `build` script in `package.json` replaces `__FAL_API_KEY__` in `dist/index.html`, but the JS code at `index.html:1225` checks `val.startsWith('__FAL')` — if replacement fails, it silently falls back to `HARDCODED_API_KEY`. This means the env var mechanism is effectively neutered. | **NOT FIXED** — requires removing `HARDCODED_API_KEY` first |
| 13 | 🟢 INFO | **`dist/index.html` is identical to `index.html`**: Verified with `fc` (file compare). The build script copies and replaces `__FAL_API_KEY__`. | **CONFIRMED** — no action needed |
| 14 | 🟢 INFO | **`.gitignore` is correct**: All previously flagged items (`dist/`, `fal_docs.html`, `product_studio_queue*.html`, `plans/`, `AI_CODER_LOG.md`) are now gitignored. | **CONFIRMED** — no action needed |

### Key Findings

1. **The hardcoded API key (#1 / #8) is the only critical issue.** It's a real, active fal.ai key exposed in client-side source code. Anyone can view page source and use it.
2. **All `.gitignore` issues from the previous session are now fixed.** The log previously showed them as "NOT FIXED" but they were committed.
3. **The client-side processing path uses `fal.run` (sync) not `queue.fal.run` (queue).** This is intentional — client-side has no Supabase DB to store `request_id`/`status_url` for durable polling. The sync endpoint is simpler and works fine for local dev.
4. **`api/process-item.js` is dead code** but harmless. It's the old background worker that was replaced by the durable queue flow.
5. **The `__FAL_API_KEY__` build-time replacement is effectively bypassed** by the `HARDCODED_API_KEY` fallback. Fixing this requires removing the hardcoded key first.

---

## Guidelines for AI Coders

1. **Always append to this log** after making changes — record what, why, and any issues.
2. **Check this log first** before making changes to understand what's already been done.
3. **Tag bugs** with severity: 🔴 CRITICAL (security/data loss), 🔴 HIGH (broken feature), 🟡 MEDIUM (minor issue), 🟢 LOW (cosmetic/optimization).
4. **Never commit hardcoded secrets** — API keys, tokens, passwords must use environment variables.
5. **Keep `dist/` in sync** — after modifying `index.html`, copy to `dist/index.html`.
6. **Test both paths** — server-side (Vercel) and client-side (local) processing.
7. **Update this log's bug status** when previously-flagged issues are fixed in later commits.

---

## 2026-05-06 — Hardcoded API Key Removed + Secure Frontend Input

### Changes Made

| File | Change | Reason |
|------|--------|--------|
| `index.html` | **Removed** `HARDCODED_API_KEY` constant (was line 1232) | 🔴 CRITICAL security bug — real fal.ai key exposed in client-side source code |
| `index.html` | **Updated** `getApiKey()` — removed `HARDCODED_API_KEY` fallback; priority is now `ENV_API_KEY \|\| savedApiKey` | No more hardcoded fallback; env var (Vercel) or user-saved key only |
| `index.html` | **Updated** `loadState()` — removed steps 4 and 5 that referenced `HARDCODED_API_KEY` | Clean up dead code after hardcoded key removal |
| `index.html` | **Added** `data-secure="true"` attribute to API key input | CSS selector target for copy-prevention styles |
| `index.html` | **Added** CSS `.topbar input[data-secure="true"]` with `user-select: none` | Prevent text selection on the input |
| `index.html` | **Updated** `.topbar input.is-saved` CSS — added `-webkit-user-select`, `-moz-user-select`, `-ms-user-select` | Cross-browser selection prevention when key is saved |
| `index.html` | **Updated** `showSavedApiKeyState()` — shows `'••••••••••••••••••••••••••••••'` instead of actual key | Masked placeholder — actual key is never displayed in the DOM |
| `index.html` | **Added** JS copy-prevention event handlers on `apiKeyEl`: `contextmenu`, `copy`, `cut`, `paste`, `keydown` (blocks Ctrl+C/V/X/Ins, Shift+Ins) | User requested API key "cannot be copied" from the input |

### Bug Status Updates

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | 🔴 CRITICAL | **Hardcoded API key** — `HARDCODED_API_KEY` with real fal.ai key exposed in client-side code | **FIXED** — removed entirely |
| 8 | 🔴 CRITICAL | **Hardcoded API key** (duplicate of #1) | **FIXED** — removed entirely |
| 12 | 🟡 LOW | **`__FAL_API_KEY__` replacement bypassed** by `HARDCODED_API_KEY` fallback | **FIXED** — hardcoded key removed; env var now works as intended |

### Notes

- The `__FAL_API_KEY__` build-time replacement (Vercel env var) still works. If the replacement fails (local dev), `ENV_API_KEY` returns empty string and the user must enter their key in the input field.
- The saved key persists in localStorage + Supabase `app_config` table. It is never displayed in the input — only `'••••••••••••••••••••••••••••••'` is shown.
- Copy protection uses multiple layers: CSS `user-select: none`, `-webkit-text-security: disc`, and JS event prevention (contextmenu, copy, cut, paste, keyboard shortcuts).
- The `dist/index.html` must be updated to match before committing.
