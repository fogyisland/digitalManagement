'use strict';

/**
 * Network helpers for the "import by URL" feature.
 *
 * The server fetches an attacker-supplied URL on behalf of an authenticated
 * user, which is a textbook SSRF hole unless the target is pinned to a
 * public address. Every redirect hop is re-validated, because a public URL
 * can redirect to `http://169.254.169.254/` just as easily as it can
 * redirect to a CDN.
 */

const dns = require('dns').promises;
const net = require('net');
const path = require('path');

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 30000;

/**
 * @param {string} address
 * @returns {boolean} true when the IPv4 address is not globally routable
 */
function isPrivateIPv4(address) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    // An address we cannot parse is not an address we are willing to fetch.
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * @param {string} address
 * @returns {boolean} true when the IPv6 address is not globally routable
 */
function isPrivateIPv6(address) {
  const normalized = String(address).toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    return net.isIPv4(mapped) ? isPrivateIPv4(mapped) : true;
  }
  return false;
}

/**
 * Validate a URL and resolve it to public IP addresses.
 *
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 * @throws {Error & {status: number}}
 */
async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (e) {
    throw Object.assign(new Error('url is not a valid URL'), { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('url must be http(s)'), { status: 400 });
  }
  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch (e) {
    throw Object.assign(new Error(`Host could not be resolved: ${parsed.hostname}`), { status: 400 });
  }
  if (!addresses.length) {
    throw Object.assign(new Error(`Host could not be resolved: ${parsed.hostname}`), { status: 400 });
  }
  for (const entry of addresses) {
    const isPrivate = net.isIPv4(entry.address)
      ? isPrivateIPv4(entry.address)
      : isPrivateIPv6(entry.address);
    if (isPrivate) {
      throw Object.assign(new Error('Refusing to fetch a private or loopback address'), { status: 400 });
    }
  }
  return parsed;
}

/**
 * Download a remote file, validating every redirect hop against the SSRF
 * rules above.
 *
 * @param {string} rawUrl
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, mimetype: string, originalname: string}>}
 */
async function fetchRemoteFile(rawUrl, maxBytes) {
  let current = String(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = await assertPublicUrl(current);
    const response = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Upstream responded ${response.status}`), { status: 502 });
    }
    const declaredLength = Number(response.headers.get('content-length') || '0');
    if (declaredLength && declaredLength > maxBytes) {
      throw Object.assign(new Error('Remote file is too large'), { status: 413 });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw Object.assign(new Error('Remote file is too large'), { status: 413 });
    }
    if (!buffer.length) {
      throw Object.assign(new Error('Remote file is empty'), { status: 400 });
    }
    const contentType = (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim();
    let originalname = 'imported-asset';
    try {
      originalname = decodeURIComponent(path.basename(parsed.pathname)) || originalname;
    } catch (e) {
      originalname = path.basename(parsed.pathname) || originalname;
    }
    return { buffer, mimetype: contentType, originalname };
  }
  throw Object.assign(new Error('Too many redirects'), { status: 502 });
}

module.exports = { isPrivateIPv4, isPrivateIPv6, assertPublicUrl, fetchRemoteFile };
