/**
 * Local-first analytical warehouse on top of duckdb-wasm + OPFS.
 *
 * Responsibilities duckdb-wasm deliberately does not cover:
 *  1. Cross-tab exclusivity. OPFS access handles allow one holder per file, so a
 *     second tab cannot open the same database. Exactly one tab becomes the
 *     writer ("leader"); every other tab becomes a client that proxies SQL over
 *     BroadcastChannel.
 *  2. Durability policy. duckdb-wasm only flushes to OPFS on CHECKPOINT and a
 *     browser tab can die at any moment, so writes are checkpointed on an idle
 *     debounce instead of per statement.
 *  3. Schema evolution. Ordered migrations tracked in PRAGMA user_version.
 *  4. Portability. The database is a plain .duckdb file; this module can export
 *     it out of OPFS and import a prebuilt one in.
 */

export const COPY_DIR = 'app-warehouse';

/** @typedef {{ version: number, up: string | ((conn: any) => Promise<void>) }} Migration */
/** @typedef {{ name: string, migrations?: Migration[], idleCheckpointMs?: number, maxWritesBeforeCheckpoint?: number }} WarehouseOptions */

const DEFAULT_IDLE_MS = 250;
const DEFAULT_MAX_WRITES = 64;

/** @returns {boolean} whether this origin can persist to OPFS */
export function opfsAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

/** @returns {boolean} whether Web Locks exists (needs a secure context) */
export function locksAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.locks;
}

/**
 * Whether the full local-first contract is available. Over plain http on a LAN
 * address the browser hides both `navigator.storage` and `navigator.locks`, so
 * the server still serves the page but persistence and cross-tab locking are
 * impossible; callers get an in-memory database instead of an exception.
 * @returns {{ persistent: boolean, multiTab: boolean, reason: string | null }}
 */
export function capabilities() {
  const storage = opfsAvailable();
  const locks = locksAvailable();
  if (storage && locks) return { persistent: true, multiTab: true, reason: null };
  const missing = [!storage && 'navigator.storage (OPFS)', !locks && 'navigator.locks'].filter(Boolean);
  return {
    persistent: false,
    multiTab: false,
    reason: `insecure context: ${missing.join(' + ')} unavailable — running in memory`,
  };
}

/**
 * Single-writer, multi-reader warehouse.
 *
 * The instance is usable in every tab: in the leader tab `query()` runs locally,
 * in follower tabs it forwards to the leader. Call `destroy()` to release the
 * lock so another tab can take over.
 */
export class LocalWarehouse {
  /** @param {WarehouseOptions} options */
  constructor(options) {
    this.options = options;
    this.name = options.name ?? 'warehouse.duckdb';
    this.dbPath = `opfs://${this.name}`;
    this.role = /** @type {'leader'|'client'|'closed'} */ ('closed');
    this.db = null;
    this.conn = null;
    this.channel = null;
    this.lockRelease = null;
    this.pendingWrites = 0;
    this.dirty = false;
    this.checkpointTimer = null;
    this.checkpoints = 0;
    this.rpcSeq = 1;
    this.rpcWaiters = new Map();
    this.ready = null;
    this.closing = false;
    /** @type {string[]} */
    this.log = [];
    /** @type {(() => Promise<any>) | null} */
    this.createDb = null;
    this.mode = 'opfs';
    this.caps = { persistent: true, multiTab: true, reason: null };
  }

