/**
 * Unit tests for src/date-normalize.js — the M6 cross-engine date/timestamp
 * canonicalizer. Pure logic, no wasm: runs in CI and locally in milliseconds.
 *
 * Ground truth (probed against live engines, see REVIEW.md M6 section):
 *   - DuckDB DATE  '1998-09-02'        -> toJSON() 904694400000 (UTC midnight)
 *   - PGlite  DATE  '1998-09-02'       -> Date with getTime() 904694400000
 *   - SQLite  DATE  '1998-09-02'       -> text '1998-09-02'
 *   - DuckDB TS  '1998-09-02 03:04:05' -> 904705445000 (+123 ms fraction)
 * All three must render to ONE wall-clock text, TZ-independently.
 */
import assert from 'node:assert';
import {
  duckDateKind, pgDateKind, kindFromText, canonical, canonicalTextIfDate,
} from '../src/date-normalize.js';

const D_DATE = Date.UTC(1998, 8, 2);              // 904694400000
const D_TS = Date.UTC(1998, 8, 2, 3, 4, 5);        // 904705445000

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓', name); }

// ---- schema type-id mapping ---------------------------------------------
t('duckDateKind: 8=DATE, 10=TIMESTAMP', () => {
  assert.equal(duckDateKind({ typeId: 8 }), 'date');
  assert.equal(duckDateKind({ typeId: 10 }), 'timestamp');
  assert.equal(duckDateKind({ typeId: 2 }), null);   // int64
  assert.equal(duckDateKind({ typeId: 7 }), null);   // float64
  assert.equal(duckDateKind({ typeId: 21 }), null);  // utf8
  assert.equal(duckDateKind(null), null);
  assert.equal(duckDateKind({}), null);
});
t('pgDateKind: 1082=date, 1114=timestamp', () => {
  assert.equal(pgDateKind(1082), 'date');
  assert.equal(pgDateKind(1114), 'timestamp');
  assert.equal(pgDateKind(20), null);   // int8
  assert.equal(pgDateKind(23), null);   // int4
  assert.equal(pgDateKind(17), null);   // text
  assert.equal(pgDateKind(undefined), null);
});
t('kindFromText: shape only, never numbers or prose', () => {
  assert.equal(kindFromText('1998-09-02'), 'date');
  assert.equal(kindFromText('1998-09-02 11:04:05'), 'timestamp');
  assert.equal(kindFromText('1998-09-02T11:04:05'), 'timestamp');
  assert.equal(kindFromText('1998-09-02T11:04:05.123'), 'timestamp');
  assert.equal(kindFromText('42'), null);
  assert.equal(kindFromText('1234'), null);
  assert.equal(kindFromText('Acme, Inc'), null);
  assert.equal(kindFromText(''), null);
  assert.equal(kindFromText(19980902), null);
  assert.equal(kindFromText(null), null);
});

// ---- canonical: number carrier (DuckDB) ----------------------------------
t('canonical: DuckDB DATE number -> UTC midnight text', () => {
  assert.equal(canonical(D_DATE, 'date'), '1998-09-02');
});
t('canonical: DuckDB TIMESTAMP number (with fraction) -> UTC wall text', () => {
  assert.equal(canonical(D_TS + 123, 'timestamp'), '1998-09-02 03:04:05');
});
t('canonical: epoch 0 and negative epochs render (typed date columns)', () => {
  assert.equal(canonical(0, 'date'), '1970-01-01');
  assert.equal(canonical(-86400000, 'date'), '1969-12-31');
});
t('canonical: NaN is not a renderable date', () => {
  assert.equal(canonical(NaN, 'date'), null);
  assert.equal(canonical(Infinity, 'timestamp'), null);
});

