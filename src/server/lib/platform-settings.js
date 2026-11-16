'use strict';

/**
 * The platform's own settings.
 *
 * Two things live here: the address this instance is reached at, and the
 * origins that are allowed to call it from a browser. Both used to be
 * environment variables, which made them something an operator had to decide
 * before the first boot and could not change without a restart. They are
 * settings, so they live in the database and change while the instance runs.
 *
 * The address is not decoration. It is what the server puts in front of a
 * link it hands to somebody else — a download URL, the endpoint an MCP client
 * is configured with — and what the interface shows as the instance's own
 * base address. Without it, those links say "whoever is asking", and a link
 * copied out of the interface stops working the moment it is pasted
 * somewhere else.
 */

/** The one row this table holds. */
const SETTINGS_ID = 'platform';

/** The settings as they are when nobody has changed them. */
const DEFAULT_SETTINGS = {
  access_domain: '',
  cors_origins: [],
  updated_at: null,
};

/**
 * The settings the process currently believes in.
 *
 * The CORS check runs on every request and cannot wait for the database, so
 * the last known values are kept in memory and refreshed when they change.
 */
let cache = { ...DEFAULT_SETTINGS };

/**
 * @returns {{access_domain: string, cors_origins: string[], updated_at: string|null}}
 */
function currentSettings() {
  return cache;
}

/**
 * Clean up an access domain.
 *
 * A trailing slash is dropped and a missing scheme is filled in: an operator
 * who types `dam.example.com` means `https://dam.example.com`, and a link
 * built with a trailing slash does not match the one the browser is on.
 *
 * @param {unknown} value
 * @returns {string} the cleaned domain, or '' when nothing was given
 */
function normalizeAccessDomain(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Clean up one origin.
 *
 * An origin is a scheme, a host and a port — nothing else. A path in it is
 * meaningless to the browser and is dropped.
 *
 * @param {unknown} value
 * @returns {string} the cleaned origin, or '' when nothing was given
 */
function normalizeOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return '';
  }
}

/**
 * Clean up a list of origins: trimmed, de-duplicated, empties dropped.
 *
 * @param {unknown} value a list, or a comma-separated string
 * @returns {string[]}
 */
function normalizeCorsOrigins(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(',')
        .map((part) => part.trim());
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const origin = normalizeOrigin(entry);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    result.push(origin);
  }
  return result;
}

/**
 * Refuse a setting that cannot work, and say why.
 *
 * A domain that is not a URL would be pasted into every link the instance
 * hands out, so it is checked here rather than discovered later.
 *
 * @param {string} domain
 * @throws {Error & {status: number, code: string}} 400 when the domain is not usable
 */
function assertValidAccessDomain(domain) {
  if (!domain) return;
  let parsed;
  try {
    parsed = new URL(domain);
  } catch {
    throw Object.assign(new Error('The access domain is not a URL'), {
      status: 400,
      code: 'BAD_ACCESS_DOMAIN',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('The access domain must be http or https'), {
      status: 400,
      code: 'BAD_ACCESS_DOMAIN',
    });
  }
  if (!parsed.hostname) {
    throw Object.assign(new Error('The access domain has no host'), {
      status: 400,
      code: 'BAD_ACCESS_DOMAIN',
    });
  }
}

/**
 * Read the settings.
 *
 * @param {object} db
 * @returns {Promise<{access_domain: string, cors_origins: string[], updated_at: string|null}>}
 */
async function readSettings(db) {
  // The platform's own table: it belongs to no tenant, so there is no tenant
  // to narrow it by.
  // tenant-lint: allow the platform settings belong to the platform, not to a tenant
  const row = await db
    .prepare(
      `SELECT access_domain, cors_origins, updated_at
         FROM platform_settings
        WHERE id = ?`,
    )
    .get(SETTINGS_ID);
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    access_domain: normalizeAccessDomain(row.access_domain),
    cors_origins: normalizeCorsOrigins(parseOrigins(row.cors_origins)),
    updated_at: row.updated_at ?? null,
  };
}

/**
 * Parse the stored list of origins.
 *
 * @param {unknown} raw
 * @returns {unknown[]}
 */
