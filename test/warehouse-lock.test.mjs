/**
 * Regression test for the warehouse Web-Lock lifecycle (M1): destroy() called
 * while the leader is still opening the database must RELEASE the lock (the
 * lock callback returns), not leak it.
 *
 * Pure Node — stubs `navigator.locks` with a faithful Web-Lock model and a fake
 * duckdb. No wasm, no browser. Runs with `node test/warehouse-lock.test.mjs`.
 */
import { LocalWarehouse } from '../src/warehouse.js';

// --- faithful Web-Lock model ---------------------------------------------
// A lock is "held" from the moment its callback is invoked until the callback's
// promise settles. A concurrent request(name, {ifAvailable}) while held is
// called back with a falsy lock.
const held = new Set();
function locksRequest(name, opts, cb) {
  if (held.has(name) && opts?.ifAvailable) {
    return Promise.resolve(cb(null)); // could not acquire
  }
  held.add(name);
  const result = Promise.resolve(cb({ name })).finally(() => held.delete(name));
  return result;
}
Object.defineProperty(globalThis, 'navigator', {
  value: {
    locks: { request: locksRequest },
    storage: { getDirectory: async () => ({}) }, // not exercised: destroy() never exports
  },
  configurable: true,
  writable: true,
});

// --- fake duckdb-wasm instance --------------------------------------------
function makeFakeDb(controls) {
  const conn = { query: async () => ({ toArray: () => [] }), close: async () => {} };
  return {
    open: async () => {},
    connect: async () => conn,
    terminate: async () => { controls.terminated = true; },
  };
}
const waitFor = (cond, ms = 50) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => (cond() || Date.now() - t0 > ms) ? resolve(cond()) : setTimeout(tick, 5);
  tick();
});

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass += 1; else { fail += 1; console.error(`  ✗ ${n}`); } };

// --- Scenario: destroy() fires while createDb is still downloading ---------
// createDb stays pending (the "32MB wasm download"), destroy() runs, then the
// download finishes. The lock must be released, not leaked.
const NAME = 'race-test.duckdb';
const controls = { terminated: false, dbResolve: null };
const makeDbFactory = (controls) => () => new Promise((res) => {
  controls.dbResolve = () => res(makeFakeDb(controls));
});
const startPromise = (async () => {
  const w = new LocalWarehouse({ name: NAME, migrations: [] });
  const p = w.start(makeDbFactory(controls));
  // Wait until the lock callback has entered (role set to 'leader') and
  // createDb is pending. `role` is set synchronously before the first await,
  // so it is a reliable ready-signal (the `held` set is microtask-timed).
  await waitFor(() => w.role === 'leader');
  // destroy() mid-open: the instance is still downloading.
  await w.destroy();
  // Now let the (slow) wasm "finish" downloading — this is what previously
  // caused the lock callback to fall through to `await lockRelease` forever.
  controls.dbResolve();
  const role = await p;
  // Give the callback a moment to return and release the lock.
  await waitFor(() => !held.has(NAME));
  return { w, role };
})();

const { w, role } = await startPromise;
ok(role === 'closed', `start() resolves 'closed' when destroyed mid-open (got ${role})`);
ok(!held.has(NAME), 'Web Lock released after destroy-during-open (no permanent leak)');
ok(w.lockRelease === null, 'no orphan lockRelease installed (would leak the lock)');
ok(controls.terminated === true, 'half-open duckdb instance terminated');

// A fresh instance can now acquire the lock — proves the tab is not stuck.
const w2 = new LocalWarehouse({ name: NAME, migrations: [] });
const role2 = await w2.start(async () => makeFakeDb(controls));
ok(role2 === 'leader', `a second start() acquires the lock (got ${role2})`);
await w2.destroy();
ok(!held.has(NAME), 'lock released after normal destroy');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
