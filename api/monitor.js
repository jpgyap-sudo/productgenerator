// ═══════════════════════════════════════════════════════════════════
//  API Monitoring Endpoint
//  Lightweight health checks for all configured external services.
//  Returns JSON with per-service status, latency, and error details.
//  Called by the frontend 📡 Monitor tab.
// ═══════════════════════════════════════════════════════════════════

import { supabase, QUEUE_TABLE } from '../lib/supabase.js';

/**
 * Measure the time (ms) of an async operation.
 */
async function timed(promise) {
  const start = Date.now();
  try {
    const result = await promise;
    return { ok: true, latencyMs: Date.now() - start, data: result };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message || String(err) };
  }
}

/**
 * Check Supabase connectivity by doing a lightweight head query.
 */
async function checkSupabase() {
  return timed(
    supabase
      .from(QUEUE_TABLE)
      .select('id', { count: 'exact', head: true })
      .limit(1)
  );
}

/**
 * Check OpenAI API by listing models (lightweight auth check).
 */
async function checkOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return { ok: false, latencyMs: 0, error: 'OPENAI_API_KEY is not set' };
  }
  return timed(
    fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => {
      if (!r.ok) throw new Error(`OpenAI returned ${r.status}: ${r.statusText}`);
      return r.json();
    })
  );
}

/**
 * Check Gemini API by listing available models (lightweight auth check).
 */
async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { ok: false, latencyMs: 0, error: 'GEMINI_API_KEY is not set' };
  }
  return timed(
    fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
      signal: AbortSignal.timeout(10000)
    }).then(r => {
      if (!r.ok) throw new Error(`Gemini returned ${r.status}: ${r.statusText}`);
      return r.json();
    })
  );
}

/**
 * Check Stability AI API by reading account details.
 */
async function checkStability() {
  const key = process.env.STABILITY_API_KEY;
  if (!key) {
    return { ok: false, latencyMs: 0, error: 'STABILITY_API_KEY is not set' };
  }
  return timed(
    fetch('https://api.stability.ai/v1/user/account', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    }).then(r => {
      if (!r.ok) throw new Error(`Stability AI returned ${r.status}: ${r.statusText}`);
      return r.json();
    })
  );
}

/**
 * Check Google Drive API by verifying the service account JSON and
 * doing a minimal files.list call.
 */
async function checkDrive() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    return { ok: false, latencyMs: 0, error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not set' };
  }
  try {
    JSON.parse(saJson);
  } catch {
    return { ok: false, latencyMs: 0, error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON' };
  }

  return timed(
    (async () => {
      const { google } = await import('googleapis');
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(saJson),
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.files.list({
        pageSize: 1,
        fields: 'files(id, name)',
        signal: AbortSignal.timeout(10000)
      });
      return { fileCount: res.data.files ? res.data.files.length : 0 };
    })()
  );
}

/**
 * GET /api/monitor — run all health checks in parallel and return results.
 */
export default async function handler(req, res) {
  const start = Date.now();

  const [supabase, openai, gemini, stability, drive] = await Promise.all([
    checkSupabase(),
    checkOpenAI(),
    checkGemini(),
    checkStability(),
    checkDrive()
  ]);

  const services = { supabase, openai, gemini, stability, drive };
  const allOk = Object.values(services).every(s => s.ok);

  const result = {
    timestamp: new Date().toISOString(),
    totalLatencyMs: Date.now() - start,
    allOk,
    services
  };

  // Strip raw data from response to keep it lean
  for (const key of Object.keys(services)) {
    if (services[key].data !== undefined) delete services[key].data;
  }

  res.json(result);
}
