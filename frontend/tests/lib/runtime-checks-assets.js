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
