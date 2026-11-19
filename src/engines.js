/**
 * One uniform adapter per engine so the arena can run the same statement on all
 * of them and compare both results and timing.
 *
 * Every adapter exposes: `name`, `version`, `load(dataset)`, `run(sql)`,
 * `close()`. `load` takes the shared inferred schema, never its own guess, so a
 * timing or correctness difference cannot come from differing column types.
 */
import { ddlType, sqlLiteral } from './csv-schema.js';

/** @typedef {{ name: string, columns: { name: string, type: string }[], rows: string[][] }} Dataset */

const quotePg = (id) => `"${id.replaceAll('"', '""')}"`;

/* ------------------------------------------------------------------ DuckDB */
async function createDuckDB() {
  const duckdb = await import('../public/vendor/duckdb-browser.mjs');
  // DuckDB resolves these against the site root and drops leading `../`, so a
  // relative string breaks under a path-prefixed deployment. Resolve them
  // against this module's own URL instead.
  const vendor = (f) => new URL(`../public/vendor/${f}`, import.meta.url).href;
  const bundle = await duckdb.selectBundle({
    base: {
      mainModule: vendor('duckdb-base.wasm'),
      mainWorker: vendor('duckdb-browser-base.worker.js'),
    },
  });
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ path: ':memory:' });
  return { duckdb, db };
}

export class DuckDBEngine {
  name = 'DuckDB-Wasm';
  version = '1.5.4';

  async init() {
    const { db } = await createDuckDB();
    this.db = db;
    this.conn = await db.connect();
    this.loaded = new Map();
    return this;
  }

  /** @param {Dataset} ds */
  async load(ds) {
    const cols = ds.columns.map((c) => `${quotePg(c.name)} ${ddlType(c.type, 'duckdb')}`).join(', ');
    await this.#exec(`DROP TABLE IF EXISTS ${quotePg(ds.name)}`);
    await this.#exec(`CREATE TABLE ${quotePg(ds.name)} (${cols})`);
    const names = ds.columns.map((c) => quotePg(c.name)).join(', ');
    const BATCH = 500;
    for (let i = 0; i < ds.rows.length; i += BATCH) {
      const values = ds.rows
        .slice(i, i + BATCH)
        .map((r) => `(${ds.columns.map((c, j) => sqlLiteral(r[j] ?? '', c.type)).join(',')})`)
        .join(',');
      await this.#exec(`INSERT INTO ${quotePg(ds.name)} (${names}) VALUES ${values}`);
    }
    this.loaded.set(ds.name, ds);
  }

  async #exec(sql) {
    await this.conn.query(sql);
  }

  /**
   * Run one statement. Returns rows plus timing split so a slow first run
   * (plan compilation, first-touch allocation) stays distinguishable.
   * @param {string} sql
   */
  async run(sql) {
    const t0 = performance.now();
    const table = await this.conn.query(sql);
    const ms = performance.now() - t0;
    const json = table.toArray().map((r) => r.toJSON());
    return { rows: json, columns: table.schema.fields.map((f) => f.name), ms };
  }

  async close() {
    await this.db?.terminate();
  }
}

/* ------------------------------------------------------------------ SQLite */
export class SQLiteEngine {
  name = 'SQLite-Wasm';
  version = '3.54.1';

  async init() {
    const { default: sqlite3InitModule } = await import(
      '../node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs'
    );
    this.sqlite3 = await sqlite3InitModule({
      locateFile: (f) => new URL(`../public/vendor/${f}`, import.meta.url).href,
    });
    this.db = new this.sqlite3.oo1.DB(':memory:');
    this.loaded = new Map();
    return this;
  }

  /** @param {Dataset} ds */
  async load(ds) {
    const cols = ds.columns.map((c) => `"${c.name.replaceAll('"', '""')}" ${ddlType(c.type, 'sqlite')}`).join(', ');
    this.db.exec(`DROP TABLE IF EXISTS "${ds.name}"`);
    this.db.exec(`CREATE TABLE "${ds.name}" (${cols})`);

    // A prepared statement per batch keeps binding cheap; one row per step.
    const placeholders = ds.columns.map(() => '?').join(',');
    const stmt = this.db.prepare(`INSERT INTO "${ds.name}" VALUES (${placeholders})`);
    this.db.exec('BEGIN');
    try {
      for (const r of ds.rows) {
        stmt.bind(ds.columns.map((c, j) => {
          const raw = (r[j] ?? '').trim();
          if (raw === '') return null;
          if (c.type === 'INTEGER') return Number(raw);
          if (c.type === 'DOUBLE') return Number(raw);
          if (c.type === 'BOOLEAN') return /^(true|t)$/i.test(raw) ? 1 : 0;
          return raw;
        }));
        stmt.step();
        stmt.reset();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      stmt.finalize();
    }
    this.loaded.set(ds.name, ds);
  }

  /** @param {string} sql */
  async run(sql) {
    const t0 = performance.now();
    const rows = this.db.exec(sql, { rowMode: 'object', returnValue: 'resultRows' });
    const ms = performance.now() - t0;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns, ms };
  }

  async close() {
    this.db?.close();
  }
}

/* ----------------------------------------------------------------- PGlite */
export class PGliteEngine {
  name = 'PGlite (Postgres 18)';
  version = '18.6';

  async init() {
    const { PGlite } = await import('../node_modules/@electric-sql/pglite/dist/index.js');
    this.pg = new PGlite();
    await this.pg.waitReady;
    this.loaded = new Map();
    return this;
  }

  /** @param {Dataset} ds */
  async load(ds) {
    const cols = ds.columns.map((c) => `${quotePg(c.name)} ${ddlType(c.type, 'pglite')}`).join(', ');
    await this.pg.exec(`DROP TABLE IF EXISTS ${quotePg(ds.name)}`);
    await this.pg.exec(`CREATE TABLE ${quotePg(ds.name)} (${cols})`);

    const names = ds.columns.map((c) => quotePg(c.name)).join(', ');
    const BATCH = 500;
    for (let i = 0; i < ds.rows.length; i += BATCH) {
      const values = ds.rows
        .slice(i, i + BATCH)
        .map((r) => `(${ds.columns.map((c, j) => sqlLiteral(r[j] ?? '', c.type)).join(',')})`)
        .join(',');
      await this.pg.exec(`INSERT INTO ${quotePg(ds.name)} (${names}) VALUES ${values}`);
    }
    this.loaded.set(ds.name, ds);
  }

  /** @param {string} sql */
  async run(sql) {
    const t0 = performance.now();
    const result = await this.pg.query(sql);
    const ms = performance.now() - t0;
    return { rows: result.rows, columns: result.fields.map((f) => f.name), ms };
  }

  async close() {
    await this.pg?.close();
  }
}

/** @returns {Array<() => any>} engine constructors in display order */
export const ENGINES = [() => new DuckDBEngine(), () => new SQLiteEngine(), () => new PGliteEngine()];