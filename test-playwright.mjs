import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent('<h1>Hello World</h1>');
const buf = await page.screenshot({ type: 'png' });
console.log('Screenshot size:', buf.length, 'bytes');
await browser.close();
console.log('DONE');
