/**
 * Runtime contract checks — the outbound integrations.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks cover everything the system talks *out* to: the API keys
 * that authenticate a third party, the delivery API they unlock, the chunked
 * upload, the import-by-URL guard, the ComfyUI registration, and the
 * webhook endpoints.
 *
 * Two notes on how these are written:
 *
 *   - The webhook endpoint points at an address that refuses connections
 *     (`127.0.0.1:9`). The endpoint is created, exercised and disabled
 *     again within this file, so no real call leaves the machine — and it
 *     runs after every check that produces an asset event, so a delivery
 *     would never fire anyway.
 *   - The uploads use distinct byte sequences. The backend de-duplicates by
 *     file hash, so two "different" files with identical bytes would come
 *     back as one asset.
 */

import assert from 'node:assert/strict';
import { expectStatus, rawRequest, sha256, uniqueBytes } from './runtime.js';

/** The backend's smallest accepted chunk size (256 KiB). */
const CHUNK_SIZE = 256 * 1024;

/** A URL that resolves but refuses connections — used for webhook targets. */
const UNREACHABLE_URL = 'http://127.0.0.1:9/unreachable';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const integrationChecks = [
  {
    name: 'the API key endpoints hand out the raw key once and mask it afterwards',
    async run(ctx) {
      const created = await ctx.apiKeysApi.create({ name: 'contract-key', scopes: ['read', 'upload'] });
      assert.equal(created.name, 'contract-key');
      assert.ok(String(created.key).startsWith('dam_'), 'the raw key must carry the dam_ prefix');
      assert.equal(created.key_prefix, String(created.key).slice(0, 12));
      assert.deepEqual(created.scopes, ['read', 'upload']);
      assert.equal(created.key_masked, undefined, 'the create response must not carry a masked key');

      const listed = (await ctx.apiKeysApi.list()).find((key) => key.id === created.id);
      assert.ok(listed, 'the new key must show up in the list');
      assert.equal(listed.key_masked, `${created.key_prefix}************************`);
      assert.equal(listed.is_active, true);

      const updated = await ctx.apiKeysApi.update(created.id, { name: 'contract-key-renamed' });
      assert.equal(updated.name, 'contract-key-renamed');

      // A second key, used only to prove that DELETE disables a key — the
      // first one stays active for the delivery check below.
      const disposable = await ctx.apiKeysApi.create({ name: 'contract-key-disposable' });
      await ctx.apiKeysApi.revoke(disposable.id);
      const revoked = (await ctx.apiKeysApi.list()).find((key) => key.id === disposable.id);
      assert.equal(revoked.is_active, false, 'DELETE must disable the key, not erase it');

      ctx.state.apiKey = created;
    },
  },

  {
    name: 'the delivery API accepts the API key and enforces the scopes',
    async run(ctx) {
      const key = ctx.state.apiKey.key;

      const read = await rawRequest(ctx.origin, 'GET', '/api/public/v1/delivery/assets', {
        headers: { 'x-api-key': key },
      });
      assert.equal(read.status, 200);
      assert.ok(Array.isArray(read.body.items));

      const missing = await rawRequest(ctx.origin, 'GET', '/api/public/v1/delivery/assets');
      assert.equal(missing.status, 401, 'a delivery call without a key must be rejected');

      const readOnly = await ctx.apiKeysApi.create({ name: 'contract-read-only', scopes: ['read'] });
      const forbidden = await rawRequest(ctx.origin, 'POST', '/api/public/v1/delivery/upload', {
        headers: { 'x-api-key': readOnly.key },
      });
      assert.equal(forbidden.status, 403, 'a key without the upload scope must be rejected');
      assert.match(String(forbidden.body.detail), /Missing scope/);

      const bytes = uniqueBytes('contract-delivery', 256);
      const form = new FormData();
      form.append('files', new File([bytes], 'contract-delivery.bin', {
        type: 'application/octet-stream',
      }));
      form.append('title', 'contract-delivery');
      const upload = await fetch(`${ctx.origin}/api/public/v1/delivery/upload`, {
        method: 'POST',
        headers: { 'x-api-key': key },
        body: form,
      });
      assert.equal(upload.status, 201);
      const payload = await upload.json();
      assert.equal(payload.count, 1);
      assert.equal(payload.items[0].source, 'public');
    },
  },

  {
    name: 'the chunked upload assembles the parts in index order',
    async run(ctx) {
      const payload = uniqueBytes('contract-chunked', CHUNK_SIZE + 17);
      const session = await ctx.assetsApi.initUpload({
        filename: 'contract-chunked.bin',
        file_size: payload.length,
        mime_type: 'application/octet-stream',
        chunk_size: CHUNK_SIZE,
        title: 'contract-chunked',
      });
      assert.equal(session.chunk_size, CHUNK_SIZE);
      assert.equal(session.total_chunks, 2);
      assert.deepEqual(session.received_chunks, []);

      // Deliberately out of order — the backend must sort the parts by index.
      const second = await ctx.assetsApi.uploadChunk(
        session.session_id,
        1,
        new Blob([payload.subarray(CHUNK_SIZE)]),
      );
      assert.deepEqual(second.received_chunks, [1]);

      const first = await ctx.assetsApi.uploadChunk(
        session.session_id,
        0,
        new Blob([payload.subarray(0, CHUNK_SIZE)]),
      );
      assert.deepEqual(first.received_chunks, [0, 1]);

      const asset = await ctx.assetsApi.completeUpload({ session_id: session.session_id });
      assert.equal(asset.file_hash, sha256(payload), 'the assembled file must hash to the source');
      assert.equal(asset.file_size, payload.length);
      assert.equal(asset.original_name, 'contract-chunked.bin');
      assert.equal(asset.title, 'contract-chunked');
      assert.equal(asset.source, 'chunked-upload');
    },
  },

  {
    name: 'POST /assets/import-url validates the URL and refuses a private address',
    async run(ctx) {
      await expectStatus(ctx.importUrlByUrl({ url: '' }), 400, 'import-url without a url');

      const error = await expectStatus(
        ctx.importUrlByUrl({ url: 'http://127.0.0.1:9/private.png' }),
        400,
        'import-url against a loopback address',
      );
      assert.match(String(error.response.data.detail), /private or loopback/);
    },
  },

  {
    name: 'the ComfyUI registration registers a placeholder and finds it again',
    async run(ctx) {
      const jobId = 'contract-job-1';
      const placeholder = await ctx.registerAssetByComfyJob(jobId, { title: 'Contract Job' });
      assert.equal(placeholder.job_id, jobId);
      assert.equal(placeholder.status, 'processing');
      assert.equal(placeholder.asset_type, 'other');
      assert.equal(placeholder.title, 'Contract Job');

      const found = await ctx.lookupComfyUiJob(jobId);
      assert.ok(found, 'the registered job must be found again');
      assert.equal(found.id, placeholder.id);

      const missing = await ctx.lookupComfyUiJob('contract-job-unknown');
      assert.equal(missing, null, 'an unknown job must resolve to null, not to an exception');
    },
  },

  {
    name: 'the webhook endpoints validate the events and the URL, and disable on delete',
    async run(ctx) {
      const created = await ctx.webhooksApi.create({
        name: 'Contract Webhook',
        url: UNREACHABLE_URL,
        events: ['asset.created'],
      });
      assert.equal(created.name, 'Contract Webhook');
      assert.deepEqual(created.events, ['asset.created']);
      assert.ok(typeof created.secret === 'string' && created.secret.length > 0);

      const listed = (await ctx.webhooksApi.list()).find((item) => item.id === created.id);
      assert.ok(listed, 'the new endpoint must show up in the list');
      assert.deepEqual(listed.events, ['asset.created']);
      assert.equal(listed.is_active, true);
      assert.equal(listed.secret, undefined, 'the secret must not be readable after creation');

      const updated = await ctx.webhooksApi.update(created.id, {
        name: 'Contract Webhook 2',
        events: ['asset.created', 'asset.updated'],
      });
      assert.equal(updated.name, 'Contract Webhook 2');
      assert.deepEqual(updated.events, ['asset.created', 'asset.updated']);

      await expectStatus(
        ctx.webhooksApi.create({
          name: 'Bad Events',
          url: UNREACHABLE_URL,
          events: ['asset.exploded'],
        }),
        400,
        'a webhook subscribed to an unknown event',
      );
      await expectStatus(
        ctx.webhooksApi.create({ name: 'Bad Url', url: 'not-a-url' }),
        400,
        'a webhook with a non-http url',
      );

      await ctx.webhooksApi.remove(created.id);
      const after = (await ctx.webhooksApi.list()).find((item) => item.id === created.id);
      assert.equal(after.is_active, false, 'DELETE must disable the endpoint, not erase it');
    },
  },
];
