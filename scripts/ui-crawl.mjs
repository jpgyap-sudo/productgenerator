import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const remotePort = Number(process.env.CDP_PORT || 9223);
const baseUrl = process.env.UI_URL || 'http://localhost:3000';
const outDir = process.env.UI_CRAWL_OUT || 'C:\\tmp\\product-ui-crawl';

if (!existsSync(chromePath)) {
  throw new Error(`Chrome not found at ${chromePath}`);
}

await mkdir(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${remotePort}`,
  `--user-data-dir=${path.join(outDir, 'profile')}`,
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1500,900',
  'about:blank'
], { stdio: 'ignore', detached: false });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function waitForCdp() {
  const endpoint = `http://127.0.0.1:${remotePort}/json/version`;
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
    this.ws.on('message', data => {
      const msg = JSON.parse(String(data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
}

await waitForCdp();
const page = await json(`http://127.0.0.1:${remotePort}/json/new?${encodeURIComponent(baseUrl)}`, { method: 'PUT' });
const cdp = new Cdp(page.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Network.enable');

const consoleMessages = [];
cdp.ws.on('message', data => {
  const msg = JSON.parse(String(data));
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleMessages.push({
      type: msg.params.type,
      text: (msg.params.args || []).map(arg => arg.value || arg.description || '').join(' ')
    });
  }
  if (msg.method === 'Log.entryAdded') {
    consoleMessages.push({ type: msg.params.entry.level, text: msg.params.entry.text });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const details = msg.params.exceptionDetails || {};
    consoleMessages.push({
      type: 'exception',
      text: `${details.text || 'Exception'} at ${details.url || ''}:${details.lineNumber || 0}:${details.columnNumber || 0} ${details.exception?.description || ''}`
    });
  }
});

await cdp.send('Page.navigate', { url: baseUrl });
await delay(3500);

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 30000
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result.value;
}

async function screenshot(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(outDir, `${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

const crawlResult = await evaluate(`(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ids = [
    ['bulkUploadToggle', 'bulkUploadPanel'],
    ['bulkRenderToggle', 'bulkRenderPanel'],
    ['batchProcessorToggle', 'batchProcessorPanel'],
    ['matchedImagesToggle', 'matchedImagesPanel'],
    ['diningChairMatchToggle', 'diningChairMatchPanel'],
    ['renderProductToggle', 'renderProductPanel'],
    ['renderQueueToggle', 'renderQueuePanel'],
    ['completedToggle', 'completedPanel'],
    ['monitorToggle', 'monitorPanel'],
    ['featureToggle', 'featurePanel'],
    ['aboutToggle', 'aboutPanel']
  ];
  const visible = el => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const state = label => ({
    label,
    title: document.title,
    url: location.href,
    visiblePanels: Array.from(document.querySelectorAll('[id$="Panel"], #welcomeState'))
      .filter(visible).map(el => el.id),
    activeButtons: Array.from(document.querySelectorAll('.tb-btn.active')).map(el => el.id),
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    docWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    leftMost: Math.min(...Array.from(document.querySelectorAll('body *')).map(el => el.getBoundingClientRect().left).filter(Number.isFinite)),
    errors: []
  });
  const results = [];
  results.push(state('initial'));
  for (const [buttonId, expectedPanel] of ids) {
    const btn = document.getElementById(buttonId);
    if (!btn) {
      results.push({ label: buttonId, missingButton: true, expectedPanel });
      continue;
    }
    btn.click();
    await wait(buttonId === 'renderQueueToggle' || buttonId === 'monitorToggle' || buttonId === 'completedToggle' || buttonId === 'matchedImagesToggle' ? 1400 : 350);
    const s = state(buttonId);
    s.expectedPanel = expectedPanel;
    s.expectedVisible = visible(document.getElementById(expectedPanel));
    s.buttonActive = btn.classList.contains('active');
    s.panelText = (document.getElementById(expectedPanel)?.innerText || '').slice(0, 220);
    results.push(s);
  }

  const interaction = {};
  document.getElementById('aboutToggle')?.click();
  await wait(200);
  document.getElementById('resolutionEditBtn')?.click();
  await wait(100);
  const res1k = document.querySelector('[data-res="1K"]');
  interaction.res1kEnabledBeforeClick = !!res1k && !res1k.disabled;
  res1k?.click();
  await wait(150);
  interaction.resolutionNote = document.getElementById('resNote')?.textContent || '';
  interaction.activeResolution = document.querySelector('[data-res].active')?.dataset.res || '';
  interaction.providerButtonDisabled = !!document.querySelector('[data-provider="openai-mini"]')?.disabled;

  document.getElementById('queueLogToggle')?.click();
  await wait(150);
  interaction.queueLogVisible = visible(document.getElementById('queueLogPanel'));
  document.getElementById('logToggle')?.click();
  await wait(150);
  interaction.failureLogVisible = visible(document.getElementById('logPanel'));

  document.getElementById('dmToggle')?.click();
  await wait(150);
  interaction.darkModeClass = document.body.className;
  document.getElementById('sidebarToggle')?.click();
  await wait(150);
  interaction.layoutClassAfterSidebarToggle = document.querySelector('.layout')?.className || '';

  const input = document.getElementById('fileInput');
  if (input) {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array([...bin].map(ch => ch.charCodeAt(0)));
    const file = new File([bytes], 'ui-crawl-chair.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
  }
  interaction.pendingAreaVisible = visible(document.getElementById('pendingArea'));
  interaction.pendingItems = document.querySelectorAll('#pendingList .q-item').length;
  interaction.confirmAddEnabled = !document.getElementById('confirmAddBtn')?.disabled;
  interaction.bulkRenderVisibleAfterUpload = visible(document.getElementById('bulkRenderPanel'));
  interaction.queueCount = document.getElementById('qCount')?.textContent || '';

  return {
    results,
    interaction,
    finalState: state('final'),
    domStats: {
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
      panels: document.querySelectorAll('[id$="Panel"]').length
    }
  };
})()`);

const finalShot = await screenshot('final');
await writeFile(path.join(outDir, 'crawl-result.json'), JSON.stringify({
  baseUrl,
  crawlResult,
  consoleMessages,
  screenshot: finalShot
}, null, 2));

console.log(JSON.stringify({
  outDir,
  screenshot: finalShot,
  panelsTested: crawlResult.results.length,
  consoleErrors: consoleMessages.filter(m => ['error', 'warning'].includes(m.type)).slice(0, 20),
  crawlResult
}, null, 2));

cdp.close();
chrome.kill();
