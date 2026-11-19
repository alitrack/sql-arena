/** Runs the three-engine page under a phone-sized viewport and mobile UA. */
import { chromium, devices } from 'playwright';
const PORT = process.env.PORT ?? '8791';
const url = `http://127.0.0.1:${PORT}/public/compare.html?repeat=1`;
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 14'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__wh === false || true);
const btn = await p.getAttribute('#run', 'disabled');
console.log('run button disabled at start:', btn !== null);
await p.click('#run', { timeout: 60000 });
await p.waitForFunction(() => window.__done === true, null, { timeout: 600000 });
const r = await p.evaluate(() => window.__results);
for (const [k, v] of Object.entries(r)) {
  console.log(`${k}: load=${v.loadMs.toFixed(0)}ms q1=${v.q1.ms.toFixed(0)}ms q6=${v.q6.ms.toFixed(0)}ms rows=${v.rowCount}`);
}
console.log('errors:', errs.length ? errs.join(' | ') : 'none');
await b.close();
