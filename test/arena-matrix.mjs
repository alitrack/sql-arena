/** Runs several query shapes and prints a compact verdict per shape. */
import { chromium } from 'playwright';
const PORT = process.env.PORT ?? '8791';
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
await p.goto(`${BASE}/public/arena.html`, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__arena);
await p.evaluate(() => window.__arena.loadDemo());

const CASES = {
  'single-agg': `SELECT l_returnflag, sum(l_quantity) AS qty, count(*) AS n
FROM lineitem GROUP BY 1 ORDER BY 1`,
  'four-join': `SELECT n.n_name AS nation, r.r_name AS region, count(*) AS orders
FROM orders o JOIN customer c ON o.o_custkey=c.c_custkey
JOIN nation n ON c.c_nationkey=n.n_nationkey
JOIN region r ON n.n_regionkey=r.r_regionkey
GROUP BY 1,2 ORDER BY 3 DESC LIMIT 5`,
  'window': `SELECT l_returnflag, sum(l_quantity) AS qty,
       rank() OVER (ORDER BY sum(l_quantity) DESC) AS rk
FROM lineitem GROUP BY 1 ORDER BY rk`,
  'cte-join': `WITH big AS (SELECT o_custkey, sum(o_totalprice) AS total FROM orders GROUP BY 1)
SELECT c.c_mktsegment, count(*) AS n, sum(b.total) AS rev
FROM big b JOIN customer c ON b.o_custkey=c.c_custkey
GROUP BY 1 ORDER BY rev DESC`,
  'date-literal': `SELECT count(*) AS n FROM lineitem WHERE l_shipdate > DATE '1998-01-01'`,
  // Projects a bare DATE column — the shape that previously diverged across
  // engines (DuckDB epoch-ms number vs PGlite Date vs SQLite text). With M6
  // canonicalization all three render 'YYYY-MM-DD' and agree.
  'date-projection': `SELECT l_shipdate, l_shipmode FROM lineitem WHERE l_orderkey = 42`,
  'cast-numeric': `SELECT sum(CAST(l_quantity AS DOUBLE) * l_extendedprice) AS v FROM lineitem`,
};

for (const [name, sql] of Object.entries(CASES)) {
  const res = await p.evaluate((q) => window.__arena.runSql(q), sql);
  const cells = res.map(r => r.ok ? `${r.name.split(' ')[0]}=${r.ms.toFixed(1)}ms(${r.rows})` : `${r.name.split(' ')[0]}=ERR`).join('  ');
  const eq = res.filter(r=>r.ok).every(r => r.compare?.equal);
  const order = res.filter(r=>r.ok).every(r => r.compare?.orderMatches);
  console.log(`${name.padEnd(14)} ${cells}   ${eq?'✓一致':'✗分歧'}${order?'':'/顺序异'}`);
  for (const r of res) if (!r.ok) console.log(`   ${r.name}: ${String(r.error).slice(0,110)}`);
}
console.log('pageerrors:', errs.length ? errs.join(' | ') : 'none');
await b.close();
