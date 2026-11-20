/**
 * Cross-engine result comparison.
 *
 * A PK page is only trustworthy if "these two engines disagree" is itself
 * trustworthy. Engines differ in ways that are not disagreements:
 *   - row order is unspecified without ORDER BY
 *   - numeric types come back as number / bigint / string / Decimal
 *   - float summation differs in the last bits
 * This module normalizes and compares accordingly, and reports the first
 * differing cell rather than a bare boolean.
 */

/**
 * Normalize one cell to a comparable primitive.
 * BigInt and decimal strings collapse to numbers so 1234567n, "1234567" and
 * 1234567 compare equal.
 * @param {unknown} value
 * @returns {{ kind: 'null'|'number'|'string'|'boolean', value: number|string|boolean|null }}
 */
export function normCell(value) {
  if (value === null || value === undefined) return { kind: 'null', value: null };
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber)
      ? { kind: 'number', value: asNumber }
      : { kind: 'number', value: Number(value.toString()) };
  }
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  // NOTE (M6): duckdb-wasm returns DATE/TIMESTAMP columns as JS Date objects while
  // PGlite/SQLite return 'YYYY-MM-DD' text. Comparing a Date to a date-string
  // falls through to String() and currently disagrees. Formatting the Date to
  // text is the right fix but needs confirmation of duckdb-wasm's convention
  // (local vs UTC midnight) to avoid a TZ off-by-one; kept on the TODO until
  // verified against the live engine.
  if (value instanceof Date) return { kind: 'number', value: value.getTime() };

  const s = String(value);
  // Postgres returns NUMERIC as a string; compare it as a number when it is one.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) && s.trim() !== '') {
    const n = Number(s);
    if (Number.isFinite(n)) return { kind: 'number', value: n };
  }
  return { kind: 'string', value: s };
}

const REL_TOL = 1e-9;
const ABS_TOL = 1e-6;

/**
 * Fold a boolean-ish cell to 0/1, or null when it is not one.
 *
 * SQLite has no boolean type: a boolean column comes back as 1/0 (or, with TEXT
 * affinity, the strings '1'/'0') where DuckDB and Postgres return true/false.
 * Collapsing lets the value compare equal AND the row key match, so a
 * re-ordered boolean column is not reported as a whole-row mismatch.
 * @param {{kind:string, value:unknown}} n
 * @returns {number|null}
 */
function asBool(n) {
  if (n.kind === 'boolean') return n.value ? 1 : 0;
  if (n.kind === 'number' && (n.value === 0 || n.value === 1)) return n.value;
  if (n.kind === 'string' && /^(true|t|1)$/i.test(String(n.value))) return 1;
  if (n.kind === 'string' && /^(false|f|0)$/i.test(String(n.value))) return 0;
  return null;
}

/**
 * Compare two cells with a tolerance that only applies to floats.
 * @param {unknown} a
 * @param {unknown} b
 */
export function cellsEqual(a, b) {
  const x = normCell(a);
  const y = normCell(b);
  if (x.kind === 'null' || y.kind === 'null') return x.kind === y.kind;
  // Booleans and 0/1 (or '0'/'1') are the same value.
  const bx = asBool(x);
  const by = asBool(y);
  if (bx !== null && by !== null) return bx === by;
  if (x.kind === 'number' && y.kind === 'number') {
    const p = /** @type {number} */ (x.value);
    const q = /** @type {number} */ (y.value);
    if (p === q) return true;
    // NaN === NaN is false; two engines that both yield NaN agree.
    if (Number.isNaN(p) && Number.isNaN(q)) return true;
    if (!Number.isFinite(p) || !Number.isFinite(q)) return false;
    const diff = Math.abs(p - q);
    return diff <= ABS_TOL || diff <= REL_TOL * Math.max(Math.abs(p), Math.abs(q));
  }

  if (x.kind !== y.kind) {
    // A number that also reads as a string ("1" vs 1) is not a disagreement.
    return String(x.value) === String(y.value);
  }
  return x.value === y.value;
}

/**
 * Stable row key used when the query has no ORDER BY.
 *
 * Booleans and 0/1 collapse to one key: SQLite has no boolean type and returns
 * `1` where DuckDB and Postgres return `true`. Letting that difference change
 * the key would make whole rows look missing rather than merely unequal.
 */
function rowKey(row, columns) {
  return columns.map((c) => {
    const n = normCell(row[c]);
    const b = asBool(n);
    if (b !== null) return `#${b}`;
    if (n.kind === 'number') {
      // Bucket by the comparison tolerance so two engines whose float keys
      // differ in the last bits still land in the same bucket (a raw
      // toPrecision(12) key splits at the 11th significant digit and silently
      // falls through to the positional fallback, mis-pairing duplicate rows).
      if (Number.isNaN(n.value)) return '#NaN';
      return `#${Number(n.value).toPrecision(10)}`;
    }
    return `${n.kind}:${String(n.value)}`;
  }).join('\u0001');
}

