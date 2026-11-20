/**
 * Drives the SQL Arena page: load demo data, run user-style SQL, assert that
 * all three engines agree and that no engine errored.
 */
import { chromium } from 'playwright';
const PORT = process.env.PORT ?? '8791';
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0, 200)));
p.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 200)); });

await p.goto(`${BASE}/public/arena.html`, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__arena, null, { timeout: 30000 });

const n = await p.evaluate(() => window.__arena.loadDemo());
console.log('datasets loaded:', n);
console.log('schema:', JSON.stringify(await p.evaluate(() => window.__arena.datasets()), null, 1).slice(0, 700));

const SQL = `SELECT n.n_name AS nation, r.r_name AS region, count(*) AS orders
FROM orders o
JOIN customer c ON o.o_custkey = c.c_custkey
JOIN nation n ON c.c_nationkey = n.n_nationkey
JOIN region r ON n.n_regionkey = r.r_regionkey
GROUP BY n.n_name, r.r_name ORDER BY orders DESC LIMIT 5`;

const res = await p.evaluate((sql) => window.__arena.runSql(sql), SQL);
const failures = [];
for (const r of res) {
  console.log(`${r.name.padEnd(20)} ok=${r.ok} ${r.ok ? r.ms.toFixed(1)+'ms rows='+r.rows : 'ERR '+String(r.error).slice(0,80)}`);
  if (r.ok) console.log('   compare:', JSON.stringify(r.compare));
  if (!r.ok) { failures.push(`${r.name}: engine error — ${r.error}`); continue; }
  const cmp = r.compare;
  if (!cmp?.equal) failures.push(`${r.name}: result disagreement ${JSON.stringify(cmp?.firstDiff ?? cmp)}`);
  else if (cmp.orderMatches === false) failures.push(`${r.name}: row order differs ${JSON.stringify(cmp)}`);
}
console.log('errors:', errs.length ? errs.slice(0,3).join(' | ') : 'none');
await b.close();

// CI gate: the page is only loadable AND the three engines must agree. A
// silent disagreement used to exit 0 — that's the whole point of this test.
if (failures.length) {
  console.error('\nFAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nPASS: all engines ran and agree on the four-table join');