// ---- canonical: Date carrier (PGlite) -------------------------------------
t('canonical: PGlite DATE Date object -> same text as DuckDB number', () => {
  assert.equal(canonical(new Date(D_DATE), 'date'), '1998-09-02');
  assert.equal(canonical(new Date(D_DATE), 'date'), canonical(D_DATE, 'date'));
});
t('canonical: PGlite TIMESTAMP Date -> same text as DuckDB number', () => {
  assert.equal(canonical(new Date(D_TS), 'timestamp'), '1998-09-02 03:04:05');
  assert.equal(canonical(new Date(D_TS), 'timestamp'), canonical(D_TS, 'timestamp'));
});
t('canonical: Date rendering is UTC, not local (TZ-independence)', () => {
  // On any local TZ, getUTC* of a UTC-midnight epoch renders '1998-09-02';
  // a local-timezone renderer (getHours) would shift this on UTC+/- zones.
  const d = new Date(D_TS);
  assert.equal(d.getUTCDate(), 2);
  assert.equal(canonical(d, 'timestamp').startsWith('1998-09-02 03:04:05'), true);
});

// ---- canonical: text carrier (SQLite) -------------------------------------
t('canonical: SQLite DATE text passes through normalized', () => {
  assert.equal(canonical('1998-09-02', 'date'), '1998-09-02');
});
t('canonical: SQLite TIMESTAMP text (T or space, fraction) normalized', () => {
  assert.equal(canonical('1998-09-02 03:04:05', 'timestamp'), '1998-09-02 03:04:05');
  assert.equal(canonical('1998-09-02T03:04:05', 'timestamp'), '1998-09-02 03:04:05');
  assert.equal(canonical('1998-09-02T03:04:05.999', 'timestamp'), '1998-09-02 03:04:05');
});

// ---- null handling --------------------------------------------------------
t('canonical: null/undefined -> null', () => {
  assert.equal(canonical(null, 'date'), null);
  assert.equal(canonical(undefined, 'timestamp'), null);
});

// ---- canonicalTextIfDate: type-less (SQLite) guard ------------------------
t('canonicalTextIfDate: date-shaped strings canonicalized', () => {
  assert.equal(canonicalTextIfDate('1998-09-02'), '1998-09-02');
  assert.equal(canonicalTextIfDate('1998-09-02 11:04:05'), '1998-09-02 11:04:05');
  assert.equal(canonicalTextIfDate('1998-09-02T11:04:05.5'), '1998-09-02 11:04:05');
});
t('canonicalTextIfDate: non-date values return null (caller keeps original)', () => {
  assert.equal(canonicalTextIfDate(42), null);
  assert.equal(canonicalTextIfDate(3.14), null);
  assert.equal(canonicalTextIfDate('42'), null);
  assert.equal(canonicalTextIfDate('1234'), null);
  assert.equal(canonicalTextIfDate('Acme, Inc'), null);
  assert.equal(canonicalTextIfDate(''), null);
  assert.equal(canonicalTextIfDate(null), null);
  assert.equal(canonicalTextIfDate({ a: 1 }), null);
  assert.equal(canonicalTextIfDate(true), null);
});

// ---- cross-engine agreement: the M6 invariant -----------------------------
t('M6 invariant: three real engine shapes -> identical text', () => {
  // DuckDB epoch-ms number, PGlite Date, SQLite text — all the same wall clock.
  const duck = canonical(D_DATE, 'date');
  const pg = canonical(new Date(D_DATE), 'date');
  const sql = canonical('1998-09-02', 'date');
  assert.ok(duck === pg && pg === sql, `duck=${duck} pg=${pg} sql=${sql}`);
  assert.equal(duck, '1998-09-02');

  const duckTs = canonical(D_TS + 123, 'timestamp');
  const pgTs = canonical(new Date(D_TS), 'timestamp');
  const sqlTs = canonical('1998-09-02 03:04:05', 'timestamp');
  assert.ok(duckTs === pgTs && pgTs === sqlTs, `duck=${duckTs} pg=${pgTs} sql=${sqlTs}`);
  assert.equal(duckTs, '1998-09-02 03:04:05');
});

console.log(`\nPASS: ${passed} date-normalize tests`);