/**
 * Compare a baseline result against another engine's result.
 *
 * Rows are matched as a multiset by row key (bucket pairing) in both modes; a
 * positional fallback handles last-bit float differences so they surface as a
 * value difference, not a missing row. Whether the stable order was preserved
 * is reported separately via `orderMatches` instead of counting as a mismatch.
 *
 * @param {{ rows: any[], columns: string[] }} base
 * @param {{ rows: any[], columns: string[] }} other
 * @param {{ ordered: boolean }} options
 */
export function compareResults(base, other, options) {
  const columns = base.columns.length ? base.columns : other.columns;
  const report = {
    equal: false,
    rowCountBase: base.rows.length,
    rowCountOther: other.rows.length,
    sameRowCount: base.rows.length === other.rows.length,
    orderMatches: true,
    orderChecked: options.ordered,
    missingColumns: [],
    firstDiff: null,
    maxRelDiff: 0,
  };

  if (columns.length === 0) {
    report.equal = report.sameRowCount;
    return report;
  }
  for (const c of columns) {
    if (!other.columns.includes(c)) report.missingColumns.push(c);
  }
  if (report.missingColumns.length) return report;

  const baseKeys = base.rows.map((r) => rowKey(r, columns));
  const otherKeys = other.rows.map((r) => rowKey(r, columns));
  // Same physical sequence? Compared on the raw key sequence in BOTH modes.
  // Under ORDER BY a tie means the stable order was preserved; without ORDER BY
  // the multiset equality below already ignores order, so this is the
  // "值一致 · 顺序不同" annotation the UI shows instead of counting it as a
  // mismatch (previously it compared SORTED keys, so it was always true and the
  // annotation was unreachable).
  report.orderMatches = baseKeys.join('|') === otherKeys.join('|');

  /**
   * Pair rows by key bucket in both modes. A positional pass for ORDER BY
   * mis-pairs tied sort keys (engines do not guarantee the order of equal
   * ORDER BY rows) and reports a phantom disagreement; key-bucket pairing pairs
   * ties correctly and degrades to a positional fallback only for true
   * leftovers, so a last-bit float difference stays a value difference.
   */
  const pairs = [];
  {
    const buckets = new Map();
    other.rows.forEach((r, i) => {
      const k = otherKeys[i];
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    });
    const leftoversBase = [];
    base.rows.forEach((r, i) => {
      const bucket = buckets.get(baseKeys[i]);
      if (bucket && bucket.length) pairs.push([r, bucket.shift()]);
      else leftoversBase.push(r);
    });
    const leftoverOther = [];
    for (const bucket of buckets.values()) leftoverOther.push(...bucket);
    // Positional fallback over the unpaired remainder.
    leftoversBase.forEach((r, i) => pairs.push([r, leftoverOther[i]]));
    for (let i = leftoversBase.length; i < leftoverOther.length; i += 1) pairs.push([undefined, leftoverOther[i]]);
  }

  let anyValueDiff = false;
  for (const [rowA, rowB] of pairs) {
    if (rowA === undefined || rowB === undefined) {
      anyValueDiff = true;
      if (!report.firstDiff) {
        report.firstDiff = { reason: rowA === undefined ? 'extra row in other engine' : 'row missing in other engine' };
      }
      continue;
    }
    for (const c of columns) {
      const a = normCell(rowA[c]);
      const b = normCell(rowB[c]);
      if (a.kind === 'number' && b.kind === 'number') {
        const p = /** @type {number} */ (a.value);
        const q = /** @type {number} */ (b.value);
        const denom = Math.max(Math.abs(p), Math.abs(q));
        // Guard: NaN/Infinity would poison maxRelDiff (Math.max(0, NaN) is NaN).
        if (denom > 0 && Number.isFinite(p) && Number.isFinite(q)) {
          report.maxRelDiff = Math.max(report.maxRelDiff, Math.abs(p - q) / denom);
        }
      }
      if (!cellsEqual(rowA[c], rowB[c])) {
        anyValueDiff = true;
        if (!report.firstDiff) {
          report.firstDiff = { column: c, base: String(rowA[c]), other: String(rowB[c]) };
        }
      }
    }
  }

  report.equal = !anyValueDiff && report.sameRowCount;
  return report;
}

/**
 * Does this statement promise a top-level row order? Only then may engines be
 * compared positionally. An ORDER BY inside a derived table, CTE, or string
 * literal does NOT order the outer result, so it must not count.
 *
 * @param {string} sql
 * @returns {boolean}
 */
export function isOrdered(sql) {
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { // line comment
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') { // block comment
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") { // single-quoted string ('' escapes a quote)
      i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 1;
          else break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '"') { // double-quoted identifier ("" escapes a quote)
      i += 1;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 1;
          else break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '(') { depth += 1; i += 1; continue; }
    if (ch === ')') { depth -= 1; i += 1; continue; }
    if (depth === 0 && /[A-Za-z]/.test(ch)) {
      const prev = i > 0 ? sql[i - 1] : '';
      if (!/[A-Za-z0-9_]/.test(prev) && /^order\s+by\b/i.test(sql.slice(i))) return true;
    }
    i += 1;
  }
  return false;
}