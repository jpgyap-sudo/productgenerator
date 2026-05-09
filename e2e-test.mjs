#!/usr/bin/env node
// E2E crawler test for /completebatch
import puppeteer from 'puppeteer';

const URL = 'https://render.abcx124.xyz/completebatch';

async function run() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push('PAGE ERROR: ' + err.message));

  console.log('Navigating to', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  try {
    await page.waitForFunction(
      () => {
        const c = document.getElementById('crContent');
        return c && !c.innerHTML.includes('Loading completed batches');
      },
      { timeout: 8000 }
    );
  } catch (e) {
    console.log('Timed out waiting for crContent to load');
  }

  const diag = await page.evaluate(() => {
    function info(el) {
      if (!el) return { exists: false };
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        exists: true,
        display: s.display,
        visibility: s.visibility,
        width: s.width,
        height: s.height,
        flex: s.flex,
        flexDir: s.flexDirection,
        gridTplCols: s.gridTemplateColumns,
        overflow: s.overflow,
        rect: `${r.width.toFixed(0)}x${r.height.toFixed(0)} @ (${r.top.toFixed(0)},${r.left.toFixed(0)})`,
        classes: el.className
      };
    }

    const layout = document.querySelector('.layout');
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('.main');
    const completedPanel = document.getElementById('completedPanel');
    const aboutSection = completedPanel?.querySelector('.about-section');
    const aboutCard = completedPanel?.querySelector('.about-card');
    const crShell = document.querySelector('.cr-shell');
    const crMain = document.getElementById('crMain');
    const crContent = document.getElementById('crContent');

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      layout: info(layout),
      sidebar: info(sidebar),
      main: info(main),
      completedPanel: info(completedPanel),
      aboutSection: info(aboutSection),
      aboutCard: info(aboutCard),
      crShell: info(crShell),
      crMain: info(crMain),
      crContent: info(crContent),
      batchCards: document.querySelectorAll('.cr-batch-card').length,
      crContentPreview: crContent?.innerHTML?.slice(0, 200) || 'MISSING'
    };
  });

  console.log('\n=== LAYOUT CHAIN ===');
  ['layout','sidebar','main','completedPanel','aboutSection','aboutCard','crShell','crMain','crContent'].forEach(k => {
    const d = diag[k];
    if (!d.exists) { console.log(`${k}: MISSING`); return; }
    console.log(`${k}: rect=${d.rect} display=${d.display} width=${d.width}${d.gridTplCols ? ' gridCols='+d.gridTplCols : ''}${d.classes ? ' class="'+d.classes+'"' : ''}`);
  });

  console.log('\n=== VIEWPORT ===', diag.viewport);
  console.log('=== BATCH CARDS ===', diag.batchCards);
  console.log('=== CONTENT PREVIEW ===', diag.crContentPreview);

  if (consoleErrors.length) {
    console.log('\n=== CONSOLE ERRORS ===');
    consoleErrors.forEach(e => console.log(' ✗', e));
  }

  await browser.close();
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
