const assert = require('assert');

const w = require('../../src/server/lib/webhook');
assert.strictEqual(typeof w.dispatch, 'function');
const sig = w.signPayload('topsecret', '{"a":1}');
assert.strictEqual(sig.length, 64);

/**
 * A database handle that accepts the log row and nothing else.
 *
 * @returns {object}
 */
function fakeDb() {
  return {
    prepare: () => ({
      run: async () => ({ changes: 0 }),
    }),
  };
}

/**
 * The endpoint URL is the server's own outbound request, so it may not point
 * at an address only this server can reach — the cloud metadata service, the
 * database, a host on the local network. The guard is the one the "import by
 * URL" feature already uses.
 *
 * @param {string} url
 * @param {string} label
 * @returns {Promise<void>}
 */
async function assertRefused(url, label) {
  const result = await w.dispatch(
    fakeDb(),
    { id: 'e1', url, secret: 'topsecret', events: '' },
    'asset.created',
    { id: 'x' },
  );
  assert.strictEqual(result.status, 'failed', `${label} must be refused`);
  assert.ok(
    /private or loopback/i.test(result.error || ''),
    `${label} must be refused as a private address, got: ${result.error}`,
  );
  assert.strictEqual(
    result.attempts,
    1,
    `${label} must not be retried — the same request is refused again`,
  );
}

(async () => {
  await assertRefused('http://127.0.0.1:9/hook', 'a loopback endpoint');
  await assertRefused('http://169.254.169.254/latest/meta-data/', 'a link-local endpoint');
  await assertRefused('http://10.0.0.5/hook', 'a private endpoint');
  await assertRefused('http://[::1]/hook', 'an IPv6 loopback endpoint');
  console.log('webhook lib OK');
})().catch((error) => {
  console.error('TEST FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
