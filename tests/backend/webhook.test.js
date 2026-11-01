const assert = require('assert');

const w = require('../../src/server/lib/webhook');
assert.strictEqual(typeof w.dispatch, 'function');
const sig = w.signPayload('topsecret', '{"a":1}');
assert.strictEqual(sig.length, 64);
console.log('webhook lib OK');