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
 * Compare two cells with a tolerance that only applies to floats.
 * @param {unknown} a
 * @param {unknown} b
 */
export function cellsEqual(a, b) {
  const x = normCell(a);
  const y = normCell(b);
  if (x.kind === 'null' || y.kind === 'null') return x.kind === y.kind;
  if (x.kind === 'number' && y.kind === 'number') {
    const p = /** @type {number} */ (x.value);
    const q = /** @type {number} */ (y.value);
    if (p === q) return true;
    if (!Number.isFinite(p) || !Number.isFinite(q)) return false;
    const diff = Math.abs(p - q);
    return diff <= ABS_TOL || diff <= REL_TOL * Math.max(Math.abs(p), Math.abs(q));
  }
  // SQLite has no boolean type: a boolean column can come back as 1/0 there
  // and true/false elsewhere. Treat them as the same value.
  const asBool = (n) => {
    if (n.kind === 'boolean') return n.value ? 1 : 0;
    if (n.kind === 'number' && (n.value === 0 || n.value === 1)) return n.value;
    if (n.kind === 'string' && /^(true|t|1)$/i.test(String(n.value))) return 1;
    if (n.kind === 'string' && /^(false|f|0)$/i.test(String(n.value))) return 0;
    return null;
  };
  const bx = asBool(x);
  const by = asBool(y);
  if (bx !== null && by !== null) return bx === by;

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
    if (n.kind === 'boolean') return `#${n.value ? 1 : 0}`;
    if (n.kind === 'number') return `#${Number(n.value).toPrecision(12)}`;
    return `${n.kind}:${String(n.value)}`;
  }).join('\u0001');
}

/**
 * Compare a baseline result against another engine's result.
 *
 * When ordering is not guaranteed by the query, rows are matched as a multiset
 * (sorted by key) and the returned order difference is reported separately
 * instead of being counted as a mismatch.
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
  report.orderMatches = options.ordered
    ? baseKeys.join('|') === otherKeys.join('|')
    : [...baseKeys].sort().join('|') === [...otherKeys].sort().join('|');

  /**
   * Pair rows. Keys that match exactly are paired first; leftovers are paired
   * positionally so a float that differs in the last bits is reported as a
   * value difference instead of a missing row.
   */
  const pairs = [];
  if (options.ordered) {
    base.rows.forEach((r, i) => pairs.push([r, other.rows[i]]));
  } else {
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
        if (denom > 0) report.maxRelDiff = Math.max(report.maxRelDiff, Math.abs(p - q) / denom);
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
 * Does this statement promise a row order? Only then may engines be compared
 * positionally.
 * @param {string} sql
 * @returns {boolean}
 */
export function isOrdered(sql) {
  return /\border\s+by\b/i.test(sql);
}