/**
 * Pure-function regression tests for the cross-engine result comparator.
 * No wasm / no server needed — runs with `node test/result-compare.test.mjs`.
 * These lock in the P1 comparator fixes (M2/M3/M4/M5 + NaN + float-key bucketing).
 */
import { compareResults, cellsEqual, isOrdered } from '../src/result-compare.js';

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; }
  else { fail += 1; console.error(`  ✗ ${name}`); }
};
const cmp = (base, other, ordered) => compareResults(base, other, { ordered });

// --- M2: ORDER BY ties must NOT be reported as a disagreement -------------
{
  const base  = { columns: ['g', 's'], rows: [{ g: 'A', s: 5 }, { g: 'B', s: 5 }, { g: 'C', s: 9 }] };
  const other = { columns: ['g', 's'], rows: [{ g: 'B', s: 5 }, { g: 'A', s: 5 }, { g: 'C', s: 9 }] };
  const r = cmp(base, other, true);
  ok(r.equal === true, 'M2 tie: equal (no phantom disagreement)');
  ok(r.orderMatches === false, 'M2 tie: orderMatches false (tie order differs, annotated not counted)');
}

// --- M2b: a real value difference under ORDER BY is still caught ----------
{
  const base  = { columns: ['g', 's'], rows: [{ g: 'A', s: 5 }, { g: 'B', s: 6 }] };
  const other = { columns: ['g', 's'], rows: [{ g: 'A', s: 5 }, { g: 'B', s: 7 }] };
  const r = cmp(base, other, true);
  ok(r.equal === false && r.firstDiff?.column === 's', 'M2b real diff still caught under ORDER BY');
}

// --- M3: unordered [1,2] vs [2,1] -> equal, order annotated ----------------
{
  const base  = { columns: ['v'], rows: [{ v: 1 }, { v: 2 }] };
  const other = { columns: ['v'], rows: [{ v: 2 }, { v: 1 }] };
  const r = cmp(base, other, false);
  ok(r.equal === true, 'M3 unordered swapped: equal (multiset)');
  ok(r.orderMatches === false, 'M3 unordered swapped: orderMatches false (annotation reachable)');
  const same = cmp(base, { columns: ['v'], rows: [{ v: 1 }, { v: 2 }] }, false);
  ok(same.orderMatches === true, 'M3 unordered same order: orderMatches true');
}

// --- M4: boolean vs 1/0 (and '1'/'0') with reordering must agree ----------
{
  const base  = { columns: ['b', 'x'], rows: [{ b: true, x: 'a' }, { b: false, x: 'b' }] };
  const other = { columns: ['b', 'x'], rows: [{ b: 0, x: 'b' }, { b: 1, x: 'a' }] }; // SQLite 0/1, reordered
  const r = cmp(base, other, false);
  ok(r.equal === true, 'M4 bool vs 0/1 reordered: equal');
  // string '1'/'0' form
  const otherS = { columns: ['b', 'x'], rows: [{ b: '0', x: 'b' }, { b: '1', x: 'a' }] };
  const rS = cmp(base, otherS, false);
  ok(rS.equal === true, "M4 bool vs '0'/'1' reordered: equal");
}

// --- M5: isOrdered must ignore ORDER BY in subqueries/CTE/literals/comments
{
  ok(isOrdered('SELECT a FROM t ORDER BY a') === true, 'M5 top-level ORDER BY');
  ok(isOrdered('SELECT * FROM (SELECT * FROM t ORDER BY a)') === false, 'M5 derived table ORDER BY ignored');
  ok(isOrdered('WITH c AS (SELECT a FROM t ORDER BY a) SELECT * FROM c') === false, 'M5 CTE ORDER BY ignored');
  ok(isOrdered('SELECT \'order by x\' FROM t') === false, 'M5 string literal "order by" ignored');
  ok(isOrdered('SELECT a FROM t /* order by */ ORDER BY a') === true, 'M5 comment ignored, top-level kept');
  ok(isOrdered('SELECT a FROM t') === false, 'M5 no ORDER BY');
}

// --- NaN: both engines yield NaN -> agree; maxRelDiff not poisoned --------
{
  ok(cellsEqual(NaN, NaN) === true, 'NaN vs NaN equal');
  const base  = { columns: ['x'], rows: [{ x: NaN }] };
  const other = { columns: ['x'], rows: [{ x: NaN }] };
  const r = cmp(base, other, false);
  ok(r.equal === true, 'NaN row: equal');
  ok(Number.isFinite(r.maxRelDiff), 'NaN row: maxRelDiff finite (not poisoned)');
}

// --- float-key bucketing (m8): rows keyed by a float that differs between
// engines only within tolerance must compare as the SAME row, not a phantom
// diff or missing row. (Implementation buckets the numeric key at the
// comparison tolerance via toPrecision(10); this locks the observable behavior.)
{
  const k1 = 12345678901123;
  const k2 = 12345678901456; // |k2-k1|/max = 2.7e-11 < REL_TOL (1e-9) -> equal values
  const base  = { columns: ['k', 'n'], rows: [{ k: k1, n: 1 }, { k: 5, n: 2 }] };
  const other = { columns: ['k', 'n'], rows: [{ k: k2, n: 1 }, { k: 5, n: 2 }] };
  const r = cmp(base, other, false);
  ok(r.equal === true, 'float key within tolerance: rows compare equal (no phantom diff)');
  ok(r.firstDiff === null, 'float key within tolerance: no firstDiff');
  // And a float-key difference BEYOND tolerance is still a real disagreement.
  const farBase  = { columns: ['k', 'n'], rows: [{ k: 100, n: 1 }] };
  const farOther = { columns: ['k', 'n'], rows: [{ k: 101, n: 1 }] };
  const rFar = cmp(farBase, farOther, false);
  ok(rFar.equal === false, 'float key beyond tolerance: real disagreement reported');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
