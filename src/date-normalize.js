/**
 * Cross-engine date/timestamp canonicalization (M6).
 *
 * The three wasm bindings encode the SAME naive wall-clock differently:
 *   - DuckDB  toJSON() -> epoch-milliseconds NUMBER
 *   - PGlite  -> Date OBJECT whose getTime() is the same epoch
 *   - SQLite  -> TEXT (arena stores DATE/TIMESTAMP columns as TEXT)
 *
 * Verified against all three engines (probe, 2026-11-20): DuckDB's number and
 * PGlite's Date carry the SAME epoch — both encode the naive date/time as UTC
 * wall-clock (DATE '1998-09-02' -> getTime()/number === Date.UTC(1998,8,2);
 * TIMESTAMP '...03:04:05' -> epoch whose UTC wall is 03:04:05). SQLite stores
 * the wall-clock as text directly.
 *
 * So `canonical(value, kind)` renders every shape to one UTC wall-clock text:
 *   - number / Date -> the shared epoch, rendered as UTC wall
 *   - string        -> already wall-clock text (SQLite) -> normalize/validate
 *
 * This is TZ-independent: because both numeric carriers are UTC-encoded,
 * rendering the epoch as UTC gives the original wall-clock regardless of the
 * machine's local timezone (unlike local getHours(), which shifted by the
 * local offset). Callers must only invoke this on a column they know is a
 * date/time (DuckDB/PGlite gate on their result schema; SQLite on value shape
 * via `canonicalTextIfDate`). A real BIGINT must never be routed here.
 */

const p2 = (n) => String(n).padStart(2, '0');
const p4 = (n) => String(n).padStart(4, '0');

/** DuckDB arrow type ids -> date kind (only the wall-clock ones we handle). */
export function duckDateKind(arrowType) {
  const id = arrowType?.typeId;
  if (id === 8) return 'date';        // DATE
  if (id === 10) return 'timestamp';  // TIMESTAMP
  return null;
}

/** PGlite PostgreSQL dataType ids -> date kind. */
export function pgDateKind(dataTypeID) {
  if (dataTypeID === 1082) return 'date';       // date
  if (dataTypeID === 1114) return 'timestamp';  // timestamp
  return null;
}

/** Infer a date kind from a text value's shape (used for type-less SQLite). */
export function kindFromText(s) {
  if (typeof s !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) return 'timestamp';
  return null;
}

/** Render an epoch-millisecond number as a wall-clock text (UTC). */
function epochToWall(ms, kind) {
  const d = new Date(ms);
  const date = `${p4(d.getUTCFullYear())}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  if (kind === 'date') return date;
  return `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/** Render a JS Date to a wall-clock text — both numeric carriers are
 * UTC-encoded, so render the epoch as UTC (same path as the DuckDB number). */
function dateToWall(d, kind) {
  return epochToWall(d.getTime(), kind);
}

/** Normalize a wall-clock text value; return null when it is not a date text. */
function textToWall(s, kind) {
  if (kind === 'date') return s.slice(0, 10);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

/**
 * Render one date/time cell to its canonical wall-clock text.
 * @param {unknown} value
 * @param {'date'|'timestamp'} kind
 * @returns {string|null} null when the value is not a renderable date/time.
 */
export function canonical(value, kind) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return epochToWall(value, kind);
  if (value instanceof Date) return dateToWall(value, kind);
  if (typeof value === 'string') {
    const k = kindFromText(value) ?? kind;
    return k ? textToWall(value, k) : null;
  }
  return null;
}

/**
 * For a type-less result (SQLite): normalize a cell only when its text shape
 * is unambiguously a date/timestamp. Returns the canonical text, or null when
 * the cell is not a date text (caller keeps the original value).
 * @param {unknown} value
 * @returns {string|null}
 */
export function canonicalTextIfDate(value) {
  if (typeof value !== 'string') return null;
  const k = kindFromText(value);
  return k ? textToWall(value, k) : null;
}