  /** @param {string} line */
  #trace(line) {
    this.log.push(line);
  }

  /**
   * Try to become the leader; otherwise attach as a client.
   * @param {() => Promise<any>} createDb factory that instantiates duckdb-wasm
   */
  async start(createDb) {
    this.createDb = createDb;
    this.caps = capabilities();

    if (!this.caps.persistent) {
      // Degraded mode: no OPFS and no Web Locks (plain http off-localhost).
      // One private in-memory database, no cross-tab coordination.
      this.role = 'leader';
      this.mode = 'memory';
      this.#trace(this.caps.reason);
      await this.#openLeader();
      this.#trace('leader: in-memory (not persisted)');
      return this.role;
    }

    this.mode = 'opfs';
    this.channel = new BroadcastChannel(`dsh-warehouse:${this.name}`);
    this.channel.onmessage = (ev) => this.#onMessage(ev.data);

    // The lock callback must not be awaited: it resolves only when the lock is
    // released, which happens in destroy(). Awaiting it here would deadlock
    // start(). `acquired` flips inside the callback before the first await.
    let settle;
    const leaderReady = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    let acquired = false;
    const held = navigator.locks.request(
      `dsh-warehouse:${this.name}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settle.resolve(false);
          return;
        }
        acquired = true;
        this.role = 'leader';
        this.#trace('leader: lock acquired');
        const ready = this.#openLeader().then(
          async () => {
            // destroy() may have torn this instance down while we were still
            // opening the database (the lock callback is not awaited by
            // start()). Return immediately so the lock callback exits and the
            // Web Lock is released — never install a fresh `lockRelease` that
            // destroy() has already passed. destroy()'s db teardown ran before
            // `this.db` was assigned (it was still downloading), so terminate
            // the half-open instance here to avoid leaking wasm memory.
            if (this.closing) {
              try { await this.db?.terminate(); } catch { /* already gone */ }
              this.db = null;
              this.conn = null;
              settle.resolve(false);
              return;
            }
            settle.resolve(true);
          },
          (error) => settle.reject(error),
        );
        await ready;
        // If the instance was destroyed while the database was still opening,
        // the callback must return NOW to release the Web Lock. Falling through
        // to the `lockRelease` await below would install a fresh release that
        // destroy() has already passed — leaking the lock forever.
        if (this.closing) {
          this.#trace('lock released (destroyed during open)');
          return;
        }
        await new Promise((resolve) => {
          this.lockRelease = resolve;
        });
      },
    );
    // Swallow the lock promise's rejection: failures surface via leaderReady.
    void held.catch(() => {});
    const isLeader = await leaderReady;
    if (!isLeader) {
      // We are mid-destroy (the callback saw `closing` and released the lock):
      // do not demote to client or wait for a leader — the instance is going
      // away, so just return.
      if (this.closing) {
        this.#trace('closed during start: lock released');
        return this.role;
      }
      this.role = 'client';
      this.#trace('client: leader is another tab');
      await this.#waitForLeader();
    }
    return this.role;
  }

  async #openLeader() {
    const db = await this.createDb();
    this.db = db;
    const useOpfs = this.mode === 'opfs';
    await db.open(
      useOpfs
        ? {
            path: this.dbPath,
            accessMode: 3, // DuckDBAccessMode.READ_WRITE
            opfs: { fileHandling: 'auto' },
          }
        : { path: ':memory:' },
    );
    this.conn = await db.connect();
    await this.#migrate();
    this.ready = Promise.resolve();
  }

  /**
   * Apply pending migrations inside a transaction each, tracked in a metadata
   * table. DuckDB has no SQLite-style `PRAGMA user_version`, so the version
   * lives in `_schema_migrations` and is bumped in the same transaction as the
   * migration itself: a crash mid-migration rolls back both.
   */
  async #migrate() {
    const migrations = [...(this.options.migrations ?? [])].sort((a, b) => a.version - b.version);
    await this.#runLocal(
      `CREATE TABLE IF NOT EXISTS _schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TIMESTAMP DEFAULT current_timestamp
       )`,
    );
    const applied = new Set(
      (await this.#runLocal('SELECT version FROM _schema_migrations')).map((r) => Number(r.version)),
    );
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await this.#runLocal('BEGIN TRANSACTION');
      try {
        if (typeof m.up === 'function') await m.up(this.conn);
        else await this.#runLocal(m.up);
        await this.#runLocal(`INSERT INTO _schema_migrations (version) VALUES (${Number(m.version)})`);
        await this.#runLocal('COMMIT');
        this.#trace(`migration ${m.version} applied`);
      } catch (error) {
        await this.#runLocal('ROLLBACK');
        throw error;
      }
    }
    await this.flush();
  }

  /** @param {string} sql */
  async #runLocal(sql) {
    const table = await this.conn.query(sql);
    return table.toArray().map((row) => row.toJSON());
  }

  async #waitForLeader(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.#ping();
      if (ok) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no warehouse leader became available');
  }

  async #ping() {
    try {
      const rows = await this.#rpc('SELECT 1 AS ok');
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  /**
   * Run SQL. Executes locally in the leader tab, proxied in followers.
   * @param {string} sql
   * @param {any[]} [params]
   */
  async query(sql, params) {
    if (this.role === 'leader') {
      const rows = await (params ? this.conn.query(sql, params) : this.conn.query(sql)).then(
        (t) => t.toArray().map((r) => r.toJSON()),
      );
      this.#noteStatement(sql);
      return rows;
    }
    return this.#rpc(sql, params);
  }

  /** @param {string} sql */
  #noteStatement(sql) {
    if (/^\s*(select|with|pragma|explain|describe|show)/i.test(sql)) return;
    this.dirty = true;
    this.pendingWrites += 1;
    if (this.pendingWrites >= (this.options.maxWritesBeforeCheckpoint ?? DEFAULT_MAX_WRITES)) {
      void this.flush();
      return;
    }
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(
      () => void this.flush(),
      this.options.idleCheckpointMs ?? DEFAULT_IDLE_MS,
    );
  }

  /** Force a CHECKPOINT so committed data reaches the OPFS main file. */
  async flush() {
    // An in-memory database has no file to checkpoint; committed rows are
    // already visible to this connection.
    if (this.mode === 'memory') {
      this.dirty = false;
      this.pendingWrites = 0;
      clearTimeout(this.checkpointTimer);
      return false;
    }
    if (this.role !== 'leader' || !this.dirty) return false;
    clearTimeout(this.checkpointTimer);
    this.dirty = false;
    this.pendingWrites = 0;
    await this.#runLocal('CHECKPOINT');
    this.checkpoints += 1;
    this.#trace('checkpoint');
    return true;
  }

  /**
   * @param {string} sql
   * @param {any[]} [params]
   */
  async #rpc(sql, params) {
    const rid = this.rpcSeq++;
    const payload = { type: 'query', rid, sql, params };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(rid);
        reject(new Error('warehouse RPC timed out'));
      }, 15000);
      this.rpcWaiters.set(rid, { resolve, reject, timer });
    });
    this.channel.postMessage(payload);
    return result;
  }

  /** @param {any} msg */
  async #onMessage(msg) {
    if (msg.type === 'query' && this.role === 'leader') {
      try {
        const rows = await this.query(msg.sql, msg.params);
        this.channel.postMessage({ type: 'result', rid: msg.rid, rows: serializable(rows) });
      } catch (error) {
        this.channel.postMessage({ type: 'error', rid: msg.rid, message: String(error?.message ?? error) });
      }
      return;
    }
    if (msg.type === 'result' || msg.type === 'error') {
      const waiter = this.rpcWaiters.get(msg.rid);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.rpcWaiters.delete(msg.rid);
      if (msg.type === 'error') waiter.reject(new Error(msg.message));
      else waiter.resolve(msg.rows);
    }
  }

  /** Export the database file bytes (leader only). Caller decides where to save them. */
  async exportDatabase() {
    if (this.role !== 'leader') throw new Error('only the leader tab can export the database');
    if (this.mode === 'memory') {
      throw new Error('nothing to export: this tab runs in memory (needs a secure context for OPFS)');
    }
    await this.flush();
    // duckdb-wasm 1.33 keeps database files under `duckdb/fs/` inside OPFS and
    // puts spill files under `duckdb/scratch/`.
    const root = await navigator.storage.getDirectory();
    const duckdbDir = await root.getDirectoryHandle('duckdb');
    const fsDir = await duckdbDir.getDirectoryHandle('fs');
    const handle = await fsDir.getFileHandle(this.name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Close connections and release the cross-tab lock. */
  async destroy() {
    this.closing = true;
    clearTimeout(this.checkpointTimer);
    if (this.role === 'leader') {
      try {
        await this.flush();
        await this.conn?.close();
        await this.db?.terminate();
      } finally {
        this.lockRelease?.();
      }
    }
    this.channel?.close();
    this.role = 'closed';
  }
}

/** @param {any} rows */
function serializable(rows) {
  return JSON.parse(
    JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
