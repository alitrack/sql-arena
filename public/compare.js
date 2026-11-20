/**
 * Same-page comparison: DuckDB-Wasm vs SQLite-Wasm vs PGlite (Postgres/Wasm).
 *
 * Everything runs in this tab, same origin, no server: identical source data,
 * identical SQL semantics, per-engine dialect adjustments applied explicitly.
 */
import * as duckdb from './vendor/duckdb-browser.mjs';

const CSV_URL = '../data/lineitem_200k.csv';
// Repeat the source rows N times so the same page can show a size ladder.
const REPEAT = Math.max(1, Number(new URLSearchParams(location.search).get('repeat') ?? 1));
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const runBtn = document.getElementById('run');

const log = (msg) => {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};
const setStatus = (msg) => {
  statusEl.textContent = msg;
};

/** Ordered medians keep a single slow run from dominating a comparison. */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const Q1 = (dateFn) => `
SELECT l_returnflag, l_linestatus,
       SUM(l_quantity) AS sum_qty,
       SUM(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
       AVG(l_quantity) AS avg_qty,
       COUNT(*) AS count_order
FROM li
WHERE l_shipdate <= ${dateFn('1998-09-02')}
GROUP BY l_returnflag, l_linestatus
ORDER BY l_returnflag, l_linestatus`;

const Q6 = (dateFn) => `
SELECT SUM(l_extendedprice * l_discount) AS revenue
FROM li
WHERE l_shipdate >= ${dateFn('1994-01-01')}
  AND l_shipdate <  ${dateFn('1995-01-01')}
  AND l_discount BETWEEN 0.05 AND 0.07
  AND l_quantity < 24`;

// Dialects: DuckDB and Postgres accept DATE 'x'; SQLite has no typed date
// literal and compares ISO text instead. This asymmetry is itself a result.
const dateDuck = (d) => `DATE '${d}'`;
const dateSqlite = (d) => `'${d}'`;

const num = (v) => Number(typeof v === 'bigint' ? v : v);

/** Minimal RFC4180 parser; the lineitem comments contain commas and quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Columns every engine needs, so import cost is comparable. */
const COLUMNS = ['l_quantity', 'l_extendedprice', 'l_discount', 'l_returnflag', 'l_linestatus', 'l_shipdate'];

async function withTiming(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

/** Run one query three times after a warm-up and return the median. */
async function timeQuery(run) {
  await run();
  const times = [];
  let last;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    last = await run();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), runs: times, result: last };
}

