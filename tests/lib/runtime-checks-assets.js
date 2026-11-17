/**
 * Runtime contract checks — the asset lifecycle.
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * These checks walk one asset through its whole life: the multipart upload
 * (under the backend's plural `files` field), the detail / manifest /
 * download views, the update, and the three deletion states — soft delete,
 * restore, and permanent delete.
 *
 * The check for the double-prefixed path is here too, because it is the
 * failure this guard exists for: the axios instance already points at
 * `/api/v1`, so a path that carries the prefix again resolves to
 * `/api/v1/api/v1/…` and answers 404.
 */

import assert from 'node:assert/strict';
import { expectStatus, TINY_PNG } from './runtime.js';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/**
 * The same picture with its pixels scrambled.
 *
 * The header is left intact, so the decoder can still read the size and the
 * failure lands where a real broken file fails: in the decode, not in the
 * inspection. That is the case worth covering — the file is worth keeping,
 * but the picture cannot be made.
 *
 * @param {Buffer} png
 * @returns {Buffer}
 */
function withScrambledPixels(png) {
  const broken = Buffer.from(png);
  const type = broken.indexOf('IDAT', 0, 'ascii');
  assert.ok(type > 0, 'the picture must carry an image chunk');
  const length = broken.readUInt32BE(type - 4);
  for (let offset = type + 4; offset < type + 4 + length; offset += 1) {
    broken[offset] = 0x5a;
  }
  return broken;
}

