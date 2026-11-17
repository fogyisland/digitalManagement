/**
 * Runtime contract checks — 写入要落到一个租户。
 *
 * Part of the front↔back guard's runtime half; `tests/lib/runtime-checks.js`
 * owns the runner and the ordering rules.
 *
 * 平台管理员的账号不属于任何租户：不选租户时，他看到的是整个平台，而写入
 * 必须落到某一个租户——一行数据总得有个主人。后端因此会拒这种写入，而那
 * 一次拒绝是**整个界面都会遇到**的：分类、标签、用户、密钥、Webhook、
 * 上传，都在同一个租户作用域里。
 *
 * 这些检查把三件事钉在一起：
 *
 *   1. 后端拒的时候，给出的是一个**能分支的码**（`TENANT_REQUIRED`），
 *      而不是一句只能读的英文；
 *   2. 界面把这个码读成一句**中文、且告诉人怎么办**的话；
 *   3. 界面在**动手之前**就知道写不了，于是把按钮按住，而不是让人填完
 *      一张表再被拒。
 *
 * 它们放在平台层那批检查之后：平台管理员这个账号是那里建立的，而且每
 * 个检查结束时都会把会话交还给种子管理员。
 */

import assert from 'node:assert/strict';
import { rawRequest } from './runtime.js';
import { asPlatformAdministrator, asSeededAdministrator } from './runtime-checks-platform.js';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const tenantWriteChecks = [
  {
    name: '平台管理员不选租户就写入，服务器给的是一个能分支的码',
    async run(ctx) {
      await asPlatformAdministrator(ctx);
      try {
        const refused = await rawRequest(ctx.origin, 'POST', '/api/v1/categories', {
          headers: { Authorization: `Bearer ${ctx.client.getToken()}` },
          body: { name: `没有租户-${Date.now()}` },
        });
        assert.equal(refused.status, 400, `the write must be refused, got ${refused.status}`);
        assert.equal(
          refused.body?.code,
          'TENANT_REQUIRED',
          'the refusal must name itself, so the interface can say what to do about it',
        );
        // The body is kept for the next check: it is the very body the
        // interface has to read.
        ctx.state.tenantRequired = refused.body;
      } finally {
        await asSeededAdministrator(ctx);
      }
    },
  },

  {
    name: '平台管理员选了一个租户，写入就落在那个租户里',
    async run(ctx) {
      await asPlatformAdministrator(ctx);
      try {
        const list = await ctx.tenantsApi.list();
        const tenants = list.items || list;
        const tenant = tenants[0];
        const other = tenants[1];
        assert.ok(tenant?.id, 'the platform administrator must be able to read the tenant list');

        const name = `选中租户-${Date.now()}`;
        const created = await rawRequest(ctx.origin, 'POST', '/api/v1/categories', {
          headers: {
            Authorization: `Bearer ${ctx.client.getToken()}`,
            'X-Tenant': tenant.id,
          },
          body: { name },
        });
        assert.equal(created.status, 201, `the write must land, got ${created.status}`);

        // The category DTO does not carry the tenant — so ownership is
        // proved the only way it can be: the row is there for the tenant it
        // was written into, and nowhere else.
        const mine = await rawRequest(ctx.origin, 'GET', '/api/v1/categories', {
          headers: {
            Authorization: `Bearer ${ctx.client.getToken()}`,
            'X-Tenant': tenant.id,
          },
        });
        assert.ok(
          (mine.body || []).some((c) => c.name === name),
          'the category must be readable in the tenant it was written into',
        );

        if (other?.id) {
          const theirs = await rawRequest(ctx.origin, 'GET', '/api/v1/categories', {
            headers: {
              Authorization: `Bearer ${ctx.client.getToken()}`,
              'X-Tenant': other.id,
            },
          });
          assert.ok(
            !(theirs.body || []).some((c) => c.name === name),
            'the category must not show up in another tenant',
          );
        }

        // The check's own leftovers must not accumulate.
        await rawRequest(ctx.origin, 'DELETE', `/api/v1/categories/${created.body.id}`, {
          headers: {
            Authorization: `Bearer ${ctx.client.getToken()}`,
            'X-Tenant': tenant.id,
          },
        });
      } finally {
        await asSeededAdministrator(ctx);
      }
    },
  },

  {
    name: '界面把那个码读成一句中文、且告诉人怎么办的话',
    async run(ctx) {
      const body = ctx.state.tenantRequired;
      assert.ok(body?.code, 'the previous check must have captured the refusal');

      const described = ctx.errorUtils.describeError(
        { response: { status: 400, data: body } },
        '保存失败',
      );
      assert.notEqual(described, body.detail, 'the raw English sentence must not reach the reader');
      assert.match(described, /租户/, 'the Chinese sentence must say what the reader has to do');
      assert.match(described, /左上角/, 'it must say where the tenant is picked');
    },
  },

  {
    name: '没有映射的错误码，老实说后端那句',
    async run(ctx) {
      const described = ctx.errorUtils.describeError(
        { response: { status: 400, data: { code: 'SOMETHING_ELSE', detail: '后端自己那句话' } } },
        '保存失败',
      );
      assert.equal(described, '后端自己那句话', 'an unmapped code must not be reworded');
    },
  },

  {
    name: '普通租户管理员永远能写，平台管理员没选租户才不能',
    async run(ctx) {
      // A tenant administrator has a tenant of their own: the write lands
      // there, so there is nothing to ask.
      const ordinary = ctx.tenantWrite(false, null);
      assert.equal(ordinary.canWrite, true, 'a tenant administrator must always be able to write');
      assert.equal(ordinary.hint, null);

      // The platform administrator without a tenant has nowhere to write.
      const stranded = ctx.tenantWrite(true, null);
      assert.equal(stranded.canWrite, false, 'the platform administrator needs a tenant to write into');
      assert.match(String(stranded.hint), /租户/, 'the hint must say what to do');
      // The hint is what the reader sees when the mouse rests on a button that
      // is greyed out — it has to say *where* to go, not merely that something
      // is missing. A hint that only said "租户" would be a dead end.
      assert.match(
        String(stranded.hint),
        /左上角/,
        'the hint must say where the tenant is picked',
      );

      // With a tenant picked, the platform administrator writes like anybody
      // else.
      const settled = ctx.tenantWrite(true, 'some-tenant');
      assert.equal(settled.canWrite, true, 'a picked tenant unblocks the write');
      assert.equal(settled.hint, null);
    },
  },
];
