/**
 * Browser entry for the local-first warehouse spike.
 *
 * Exposes window.__wh so the Playwright driver can script the same flows a user
 * would click: init, write, read, export, close.
 */
import * as duckdb from './vendor/duckdb-browser.mjs';
import { LocalWarehouse, capabilities } from '../src/warehouse.js';

const out = document.getElementById('out');
const print = (line) => {
  out.textContent += `${line}\n`;
};

const BUNDLES = {
  base: {
    mainModule: './vendor/duckdb-base.wasm',
    mainWorker: './vendor/duckdb-browser-base.worker.js',
  },
};

async function createDuckDB() {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

const MIGRATIONS = [
  { version: 1, up: `CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR, amount DECIMAL(10,2))` },
  { version: 2, up: `ALTER TABLE items ADD COLUMN created_at TIMESTAMP DEFAULT current_timestamp` },
];

const warehouse = new LocalWarehouse({
  name: 'demo.duckdb',
  migrations: MIGRATIONS,
  idleCheckpointMs: 120,
});

window.__wh = {
  caps: () => capabilities(),
  role: () => warehouse.role,
  log: () => warehouse.log,
  checkpoints: () => warehouse.checkpoints,

  async init() {
    const role = await warehouse.start(createDuckDB);
    print(`role=${role}`);
    return role;
  },
  async write(n = 1000) {
    await warehouse.query(
      `INSERT INTO items (id, name, amount)
       SELECT i, 'item-' || i, (i % 100)::DECIMAL(10,2) FROM range(${Number(n)}) t(i)`,
    );
    return 'ok';
  },
  async count() {
    const rows = await warehouse.query('SELECT count(*) AS c FROM items');
    return Number(rows[0].c);
  },
  async tables() {
    const rows = await warehouse.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY 1`,
    );
    return rows.map((r) => r.table_name);
  },
  async userVersion() {
    const rows = await warehouse.query(
      'SELECT max(version) AS v FROM _schema_migrations',
    );
    return Number(rows[0].v ?? 0);
  },
  async flush() {
    return warehouse.flush();
  },
  async exportSize() {
    try {
      const bytes = await warehouse.exportDatabase();
      return bytes.byteLength;
    } catch (error) {
      return `unavailable: ${error.message}`;
    }
  },
  async close() {
    await warehouse.destroy();
    return 'closed';
  },
};

const caps = capabilities();
document.getElementById('caps').textContent = caps.persistent
  ? '当前为持久化模式：OPFS + Web Locks 可用，支持多标签页。'
  : `当前为内存模式（${caps.reason}）。功能可验证，但刷新即丢失、无法多标签页。走 https 或 localhost 才启用持久化。`;
print(caps.persistent
  ? 'OPFS + Web Locks available — persistent, multi-tab'
  : `degraded: ${caps.reason}`);
print('');

document.getElementById('init').onclick = () => warehouse.start(createDuckDB).then((r) => print(`role=${r}`));
document.getElementById('write').onclick = () => window.__wh.write().then((r) => print(`write ${r}`));
document.getElementById('read').onclick = () => window.__wh.count().then((c) => print(`count=${c}`));
document.getElementById('export').onclick = () => window.__wh.exportSize().then((n) => print(`db bytes=${n}`));
document.getElementById('close').onclick = () => window.__wh.close().then(() => print('closed'));
