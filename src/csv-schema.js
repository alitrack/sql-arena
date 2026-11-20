/**
 * RFC 4180 CSV parsing plus type inference.
 *
 * Every engine must receive the same declared types, otherwise a comparison is
 * meaningless: SQLite would compare '9' > '100' lexically while DuckDB compares
 * numerically. Inference runs once, in one place, and its result is applied to
 * all three engines.
 */

/** @typedef {'INTEGER'|'DOUBLE'|'BOOLEAN'|'DATE'|'TIMESTAMP'|'TEXT'} ColumnType */

const INT_RE = /^[+-]?\d{1,18}$/;
const NUM_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/**
 * Parse CSV text into rows of raw strings.
 * @param {string} text
 * @param {{ delimiter?: string }} [options]
 * @returns {string[][]}
 */
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // Strip a UTF-8 BOM: it otherwise becomes part of the first header name and
  // every engine reports a confusing "column not found".
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

/**
 * Infer one column type from its non-empty sample values.
 * `INTEGER` only wins when every value is integral; a single `1.5` promotes to
 * `DOUBLE`, and anything unparseable demotes to `TEXT`.
 * @param {string[]} values
 * @returns {ColumnType}
 */
export function inferType(values) {
  let sawValue = false;
  let allInt = true;
  let allNum = true;
  let allBool = true;
  let allDate = true;
  let allTs = true;

  for (const raw of values) {
    const v = raw.trim();
    if (v === '') continue;
    sawValue = true;
    if (allInt && !INT_RE.test(v)) allInt = false;
    if (allNum && !NUM_RE.test(v)) allNum = false;
    // 0/1 alone is an integer, not a boolean: TPC-H ships priority flags as
    // 0/1 and treating them as BOOLEAN changes comparison semantics.
    if (allBool && !/^(true|false|t|f)$/i.test(v)) allBool = false;
    if (allDate && !DATE_RE.test(v)) allDate = false;
    if (allTs && !TS_RE.test(v)) allTs = false;
    if (!allNum && !allBool && !allDate && !allTs) return 'TEXT';
  }
  if (!sawValue) return 'TEXT';
  if (allBool) return 'BOOLEAN';
  if (allInt) return 'INTEGER';
  if (allNum) return 'DOUBLE';
  if (allDate) return 'DATE';
  if (allTs) return 'TIMESTAMP';
  return 'TEXT';
}

/**
 * Infer a schema from a parsed CSV.
 * @param {string[][]} rows
 * @param {{ sampleRows?: number }} [options]
 * @returns {{ columns: { name: string, type: ColumnType }[], rows: string[][] }}
 */
export function inferSchema(rows, options = {}) {
  const sampleRows = options.sampleRows ?? 2000;
  if (rows.length === 0) return { columns: [], rows: [] };

  const header = rows[0].map((h, idx) => {
    const name = h.trim() || `col_${idx + 1}`;
    return name;
  });
  // Deduplicate: two columns named the same would make every engine ambiguous.
  const seen = new Map();
  const unique = header.map((name) => {
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name}_${count}`;
  });

  const body = rows.slice(1);
  const sample = body.slice(0, sampleRows);
  const columns = unique.map((name, idx) => ({
    name,
    type: inferType(sample.map((r) => r[idx] ?? '')),
  }));
  return { columns, rows: body };
}

/**
 * Render one inferred type as each engine's DDL fragment.
 * @param {ColumnType} type
 * @param {'duckdb'|'sqlite'|'pglite'} engine
 * @returns {string}
 */
export function ddlType(type, engine) {
  if (engine === 'duckdb') {
    if (type === 'TEXT') return 'VARCHAR';
    if (type === 'TIMESTAMP') return 'TIMESTAMP';
    // INTEGER is INT32 in DuckDB (4 bytes) but 64-bit in SQLite/PG; an 18-digit
    // ID overflows INT32 and errors only on DuckDB. Map to BIGINT so all three
    // engines accept the same range.
    if (type === 'INTEGER') return 'BIGINT';
    return type;
  }
  if (engine === 'pglite') {
    if (type === 'INTEGER') return 'BIGINT';
    if (type === 'DOUBLE') return 'DOUBLE PRECISION';
    if (type === 'BOOLEAN') return 'BOOLEAN';
    if (type === 'DATE') return 'DATE';
    if (type === 'TIMESTAMP') return 'TIMESTAMP';
    return 'TEXT';
  }
  // SQLite has no BOOLEAN/DATE: keep them TEXT so stored text round-trips
  // exactly, and integer/double must be declared so comparisons are numeric.
  if (type === 'INTEGER') return 'INTEGER';
  if (type === 'DOUBLE') return 'REAL';
  return 'TEXT';
}

/**
 * SQL literal for one raw CSV value under a declared type.
 * @param {string} raw
 * @param {ColumnType} type
 * @returns {string}
 */
export function sqlLiteral(raw, type) {
  const v = raw.trim();
  if (v === '') return 'NULL';
  if (type === 'INTEGER' || type === 'DOUBLE') {
    return NUM_RE.test(v) ? v : 'NULL';
  }
  if (type === 'BOOLEAN') {
    if (/^(true|t)$/i.test(v)) return 'TRUE';
    if (/^(false|f)$/i.test(v)) return 'FALSE';
    return 'NULL';
  }
  return `'${v.replaceAll("'", "''")}'`;
}
