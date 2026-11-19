/**
 * Drives the comparison page in a real browser and prints the measured table.
 * Usage: node test/run-compare.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:8765';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${BASE}/public/compare.html?repeat=${process.env.REPEAT ?? 1}`, { waitUntil: 'load' });
await page.click('#run');
await page.waitForFunction(() => window.__done === true, null, { timeout: 300000 });

const results = await page.evaluate(() => window.__results);
const log = await page.textContent('#log');

console.log('--- page log ---');
console.log(log.trim());
console.log('\n--- results ---');
for (const [key, r] of Object.entries(results)) {
  console.log(
    `${r.label.padEnd(22)} load=${r.loadMs.toFixed(0).padStart(6)}ms  ` +
      `q1=${r.q1.ms.toFixed(0).padStart(5)}ms  q6=${r.q6.ms.toFixed(0).padStart(5)}ms  rows=${r.rowCount}`,
  );
}

// Cross-engine correctness: the Q6 revenue must agree to the cent.
const revenues = Object.entries(results).map(([k, r]) => [k, Number(r.q6.result[0].revenue)]);
const base = revenues[0][1];
console.log('\nQ6 revenue per engine:', revenues.map(([k, v]) => `${k}=${v.toFixed(2)}`).join('  '));
console.log('max relative diff:', Math.max(...revenues.map(([, v]) => Math.abs(v - base) / base)).toExponential(2));

await browser.close();
