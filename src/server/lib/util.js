'use strict';

/**
 * Small helpers shared by the route modules.
 */

/**
 * Turn a human name into a URL-safe slug. CJK characters are preserved —
 * the product is Chinese-first and the slugs are only used as opaque
 * identifiers, never as filesystem paths.
 *
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Parse a JSON string, returning null instead of throwing.
 *
 * @param {string|unknown} value
 * @returns {unknown|null}
 */
function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Parse a positive integer query-string parameter.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function parsePositiveInt(value, fallback, max) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Parse a non-negative integer query-string parameter.
 *
 * `parsePositiveInt` rejects 0, which is exactly what a chunk index needs:
 * the first chunk of an upload is index 0.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function parseNonNegativeInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Interpret a query-string boolean. `true`, `1`, `yes` and `on` are true.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  if (value === true) return true;
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/**
 * Normalize a timestamp for a MySQL DATETIME column.
 *
 * The API speaks ISO-8601 (`2027-01-01T10:00:00Z`), but MySQL only
 * understands `YYYY-MM-DD HH:MM:SS` — binding the ISO form raises
 * `ER_TRUNCATED_WRONG_VALUE`. The database stores UTC (every connection
 * sets `time_zone = '+00:00'`), so the value is converted to UTC here as
 * well.
 *
 * @param {unknown} value
 * @returns {string|null} the MySQL form, or null when there is no usable value
 */
function toMysqlDateTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }

  const text = String(value).trim();
  // Already in MySQL's own format — pass it through, completing the time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}(:\d{2})?$/.test(text)) {
    return text.length === 16 ? `${text}:00` : text;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = {
  slugify,
  safeParse,
  parsePositiveInt,
  parseNonNegativeInt,
  parseBoolean,
  toMysqlDateTime,
};