function parseOrigins(raw) {
  if (Array.isArray(raw)) return raw;
  const text = String(raw ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Whether a field was actually sent.
 *
 * `undefined` is not the same as "absent" here: a form that sends an empty
 * string means "clear this", and a form that sends nothing means "leave it".
 *
 * @param {object} input
 * @param {string} field
 * @returns {boolean}
 */
function hasField(input, field) {
  return (
    input !== null &&
    typeof input === 'object' &&
    Object.prototype.hasOwnProperty.call(input, field)
  );
}

/**
 * Save the settings.
 *
 * Only the fields that were actually sent are changed: a caller that changes
 * the address does not silently lose the cross-origin list, and a caller that
 * clears the list has to say so with an empty list. A field that is present
 * but empty is a decision — "no address", "no other origin".
 *
 * @param {object} db
 * @param {{access_domain?: string, cors_origins?: string[]|string}} input
 * @param {{userId?: string}} [meta] who changed them
 * @returns {Promise<{access_domain: string, cors_origins: string[], updated_at: string|null}>}
 * @throws {Error & {status: number, code: string}} 400 when a value is not usable
 */
async function saveSettings(db, input = {}, meta = {}) {
  const current = await readSettings(db);
  const domain = hasField(input, 'access_domain')
    ? normalizeAccessDomain(input.access_domain)
    : current.access_domain;
  assertValidAccessDomain(domain);
  const origins = hasField(input, 'cors_origins')
    ? normalizeCorsOrigins(input.cors_origins)
    : current.cors_origins;

  await db
    .prepare(
      `INSERT INTO platform_settings (id, access_domain, cors_origins, updated_by)
            VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
            access_domain = VALUES(access_domain),
            cors_origins  = VALUES(cors_origins),
            updated_by    = VALUES(updated_by)`,
    )
    .run(SETTINGS_ID, domain, JSON.stringify(origins), meta.userId ?? null);

  const saved = await readSettings(db);
  // The CORS check reads the settings from memory, so the cache has to follow
  // the write immediately: an operator who allows an origin and then reloads
  // the page expects it to work now, not after the next restart.
  cache = saved;
  return saved;
}

/**
 * Re-read the settings into the cache.
 *
 * @param {object} db
 * @returns {Promise<{access_domain: string, cors_origins: string[], updated_at: string|null}>}
 */
async function refreshSettings(db) {
  try {
    cache = await readSettings(db);
  } catch {
    // A database that is not there yet must not stop the instance from
    // serving: the settings fall back to "no address, no cross-origin".
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

/**
 * The origins that may call this instance from a browser.
 *
 * The access domain is always one of them — the interface is served from
 * there, so a browser on that origin is talking to itself and has to be
 * allowed to.
 *
 * @param {{access_domain?: string, cors_origins?: string[]}} [settings]
 * @returns {string[]}
 */
function allowedOrigins(settings = cache) {
  const origins = new Set();
  const domainOrigin = normalizeOrigin(settings?.access_domain);
  if (domainOrigin) origins.add(domainOrigin);
  for (const origin of settings?.cors_origins ?? []) {
    const clean = normalizeOrigin(origin);
    if (clean) origins.add(clean);
  }
  return [...origins];
}

/**
 * Build an absolute link for something this instance serves.
 *
 * Without an access domain there is nothing to be absolute about, so the
 * relative path is returned — a link that works in the browser that asked
 * for it.
 *
 * @param {string} pathname e.g. "/storage/originals/abc.png"
 * @param {{access_domain?: string}} [settings]
 * @returns {string}
 */
function absoluteUrl(pathname, settings = cache) {
  const path = String(pathname || '');
  const domain = String(settings?.access_domain || '').replace(/\/+$/, '');
  if (!domain) return path;
  return path.startsWith('/') ? `${domain}${path}` : `${domain}/${path}`;
}

module.exports = {
  SETTINGS_ID,
  DEFAULT_SETTINGS,
  currentSettings,
  readSettings,
  saveSettings,
  refreshSettings,
  allowedOrigins,
  absoluteUrl,
  normalizeAccessDomain,
  normalizeCorsOrigins,
  normalizeOrigin,
};