const engines = {
  async duckdb(csvText) {
    const bundles = {
      base: {
        mainModule: './vendor/duckdb-base.wasm',
        mainWorker: './vendor/duckdb-browser-base.worker.js',
      },
    };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({ path: ':memory:' });
    const conn = await db.connect();
    await db.registerFileText('li.csv', csvText);

    const load = await withTiming(async () => {
      await conn.query(`
        CREATE TABLE li AS
        SELECT ${COLUMNS.join(', ')}
        FROM read_csv_auto('li.csv', header = true)`);
      if (REPEAT > 1) {
        await conn.query(
          `INSERT INTO li SELECT ${COLUMNS.join(', ')} FROM li CROSS JOIN range(${REPEAT - 1})`,
        );
      }
    });

    const query = async (sql) => {
      const table = await conn.query(sql);
      return table.toArray().map((row) => row.toJSON());
    };
    return {
      label: 'DuckDB-Wasm',
      version: (await query('SELECT version() AS v'))[0].v,
      loadMs: load.ms,
      q1: await timeQuery(() => query(Q1(dateDuck))),
      q6: await timeQuery(() => query(Q6(dateDuck))),
    };
  },

  async sqlite(csvText) {
    const { default: sqlite3InitModule } = await import('../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs');
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    db.exec('CREATE TABLE li (l_quantity REAL, l_extendedprice REAL, l_discount REAL, '
      + 'l_returnflag TEXT, l_linestatus TEXT, l_shipdate TEXT)');

    const load = await withTiming(async () => {
      const rows = parseCsv(csvText);
      const header = rows.shift();
      const idx = COLUMNS.map((c) => header.indexOf(c));
      db.exec('BEGIN');
      const stmt = db.prepare(
        `INSERT INTO li VALUES (${COLUMNS.map(() => '?').join(',')})`,
      );
      try {
        for (let pass = 0; pass < REPEAT; pass += 1) {
          for (const r of rows) {
            stmt.bind(idx.map((i) => r[i]));
            stmt.step();
            stmt.reset();
          }
        }
      } finally {
        stmt.finalize();
        db.exec('COMMIT');
      }
    });

    const query = async (sql) => db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' });
    return {
      label: 'SQLite-Wasm',
      version: `SQLite ${sqlite3.version.libVersion}`,
      loadMs: load.ms,
      q1: await timeQuery(() => query(Q1(dateSqlite))),
      q6: await timeQuery(() => query(Q6(dateSqlite))),
    };
  },

  async pglite(csvText) {
    const { PGlite } = await import('../node_modules/@electric-sql/pglite/dist/index.js');
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(`CREATE TABLE li (
      l_quantity NUMERIC, l_extendedprice NUMERIC, l_discount NUMERIC,
      l_returnflag TEXT, l_linestatus TEXT, l_shipdate DATE)`);

    // PGlite has no public file-write hook for COPY, so load in batched INSERTs.
    const load = await withTiming(async () => {
      const rows = parseCsv(csvText);
      const header = rows.shift();
      const idx = COLUMNS.map((c) => header.indexOf(c));
      const BATCH = 500;
      for (let pass = 0; pass < REPEAT; pass += 1) {
        for (let i = 0; i < rows.length; i += BATCH) {
          const values = rows
            .slice(i, i + BATCH)
            .map((r) => `(${idx.map((j) => `'${String(r[j]).replaceAll("'", "''")}'`).join(',')})`)
            .join(',');
          await pg.exec(`INSERT INTO li VALUES ${values}`);
        }
      }
    });

    const query = async (sql) => (await pg.query(sql)).rows;
    return {
      label: 'PGlite (Postgres 18)',
      version: (await query('SHOW server_version'))[0].server_version,
      loadMs: load.ms,
      q1: await timeQuery(() => query(Q1(dateDuck))),
      q6: await timeQuery(() => query(Q6(dateDuck))),
    };
  },
};

function render(result, rowId) {
  const row = document.getElementById(rowId);
  const memory = performance.memory
    ? `${(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(0)} MB`
    : 'n/a';
  row.className = '';
  row.innerHTML = `
    <td class="engine">${escapeHtml(result.label)}</td>
    <td>${escapeHtml(String(result.version).slice(0, 28))}</td>
    <td>${result.loadMs.toFixed(0)}</td>
    <td>${result.q1.ms.toFixed(0)}</td>
    <td>${result.q6.ms.toFixed(0)}</td>
    <td>${(result.q1.ms + result.q6.ms).toFixed(0)}</td>
    <td>${memory}</td>
    <td class="ok" data-check="${result.rowCount}">${result.rowCount} 行</td>`;
}

function renderError(rowId, error) {
  const row = document.getElementById(rowId);
  row.className = '';
  row.innerHTML = `<td class="engine">${escapeHtml(rowId.replace('row-', ''))}</td>`
    + `<td colspan="7" class="err">${escapeHtml(String(error?.message ?? error))}</td>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function main() {
  setStatus(`下载数据… (×${REPEAT})`);
  document.getElementById('dssize').textContent = `${200000 * REPEAT} 行`;
  const csvText = await fetch(CSV_URL).then((r) => {
    if (!r.ok) throw new Error(`CSV fetch failed: ${r.status}`);
    return r.text();
  });
  log(`loaded CSV ${(csvText.length / 2 ** 20).toFixed(1)} MB`);

  const results = {};
  for (const [key, rowId] of [['duckdb', 'row-duckdb'], ['sqlite', 'row-sqlite'], ['pglite', 'row-pglite']]) {
    setStatus(`运行 ${key}…`);
    try {
      const r = await engines[key](csvText);
      r.rowCount = r.q1.result.length;
      results[key] = r;
      render(r, rowId);
      log(`${key}: load ${r.loadMs.toFixed(0)}ms q1 ${r.q1.ms.toFixed(0)}ms q6 ${r.q6.ms.toFixed(0)}ms rows=${r.rowCount}`);
    } catch (error) {
      renderError(rowId, error);
      log(`${key} FAILED: ${error?.message ?? error}`);
    }
  }

  window.__results = results;
  window.__done = true;
  setStatus('完成');
}

runBtn.addEventListener('click', () => {
  runBtn.disabled = true;
  main().catch((e) => log(`fatal: ${e.message}`));
});
runBtn.disabled = false;
setStatus('就绪 — 点击开始');
