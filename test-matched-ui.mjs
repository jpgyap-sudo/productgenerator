// ═══════════════════════════════════════════════════════════════════
// test-matched-ui.mjs — Playwright script to screenshot the
// Matched Images UI and send to GPT-mini for improvement suggestions
//
// Usage:
//   node test-matched-ui.mjs
//   (edit BASE_URL below to change target)
// ═══════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ── CONFIG ──
const BASE_URL = 'https://render.abcx124.xyz';
const SCREENSHOT_DIR = './screenshots-matched-ui';

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // ── Step 1: Pre-fetch real matched images data via direct API call ──
  console.log('Pre-fetching matched images data from API...');
  let apiData = null;
  try {
    const apiUrl = `${BASE_URL.replace(/\/$/, '')}/api/agent/matched-images?limit=200`;
    console.log(`Fetching: ${apiUrl}`);
    const resp = await fetch(apiUrl);
    if (resp.ok) {
      apiData = await resp.json();
      console.log(`Fetched ${apiData.images?.length || 0} images from API (total: ${apiData.total || 0})`);
      if (apiData.images && apiData.images.length > 0) {
        console.log('First image sample:', JSON.stringify(apiData.images[0], null, 2).substring(0, 300));
      }
    } else {
      const text = await resp.text();
      console.log(`API returned ${resp.status}: ${text.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`Could not pre-fetch API data: ${err.message}`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // ── Step 2: Intercept the matched-images API call ──
  if (apiData && apiData.images) {
    await page.route('**/api/agent/matched-images**', (route) => {
      console.log('[INTERCEPT] Returning pre-fetched matched-images data');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(apiData)
      });
    });
    console.log('Route interception set up for /api/agent/matched-images');
  } else {
    console.log('No pre-fetched data available — will use real API call');
  }

  // Listen for console messages from the page
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.text().includes('matched') || msg.text().includes('mi-') || msg.text().includes('fetchApi')) {
      console.log(`[PAGE] ${msg.type()}: ${msg.text()}`);
    }
  });

  // Listen for network requests
  page.on('requestfailed', request => {
    if (request.url().includes('matched-images')) {
      console.log(`[NETWORK FAIL] ${request.url()}: ${request.failure()?.errorText}`);
    }
  });

  // Log all API requests for debugging
  page.on('request', request => {
    if (request.url().includes('matched-images')) {
      console.log(`[NETWORK REQ] ${request.method()} ${request.url()}`);
    }
  });
  page.on('response', response => {
    if (response.url().includes('matched-images')) {
      console.log(`[NETWORK RES] ${response.status()} ${response.url()}`);
    }
  });

  console.log(`\nNavigating to ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the app to fully render
  await page.waitForSelector('#matchedImagesToggle', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // Debug: check what's visible
  const initialVisible = await page.evaluate(() => {
    const toggle = document.getElementById('matchedImagesToggle');
    const panel = document.getElementById('matchedImagesPanel');
    const welcome = document.getElementById('welcomeState');
    return {
      toggleExists: !!toggle,
      toggleText: toggle?.textContent?.trim(),
      panelDisplay: panel?.style?.display,
      welcomeDisplay: welcome?.style?.display,
    };
  });
  console.log('Initial state:', JSON.stringify(initialVisible));

  // Take a full-page screenshot of the initial state
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-initial-state.png'), fullPage: false });
  console.log('Screenshot 01: initial state');

  // Click the Matched Images toggle button
  await page.click('#matchedImagesToggle');
  console.log('Clicked matched images toggle');

  // Wait for the matched images panel to appear
  await page.waitForSelector('#matchedImagesPanel', { state: 'visible', timeout: 15000 });
  console.log('Panel is visible');

  // Wait for content to load
  await page.waitForTimeout(5000);

  // Debug: check panel state after toggle
  const panelState = await page.evaluate(() => {
    const panel = document.getElementById('matchedImagesPanel');
    const content = document.getElementById('miContent');
    const grid = content?.querySelector('.mi-grid');
    const cards = content?.querySelectorAll('.mi-card');
    const empty = content?.querySelector('.mi-empty');
    const loading = content?.querySelector('.mi-loading');
    const stats = document.getElementById('miStats');
    const headerSub = document.querySelector('.mi-header-sub');
    return {
      panelDisplay: panel?.style?.display,
      loadingExists: !!loading,
      gridExists: !!grid,
      cardCount: cards?.length || 0,
      emptyExists: !!empty,
      contentHTML: content?.innerHTML?.substring(0, 800),
      statsHTML: stats?.innerHTML?.substring(0, 500),
      headerSubText: headerSub?.textContent,
    };
  });
  console.log('Panel state:', JSON.stringify(panelState, null, 2));

  // If still loading, wait more
  if (panelState.loadingExists && panelState.cardCount === 0) {
    console.log('Still loading, waiting 15 more seconds...');
    await page.waitForTimeout(15000);

    const panelState2 = await page.evaluate(() => {
      const content = document.getElementById('miContent');
      const grid = content?.querySelector('.mi-grid');
      const cards = content?.querySelectorAll('.mi-card');
      const loading = content?.querySelector('.mi-loading');
      return {
        loadingExists: !!loading,
        gridExists: !!grid,
        cardCount: cards?.length || 0,
        contentHTML: content?.innerHTML?.substring(0, 800),
      };
    });
    console.log('Panel state after extra wait:', JSON.stringify(panelState2, null, 2));
  }

  // Take screenshot of the full matched images panel
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-matched-images-panel.png'), fullPage: false });
  console.log('Screenshot 02: matched images panel');

  // Wait a bit more for images to load
  await page.waitForTimeout(3000);

  // Take screenshot of the grid area
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-matched-images-grid.png'), fullPage: false });
  console.log('Screenshot 03: matched images grid');

  // If there are cards, click the first one to see detail view
  const cards = await page.$$('.mi-card');
  if (cards.length > 0) {
    console.log(`Found ${cards.length} cards, clicking first...`);
    await cards[0].click();
    await page.waitForTimeout(3000);

    // Debug detail view state
    const detailState = await page.evaluate(() => {
      const detailView = document.getElementById('matchedDetailView');
      const canvasView = document.getElementById('matchedCanvasView');
      return {
        detailDisplay: detailView?.style?.display,
        canvasDisplay: canvasView?.style?.display,
        detailHTML: detailView?.innerHTML?.substring(0, 500),
      };
    });
    console.log('Detail view state:', JSON.stringify(detailState, null, 2));

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-detail-view.png'), fullPage: false });
    console.log('Screenshot 04: detail view');
  } else {
    console.log('No cards found, taking screenshot of current state');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-no-cards.png'), fullPage: false });
  }

  // Take a full-page screenshot for complete context
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-full-page.png'), fullPage: true });
  console.log('Screenshot 05: full page');

  await browser.close();
  console.log(`\nScreenshots saved to ${SCREENSHOT_DIR}/`);

  // Now read the screenshots and prepare the GPT-mini prompt
  const files = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
  console.log(`\nGenerated ${files.length} screenshots:`);
  for (const f of files) {
    const stats = fs.statSync(path.join(SCREENSHOT_DIR, f));
    console.log(`  ${f} (${(stats.size / 1024).toFixed(1)} KB)`);
  }

  // Print the GPT-mini prompt
  console.log('\n' + '='.repeat(70));
  console.log('NEXT STEP: Send these screenshots to GPT-mini with this prompt:');
  console.log('='.repeat(70));
  console.log(`
You are a UI/UX expert. Analyze these screenshots of a "Matched Images" panel
from a product rendering web application.

The Matched Images panel shows saved original product images with matched
descriptions from PDF+ZIP uploads. It has:
- A sidebar with Gallery, Statistics, Detail View navigation
- Stats cards (Total Images, Rendered, Processing, Pending, Brands, Sources)
- Search/filter bar (text search, brand filter, status filter, per-page selector)
- A grid of image cards with product name, code, brand, description, status badge
- A detail view when clicking a card (shows full image, description, metadata, actions)
- Pagination controls

Please provide specific, actionable suggestions to improve the UI/UX.
Consider: layout, visual hierarchy, information density, interactions,
responsive design, accessibility, and any missing features.
Format your response as a structured list of improvements with rationale.
`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