/** @type {RuntimeCheck[]} */
export const assetChecks = [
  {
    name: 'POST /assets/upload stores the file under the plural `files` field',
    async run(ctx) {
      const file = new File([TINY_PNG], 'contract-test.png', { type: 'image/png' });
      const uploaded = await ctx.assetsApi.upload(file, {
        title: 'contract-test',
        tag_names: 'contract-tag',
      });
      assert.equal(uploaded.count, 1, 'upload must report one stored file');
      assert.equal(uploaded.items.length, 1, 'upload must echo the stored asset');

      const asset = uploaded.items[0];
      assert.equal(asset.asset_type, 'image', 'upload must detect the asset type');
      assert.equal(asset.title, 'contract-test', 'upload must honour the submitted title');
      assert.equal(asset.original_name, 'contract-test.png');
      assert.equal(asset.file_size, TINY_PNG.length);
      assert.equal(asset.status, 'ready');
      assert.deepEqual(asset.tag_names, ['contract-tag']);
      assert.ok(String(asset.thumbnail_url).startsWith('/storage/'), 'the thumbnail must be reachable');
      ctx.state.asset = asset;
    },
  },

  {
    name: 'the upload really produced a thumbnail',
    async run(ctx) {
      // A thumbnail that could not be written must not leave a link behind
      // that opens nothing. The upload says the file is an image and hands
      // out a picture; the interface puts that picture in an `<img>`, and the
      // reader sees a broken image — and blames the asset for a picture the
      // interface made.
      const asset = ctx.state.asset;
      const response = await fetch(`${ctx.origin}${asset.thumbnail_url}`);
      assert.equal(response.status, 200, 'the thumbnail must be there, not merely named');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(
        bytes.subarray(0, 4).toString('ascii'),
        'RIFF',
        'the thumbnail must be the webp the pipeline writes',
      );
    },
  },

  {
    name: 'an image that cannot be thumbnailed is kept, and no thumbnail is promised',
    async run(ctx) {
      const file = new File([withScrambledPixels(TINY_PNG)], 'unreadable.png', {
        type: 'image/png',
      });
      const uploaded = await ctx.assetsApi.upload(file, { title: 'unreadable' });
      const asset = uploaded.items[0];

      assert.equal(asset.status, 'ready', 'a picture that cannot be thumbnailed is still worth keeping');
      assert.equal(
        asset.thumbnail_url,
        null,
        'there is no thumbnail, so there must be no link to one',
      );
      assert.equal(
        asset.preview_url,
        asset.original_url,
        'the preview falls back to the original — something is better than nothing',
      );

      const response = await fetch(`${ctx.origin}${asset.original_url}`);
      assert.equal(response.status, 200, 'the file itself must still open');

      await ctx.assetsApi.remove(asset.id, true);
    },
  },

  {
    name: 'a path that still carries /api/v1 answers 404',
    async run(ctx) {
      const error = await expectStatus(
        ctx.client.apiGet('/api/v1/assets'),
        404,
        'the double-prefix guard',
      );
      assert.equal(error.response.data.detail, 'Not found');
    },
  },

  {
    name: 'the asset detail, manifest and download ticket agree with the list',
    async run(ctx) {
      const asset = ctx.state.asset;
      const detail = await ctx.assetsApi.get(asset.id);
      assert.equal(detail.id, asset.id);
      assert.equal(detail.title, 'contract-test');
      assert.equal(detail.file_hash, asset.file_hash);

      const manifest = await ctx.assetsApi.manifest(asset.id);
      assert.equal(manifest.id, asset.id);
      assert.equal(manifest.asset_type, 'image');
      assert.equal(manifest.original_path, `originals/${asset.id}.png`);
      assert.ok(String(manifest.public_url).startsWith('/storage/'));

      const ticket = await ctx.assetsApi.getDownloadUrl(asset.id);
      assert.equal(ticket.filename, 'contract-test.png');
      assert.equal(ticket.size, TINY_PNG.length);
      assert.ok(String(ticket.download_url).startsWith('/storage/'));
    },
  },

  {
    name: 'the signed file URL serves the bytes, and the unsigned path does not',
    async run(ctx) {
      const asset = ctx.state.asset;
      // The frontend puts these URLs straight into an `<img src>`, which
      // cannot carry an `Authorization` header — so the URL itself has to
      // open the file.
      const response = await fetch(`${ctx.origin}${asset.original_url}`);
      assert.equal(response.status, 200, 'the signed URL must open the file');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, TINY_PNG.length, 'the file must arrive whole');
      assert.equal(
        bytes.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        'the bytes must be the PNG that was uploaded',
      );

      // The same path without the signature is the attack the static mount
      // allowed: guess an asset id, build the path, read the bytes.
      const unsigned = await fetch(`${ctx.origin}${asset.original_url.split('?')[0]}`);
      assert.notEqual(unsigned.status, 200, 'an unsigned URL must not open the file');
    },
  },

  {
    name: 'PUT /assets/:id updates the title, the description and the tags',
    async run(ctx) {
      const asset = ctx.state.asset;
      const updated = await ctx.assetsApi.update(asset.id, {
        title: 'contract-renamed',
        description: 'updated by the contract guard',
        tag_names: 'contract-tag,contract-second',
      });
      assert.equal(updated.id, asset.id);
      assert.equal(updated.title, 'contract-renamed');
      assert.equal(updated.description, 'updated by the contract guard');
      assert.deepEqual([...updated.tag_names].sort(), ['contract-second', 'contract-tag']);
    },
  },

  {
    name: 'DELETE /assets/:id is a soft delete — the row moves to the trash',
    async run(ctx) {
      const asset = ctx.state.asset;
      await ctx.assetsApi.remove(asset.id);

      const list = await ctx.client.apiGet('/assets');
      assert.equal(list.items.some((item) => item.id === asset.id), false,
        'a soft-deleted asset must leave the default list');

      const trash = await ctx.client.apiGet('/assets', { status: 'deleted' });
      assert.equal(trash.items.some((item) => item.id === asset.id), true,
        'status=deleted must show the trashed asset');

      const all = await ctx.client.apiGet('/assets', { include_deleted: true });
      assert.equal(all.items.some((item) => item.id === asset.id), true,
        'include_deleted=true must show the trashed asset');

      const detail = await ctx.assetsApi.get(asset.id);
      assert.equal(detail.status, 'deleted');
      assert.ok(detail.deleted_at, 'a trashed asset must carry a deletion timestamp');
    },
  },

  {
    name: 'POST /assets/:id/restore brings the asset back — and only from the trash',
    async run(ctx) {
      const asset = ctx.state.asset;
      const restored = await ctx.assetsApi.restore(asset.id);
      assert.equal(restored.status, 'ready');
      assert.equal(restored.deleted_at, null);

      const error = await expectStatus(
        ctx.assetsApi.restore(asset.id),
        400,
        'restoring an asset that is not in the trash',
      );
      assert.equal(error.response.data.detail, 'Asset is not in the trash');
    },
  },

  {
    name: 'DELETE /assets/:id?permanent=true erases the asset for good',
    async run(ctx) {
      const asset = ctx.state.asset;
      await ctx.assetsApi.remove(asset.id, true);
      await expectStatus(ctx.assetsApi.get(asset.id), 404, 'a permanently deleted asset');
    },
  },
];
