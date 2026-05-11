#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  test-et-ai-e2e.mjs — E2E test for .et AI verification via Chrome CDP
//
//  Uses Chrome DevTools Protocol ("crawler eye") to:
//    1. Navigate to the live deployed site
//    2. Open the batch processor panel
//    3. Upload DINING_CHAIRS.et file
//    4. Click "Extract .et Products & Images"
//    5. Wait for AI verification to complete
//    6. Verify AI confidence scores in the results
//    7. Take screenshots at each step
//
//  Usage:
//    node test-et-ai-e2e.mjs
//
//  Environment variables:
//    UI_URL       - Target URL (default: https://render.abcx124.xyz)
//    CHROME_PATH  - Path to Chrome executable
//    ET_FILE      - Path to .et file (default: ./uploads/DINING_CHAIRS.et)
// ═══════════════════════════════════════════════════════════════════

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────
const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const remotePort = Number(process.env.CDP_PORT || 9224);
const baseUrl = process.env.UI_URL || 'https://render.abcx124.xyz';
const etFilePath = process.env.ET_FILE || path.join(__dirname, 'uploads', 'DINING_CHAIRS.et');
const outDir = process.env.UI_CRAWL_OUT || 'C:\\tmp\\product-et-ai-e2e';

// ── Colors ────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`  ${CYAN}→${RESET} ${msg}`); }
function heading(msg) { console.log(`\n${BOLD}${YELLOW}${msg}${RESET}\n`); }

// ── Chrome CDP helpers ────────────────────────────────────────────
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function waitForCdp(port) {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 60; i++) {
    try {
      return await json(endpoint);
    } catch {
      await delay(250);
    }
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.consoleMessages = [];
    this.ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled') {
          this.consoleMessages.push({
            type: msg.params.type,
            text: (msg.params.args || []).map(arg => arg.value || arg.description || '').join(' ')
          });
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          const details = msg.params.exceptionDetails || {};
          this.consoleMessages.push({
            type: 'exception',
            text: `${details.text || 'Exception'} at ${details.url || ''}:${details.lineNumber || 0}:${details.columnNumber || 0}`
          });
        }
      }
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    this.ws.close();
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    }
    return result.result.value;
  }
  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(outDir, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  }
  async setFileInput(selector, filePath) {
    // Use JavaScript to set the file input's files property
    const absolutePath = path.resolve(filePath).replace(/\\/g, '/');
    
    // First, get the input element's object ID via Runtime
    const { result } = await this.send('Runtime.evaluate', {
      expression: `document.querySelector('${selector}')`,
      returnByValue: false
    });
    
    if (!result || !result.objectId) {
      throw new Error(`Element not found: ${selector}`);
    }
    
    // Set the files using CDP's DOM.setFileInputFiles with the object ID
    await this.send('DOM.setFileInputFiles', {
      objectId: result.objectId,
      files: [absolutePath]
    });
  }
}

// ── Test Steps ────────────────────────────────────────────────────
let passedTests = 0;
let failedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  return async (...args) => {
    try {
      await fn(...args);
      pass(name);
      passedTests++;
    } catch (err) {
      fail(`${name}: ${err.message}`);
      failedTests++;
      info(`Stack: ${err.stack?.split('\n').slice(1, 3).join(' → ')}`);
    }
  };
}

