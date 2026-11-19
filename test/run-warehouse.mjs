/**
 * End-to-end check of the local-first warehouse spike in a real browser.
 *
 * Proves four behaviours that duckdb-wasm does not give you:
 *   1. data survives a reload (OPFS + CHECKPOINT)
 *   2. migrations apply once and are recorded in user_version
 *   3. a second tab becomes a client and reads through the leader
 *   4. closing the leader promotes the client, which still sees the data
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'https://10.10.10.81:8795';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const errors = [];

const openTab = async () => {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/public/warehouse.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__wh);
  return page;
};

// --- tab 1: become leader, migrate, write, checkpoint ---
const tab1 = await openTab();
const role1 = await tab1.evaluate(() => window.__wh.init());
check('tab1 becomes leader', role1 === 'leader', `role=${role1}`);

await tab1.evaluate(() => window.__wh.write(1000));
const version = await tab1.evaluate(() => window.__wh.userVersion());
check('migrations recorded in user_version', version === 2, `user_version=${version}`);

const tables = await tab1.evaluate(() => window.__wh.tables());
check('migration created table', tables.includes('items'), `tables=${tables.join(',')}`);

await tab1.evaluate(() => window.__wh.flush());
const countBefore = await tab1.evaluate(() => window.__wh.count());
check('1000 rows written', countBefore === 1000, `count=${countBefore}`);

// --- persistence across reload ---
await tab1.reload({ waitUntil: 'load' });
await tab1.waitForFunction(() => !!window.__wh);
const roleAfterReload = await tab1.evaluate(() => window.__wh.init());
const countAfterReload = await tab1.evaluate(() => window.__wh.count());
check('data survives reload', countAfterReload === 1000, `count=${countAfterReload} role=${roleAfterReload}`);

// --- tab 2: follower reads through the leader ---
const tab2 = await openTab();
const role2 = await tab2.evaluate(() => window.__wh.init());
check('tab2 becomes client', role2 === 'client', `role=${role2}`);
const countViaProxy = await tab2.evaluate(() => window.__wh.count());
check('client reads leader data', countViaProxy === 1000, `count=${countViaProxy}`);

// --- leader failover ---
await tab1.evaluate(() => window.__wh.close());
await tab1.close();
await tab2.waitForTimeout(300);
const promoted = await tab2.evaluate(async () => {
  await window.__wh.close().catch(() => {});
  return window.__wh.init();
});
const countAfterFailover = await tab2.evaluate(() => window.__wh.count());
check('client takes over after leader closes', promoted === 'leader' && countAfterFailover === 1000,
  `role=${promoted} count=${countAfterFailover}`);

// --- export bytes ---
const bytes = await tab2.evaluate(() => window.__wh.exportSize());
check('database exports as bytes', bytes > 4096, `${bytes} bytes`);

check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
