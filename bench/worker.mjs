/**
 * One shard worker: owns its own duckdb-wasm instance and scans a subset of the
 * shard files. Partial aggregates are shipped back as JSON; the coordinator
 * merges them, so no raw rows cross the thread boundary.
 */
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DIST = path.join(path.dirname(new URL(import.meta.url).pathname), '../node_modules/@duckdb/duckdb-wasm/dist');
const duckdb = require(path.join(DIST, 'duckdb-node-blocking.cjs'));

let conn = null;

const bundles = {
  base: { mainModule: path.join(DIST, 'duckdb-base.wasm'), mainWorker: null },
};

async function init() {
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.open({ path: ':memory:', query: {} });
  conn = db.connect();
  conn.query('LOAD parquet');
  return true;
}

/** @param {string} sql */
function run(sql) {
  return conn.query(sql).toArray().map((row) => row.toJSON());
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'init') {
      await init();
      parentPort.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'query') {
      const fileList = msg.shards.map((s) => `'${s}'`).join(',');
      const sql = msg.template.replaceAll('__FILES__', fileList);
      const t0 = performance.now();
      const rows = run(sql);
      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        rows: JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))),
        elapsedMs: performance.now() - t0,
      });
      return;
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(error?.message ?? error) });
  }
});