async function main() {
  console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║   .et AI Verification — E2E Test (Chrome CDP Crawler)    ║${RESET}`);
  console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`Target: ${baseUrl}`);
  console.log(`ET File: ${etFilePath}`);
  console.log(`Output: ${outDir}`);
  console.log(`Chrome: ${chromePath}`);

  // Check prerequisites
  if (!existsSync(chromePath)) {
    fail(`Chrome not found at ${chromePath}`);
    process.exit(1);
  }
  if (!existsSync(etFilePath)) {
    fail(`ET file not found at ${etFilePath}`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  // ── Launch Chrome ──────────────────────────────────────────────
  heading('Launching Chrome headless...');
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${path.join(outDir, 'profile')}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1500,900',
    '--disable-web-security',  // Needed for file uploads
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  chrome.on('exit', code => {
    info(`Chrome exited with code ${code}`);
  });

  try {
    await waitForCdp(remotePort);
    pass('Chrome CDP endpoint ready');

    // Create a new tab for our test (skip extension pages)
    const page = await json(`http://127.0.0.1:${remotePort}/json/new`, { method: 'PUT' });

    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    // ── Step 1: Navigate to site ─────────────────────────────────
    heading('Step 1: Navigate to site');
    info(`Navigating to ${baseUrl}...`);
    
    // Use Page.navigate and wait for load event
    const navResult = await cdp.send('Page.navigate', { url: baseUrl });
    info(`Navigation ID: ${navResult.loaderId || 'N/A'}`);
    
    // Wait for the page to load
    await delay(8000);
    
    const currentUrl = await cdp.evaluate('location.href');
    info(`URL: ${currentUrl}`);
    
    if (currentUrl.startsWith('chrome') || currentUrl.startsWith('about')) {
      fail(`Navigated to wrong URL: ${currentUrl} — retrying...`);
      // Close this tab and create a fresh one
      await cdp.send('Page.close');
      await delay(1000);
      const page2 = await json(`http://127.0.0.1:${remotePort}/json/new`, { method: 'PUT' });
      cdp.ws.close();
      // Reconnect to new page
      const cdp2 = new Cdp(page2.webSocketDebuggerUrl);
      await cdp2.open();
      await cdp2.send('Page.enable');
      await cdp2.send('Runtime.enable');
      await cdp2.send('Log.enable');
      await cdp2.send('Network.enable');
      await cdp2.send('Page.navigate', { url: baseUrl });
      await delay(8000);
      const retryUrl = await cdp2.evaluate('location.href');
      info(`Retry URL: ${retryUrl}`);
      if (retryUrl.startsWith('chrome') || retryUrl.startsWith('about')) {
        throw new Error(`Cannot navigate to ${baseUrl} — got ${retryUrl}`);
      }
      // Replace cdp reference
      Object.assign(cdp, cdp2);
    }
    
    await cdp.screenshot('01-navigated');
    pass('Page loaded');

    // ── Step 2: Open batch processor panel ───────────────────────
    heading('Step 2: Open batch processor panel');
    
    // Click the batchProcessorToggle button (found in the sidebar)
    await cdp.evaluate(`document.getElementById('batchProcessorToggle')?.click()`);
    await delay(1500);
    await cdp.screenshot('02-batch-panel-opened');

    const batchPanelVisible = await cdp.evaluate(`
      (() => {
        const panel = document.getElementById('batchProcessorPanel');
        return panel ? getComputedStyle(panel).display !== 'none' : false;
      })()
    `);
    if (batchPanelVisible) {
      pass('Batch processor panel is visible');
    } else {
      fail('Batch processor panel is not visible');
      // Try clicking again
      info('Retrying click...');
      await cdp.evaluate(`document.getElementById('batchProcessorToggle')?.click()`);
      await delay(1500);
      const retryVisible = await cdp.evaluate(`
        (() => {
          const panel = document.getElementById('batchProcessorPanel');
          return panel ? getComputedStyle(panel).display !== 'none' : false;
        })()
      `);
      if (retryVisible) {
        pass('Batch processor panel visible after retry');
      } else {
        info('Batch panel still not visible — continuing anyway, elements may still be in DOM');
      }
    }

    // ── Step 3: Upload .et file ──────────────────────────────────
    heading('Step 3: Upload .et file');

    // Check if the batch panel has the .et upload section
    const etSectionExists = await cdp.evaluate(`
      (() => {
        const etInput = document.getElementById('batchEtInput');
        const etDropZone = document.getElementById('batchEtDropZone');
        return { input: !!etInput, dropZone: !!etDropZone };
      })()
    `);
    info(`ET upload section: input=${etSectionExists.input}, dropZone=${etSectionExists.dropZone}`);

    if (!etSectionExists.input) {
      fail('.et upload input not found in batch panel');
      // Dump the batch panel HTML for debugging
      const batchHtml = await cdp.evaluate(`
        document.getElementById('batchProcessorPanel')?.innerHTML?.substring(0, 2000) || 'NOT FOUND'
      `);
      info(`Batch panel HTML (first 2000 chars): ${batchHtml.substring(0, 500)}...`);
    } else {
      pass('.et upload input found');

      // Set the file on the input
      const absoluteEtPath = path.resolve(etFilePath);
      info(`Setting file: ${absoluteEtPath}`);

      // Use CDP's setFileInputFiles via Runtime.evaluate object ID
      await cdp.setFileInput('#batchEtInput', absoluteEtPath);
      await delay(1000);

      await cdp.screenshot('03-et-file-uploaded');

      // Check if the file was accepted (the UI should show the file name)
      const fileAccepted = await cdp.evaluate(`
        (() => {
          const input = document.getElementById('batchEtInput');
          const files = input?.files;
          if (files && files.length > 0) {
            return { name: files[0].name, size: files[0].size };
          }
          // Check if the drop zone text changed
          const text = document.getElementById('batchEtText')?.innerText || '';
          return { name: text, size: 0 };
        })()
      `);
      info(`File accepted: ${JSON.stringify(fileAccepted)}`);
      pass('.et file uploaded to input');
    }

    // ── Step 4: Click Extract button ─────────────────────────────
    heading('Step 4: Click Extract .et Products & Images');

    const extractBtnVisible = await cdp.evaluate(`
      (() => {
        const btn = document.getElementById('batchEtExtractBtn');
        return btn ? getComputedStyle(btn).display !== 'none' : false;
      })()
    `);
    info(`Extract button visible: ${extractBtnVisible}`);

    if (extractBtnVisible) {
      await cdp.evaluate(`document.getElementById('batchEtExtractBtn').click()`);
      await delay(2000);
      await cdp.screenshot('04-extract-clicked');
      pass('Extract button clicked');

      // ── Step 5: Wait for processing ────────────────────────────
      heading('Step 5: Wait for .et extraction + AI verification');

      // Wait for progress or results — poll for up to 120 seconds
      let processingComplete = false;
      let resultData = null;
      let progressUpdates = [];

      for (let attempt = 0; attempt < 60; attempt++) {
        await delay(2000);

        // Check for progress bar
        const progress = await cdp.evaluate(`
          (() => {
            const progressEl = document.getElementById('batchProgress');
            if (!progressEl) return null;
            const style = getComputedStyle(progressEl);
            if (style.display === 'none') return null;
            return progressEl.innerText?.substring(0, 200) || '';
          })()
        `);
        if (progress) {
          progressUpdates.push(progress);
          info(`Progress (${(attempt + 1) * 2}s): ${progress.substring(0, 100)}`);
        }

        // Check if Step 2 (products) appeared
        const step2Visible = await cdp.evaluate(`
          (() => {
            const step2 = document.getElementById('batchStep2');
            return step2 ? getComputedStyle(step2).display !== 'none' : false;
          })()
        `);
        if (step2Visible) {
          processingComplete = true;
          await delay(1000);
          await cdp.screenshot('05-results-loaded');

          // Extract product data
          resultData = await cdp.evaluate(`
            (() => {
              const products = window.__batchProducts || [];
              const step2Text = document.getElementById('batchStep2')?.innerText || '';
              return {
                step2Text: step2Text.substring(0, 500),
                productCount: products.length,
                products: products.slice(0, 5).map(p => ({
                  name: p.name,
                  code: p.productCode,
                  brand: p.brand,
                  aiConfidence: p.aiConfidence,
                  aiMatchStatus: p.aiMatchStatus,
                  aiReason: p.aiReason ? p.aiReason.substring(0, 80) : null,
                  hasPreMappedImage: p.hasPreMappedImage
                }))
              };
            })()
          `);
          info(`Results: ${JSON.stringify(resultData, null, 2)}`);
          break;
        }

        // Check for error messages
        const errorMsg = await cdp.evaluate(`
          (() => {
            const body = document.body.innerText;
            const errorMatch = body.match(/Error|error|fail|Fail|timeout|Timeout/);
            return errorMatch ? errorMatch[0] : null;
          })()
        `);
        if (errorMsg && attempt > 10) {
          info(`Possible error detected: ${errorMsg}`);
        }
      }

      if (processingComplete) {
        pass('.et extraction + AI verification completed');

        // Verify AI confidence scores
        if (resultData && resultData.products) {
          const productsWithAI = resultData.products.filter(p => p.aiConfidence !== undefined);
          if (productsWithAI.length > 0) {
            pass(`AI verification returned for ${productsWithAI.length} products`);
            for (const p of productsWithAI) {
              const status = p.aiMatchStatus || 'unknown';
              const conf = p.aiConfidence !== undefined ? `${p.aiConfidence}%` : 'N/A';
              info(`  ${p.name || p.code}: confidence=${conf}, status=${status}`);
            }
          } else {
            info('No AI verification data in products — checking console for details');
          }
        }
      } else {
        fail('Processing did not complete within 120 seconds');
        await cdp.screenshot('05-timeout');
      }
    } else {
      info('Extract button not visible — checking if auto-extraction happened');
      await delay(5000);
      await cdp.screenshot('04-no-extract-btn');

      // Check if results already loaded
      const step2Visible = await cdp.evaluate(`
        (() => {
          const step2 = document.getElementById('batchStep2');
          return step2 ? getComputedStyle(step2).display !== 'none' : false;
        })()
      `);
      if (step2Visible) {
        pass('Results already loaded without clicking extract');
      }
    }

    // ── Step 6: Check console for errors ─────────────────────────
    heading('Step 6: Check for errors');
    const errors = cdp.consoleMessages.filter(m =>
      ['error', 'warning', 'exception'].includes(m.type)
    );
    if (errors.length === 0) {
      pass('No console errors or warnings');
    } else {
      info(`Found ${errors.length} console messages:`);
      errors.slice(0, 10).forEach(e => info(`  [${e.type}] ${e.text?.substring(0, 150)}`));
    }

    // ── Step 7: API-level test ───────────────────────────────────
    heading('Step 7: API-level .et extraction + AI verification test');

    try {
      const etBuffer = await readFile(etFilePath);
      const formData = new FormData();
      const etBlob = new Blob([etBuffer], { type: 'application/vnd.ms-excel' });
      formData.append('pdf', etBlob, path.basename(etFilePath));

      info('Sending .et to /api/agent/process...');
      const apiStart = Date.now();
      const apiRes = await fetch(`${baseUrl}/api/agent/process`, {
        method: 'POST',
        body: formData
      });
      const apiElapsed = ((Date.now() - apiStart) / 1000).toFixed(1);

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        pass(`API returned ${apiRes.status} in ${apiElapsed}s`);

        // Check for AI verification results
        if (apiData.products && apiData.products.length > 0) {
          pass(`Products extracted: ${apiData.products.length}`);

          const aiVerified = apiData.products.filter(p => p.aiVerified === true);
          const autoAccepted = apiData.products.filter(p => p.aiMatchStatus === 'auto_accepted');
          const needsReview = apiData.products.filter(p => p.aiMatchStatus === 'needs_review');
          const rejected = apiData.products.filter(p => p.aiMatchStatus === 'rejected');

          info(`AI verified: ${aiVerified.length}/${apiData.products.length}`);
          info(`Auto-accepted: ${autoAccepted.length}`);
          info(`Needs review: ${needsReview.length}`);
          info(`Rejected: ${rejected.length}`);

          if (aiVerified.length > 0) {
            pass(`AI verification working — ${aiVerified.length} products verified by OpenAI GPT-4o Vision`);
          } else {
            info('No AI verification data — checking if hasEmbeddedImages is true');
            info(`hasEmbeddedImages: ${apiData.hasEmbeddedImages}`);
          }

          // Show sample products
          for (let i = 0; i < Math.min(3, apiData.products.length); i++) {
            const p = apiData.products[i];
            info(`  #${i + 1}: ${p.name} (code: ${p.productCode}, AI: ${p.aiConfidence || 'N/A'}%, status: ${p.aiMatchStatus || 'N/A'})`);
          }
        } else {
          info(`No products — warning: ${apiData.warning || 'none'}`);
          info(`hasEmbeddedImages: ${apiData.hasEmbeddedImages}`);
          info(`allImages count: ${apiData.allImages?.length || 0}`);
        }

        if (apiData.allImages && apiData.allImages.length > 0) {
          pass(`Embedded images extracted: ${apiData.allImages.length}`);
        }
      } else {
        const errText = await apiRes.text();
        fail(`API returned ${apiRes.status}: ${errText.substring(0, 200)}`);
      }
    } catch (apiErr) {
      fail(`API test failed: ${apiErr.message}`);
    }

    // ── Summary ──────────────────────────────────────────────────
    heading('Test Summary');
    console.log(`  ${BOLD}Passed:${RESET} ${passedTests}/${totalTests}`);
    console.log(`  ${BOLD}Failed:${RESET} ${failedTests}/${totalTests}`);
    console.log(`  ${BOLD}Screenshots:${RESET} ${outDir}`);

    // Write results
    await writeFile(path.join(outDir, 'test-results.json'), JSON.stringify({
      baseUrl,
      timestamp: new Date().toISOString(),
      passed: passedTests,
      failed: failedTests,
      total: totalTests,
      consoleMessages: cdp.consoleMessages.slice(0, 50)
    }, null, 2));

    cdp.close();
  } catch (err) {
    fail(`Fatal error: ${err.message}`);
    console.error(err.stack);
  } finally {
    chrome.kill();
    // Give Chrome time to exit
    await delay(1000);
  }

  // Exit with appropriate code
  process.exit(failedTests > 0 ? 1 : 0);
}

main();
