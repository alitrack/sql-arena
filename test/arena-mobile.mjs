import { chromium, devices } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 14'] });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror', e=>errs.push(e.message.slice(0,120)));
await p.goto('http://127.0.0.1:8791/public/arena.html', {waitUntil:'load'});
await p.waitForFunction(() => !!window.__arena);
await p.evaluate(() => window.__arena.loadDemo());
const res = await p.evaluate(() => window.__arena.runSql(
  'SELECT l_returnflag, sum(l_quantity) AS q FROM lineitem GROUP BY 1 ORDER BY 1'));
const lay = await p.evaluate(() => ({ vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
console.log('layout:', JSON.stringify(lay), 'overflow:', lay.sw > lay.vw);
for (const r of res) console.log(`${r.name.padEnd(20)} ok=${r.ok} ${r.ok?r.ms.toFixed(1)+'ms':String(r.error).slice(0,60)}`);
console.log('errors:', errs.length?errs.join('|'):'none');
await b.close();
