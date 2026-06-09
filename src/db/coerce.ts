/**
 * Small value coercions used by the row shapers. node-postgres returns `bigint`/`numeric` columns
 * as strings and parses `json`/`jsonb` into JS values already — so the shapers only need to turn
 * numeric strings into numbers (the PHP `(int)`/`(float)` casts) and leave already-parsed JSON alone.
 */

/** Numeric string/number → number, or null. (PHP `(int)`/`(float)` on a nullable column.) */
export function toNumOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** True if the value is a number or a numeric string (PHP `is_numeric`). */
export function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v));
}

/** A JSON object/array → its compact string for a `::jsonb` bind; non-objects → the default. */
export function jsonOrDefault(v: unknown, fallback = '{}'): string {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : fallback;
}
