'use strict';

/**
 * The MCP tool set — what an AI client can do with this library.
 *
 * The tools are the library's own operations, not a second implementation of
 * them: an asset is listed by `listAssets`, changed by `updateAsset` and
 * deleted by the same functions the HTTP routes call. A client that speaks
 * MCP and a client that speaks HTTP see the same library, filtered the same
 * way.
 *
 * ## The scope is the account's
 *
 * A tool set is built for one principal — one account and the tenant it
 * belongs to. The tools it gets depend on the account's role:
 *
 *   - `viewer`  — read
 *   - `editor`  — read and write
 *   - `admin`   — read, write and delete
 *
 * A tool the account may not use is not registered at all, so it does not
 * appear in the tool list and cannot be called. A platform administrator's
 * token reaches every tenant until a request narrows it with `X-Tenant`, the
 * same way their session does.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod/v4');
const { getConfig } = require('../config');
const { toAsset, toCategory, toTag } = require('./dto');
const {
  listAssets,
  findAssetById,
  processUpload,
  updateAsset,
  softDeleteAsset,
  permanentlyDeleteAsset,
} = require('./assets');
const { isAllTenants, resolveWriteTenant } = require('./tenant');
const { fetchRemoteFile } = require('./net');

/**
 * A tool result holding a JSON payload.
 *
 * @param {unknown} payload
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * A tool result that reports a failure to the client.
 *
 * A tool that fails answers with the reason rather than an exception, so the
 * model can read what went wrong and try again.
 *
 * @param {string} message
 * @returns {{isError: boolean, content: Array<{type: string, text: string}>}}
 */
function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: String(message) }] };
}

/**
 * The tool set of one account.
 *
 * @param {object} db
 * @param {{scope: object, scopes: string[], user: object, tenant: object}} principal
 * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
 */
function createMcpServer(db, principal) {
  const server = new McpServer(
    { name: 'digital-management', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const scope = principal.scope;
  const allowed = new Set(principal.scopes);
  const may = (name) => allowed.has(name);

  // --- Read -----------------------------------------------------------------

  server.registerTool(
    'list_assets',
    {
      title: '列出资产',
      description:
        'List the assets of the account\'s library. Supports a free-text search over ' +
        'the title, the description and the original file name, and filters by type, ' +
        'category, tags and status.',
      inputSchema: {
        q: z.string().optional().describe('按标题、描述或原始文件名搜索'),
        asset_type: z.enum(['image', 'video', 'other']).optional().describe('资产类型'),
        category_id: z.string().optional().describe('分类 id'),
        tag_names: z.string().optional().describe('标签名，逗号分隔，需全部匹配'),
        status: z.enum(['ready', 'processing', 'failed', 'deleted']).optional().describe('资产状态'),
        page: z.number().int().min(1).optional().describe('页码，从 1 开始'),
        page_size: z.number().int().min(1).max(100).optional().describe('每页条数，最多 100'),
      },
    },
    async (args) => {
      try {
        const result = await listAssets(db, scope, {
          q: args.q,
          asset_type: args.asset_type,
          category_id: args.category_id,
          tag_names: args.tag_names,
          status: args.status,
          page: args.page,
          page_size: args.page_size,
        });
        return jsonResult({
          total: result.total,
          page: result.page,
          page_size: result.page_size,
          items: result.items.map(toAsset),
        });
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    'get_asset',
    {
      title: '读取资产详情',
      description: 'Read one asset by its id, with its tags and its file URLs.',
      inputSchema: { id: z.string().describe('资产 id') },
    },
    async (args) => {
      try {
        const asset = await findAssetById(db, scope, args.id);
        if (!asset) return errorResult(`There is no asset '${args.id}'`);
        return jsonResult(toAsset(asset));
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    'list_categories',
    {
      title: '列出分类',
      description: 'List the categories of the account\'s library.',
      inputSchema: {},
    },
    async () => {
      try {
        const categoryWhere = [];
        const categoryParams = [];
        if (!isAllTenants(scope)) {
          categoryWhere.push('c.tenant_id = ?');
          categoryParams.push(scope.tenantId);
        }
        // The WHERE clause is built before the statement, not inside it: a
        // condition that only exists at runtime cannot be audited.
        const categoryWhereSql = categoryWhere.length
          ? `WHERE ${categoryWhere.join(' AND ')}`
          : '';
        const rows = await db
          .prepare(
            `SELECT c.id, c.name, c.slug, c.parent_id, c.description, c.sort_order, c.created_at
               FROM categories c ${categoryWhereSql}
              ORDER BY c.sort_order ASC, c.name ASC -- tenant`,
          )
          .all(...categoryParams);
        return jsonResult({ items: rows.map(toCategory) });
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    'list_tags',
    {
      title: '列出标签',
      description: 'List the tags of the account\'s library, with how many assets carry each.',
      inputSchema: {},
    },
    async () => {
      try {
        const tagWhere = [];
        const tagParams = [];
        if (!isAllTenants(scope)) {
          tagWhere.push('t.tenant_id = ?');
          tagParams.push(scope.tenantId);
        }
        const tagWhereSql = tagWhere.length ? `WHERE ${tagWhere.join(' AND ')}` : '';
        const rows = await db
          .prepare(
            `SELECT t.id, t.name, t.slug, t.color, t.usage_count, t.created_at
               FROM tags t ${tagWhereSql}
              ORDER BY t.usage_count DESC, t.name ASC -- tenant`,
          )
          .all(...tagParams);
        return jsonResult({ items: rows.map(toTag) });
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    'get_library_stats',
    {
      title: '资产库概览',
      description: 'How many assets the library holds, broken down by type and status.',
      inputSchema: {},
    },
    async () => {
      try {
        const assetWhere = [];
        const assetParams = [];
        if (!isAllTenants(scope)) {
          assetWhere.push('a.tenant_id = ?');
          assetParams.push(scope.tenantId);
        }
        const whereSql = assetWhere.length ? `WHERE ${assetWhere.join(' AND ')}` : '';
        const total = await db
          .prepare(`SELECT COUNT(*) AS c FROM assets a ${whereSql} -- tenant`)
          .get(...assetParams);
        const byType = await db
          .prepare(
            `SELECT a.asset_type AS k, COUNT(*) AS c FROM assets a ${whereSql} GROUP BY a.asset_type -- tenant`,
          )
          .all(...assetParams);
        const byStatus = await db
          .prepare(
            `SELECT a.status AS k, COUNT(*) AS c FROM assets a ${whereSql} GROUP BY a.status -- tenant`,
          )
          .all(...assetParams);
        return jsonResult({
          total: Number(total.c),
          by_type: Object.fromEntries(byType.map((row) => [row.k, Number(row.c)])),
          by_status: Object.fromEntries(byStatus.map((row) => [row.k, Number(row.c)])),
          tenant: principal.tenant ? principal.tenant.id : null,
        });
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  // --- Write ----------------------------------------------------------------

  if (may('write')) {
    server.registerTool(
      'upload_asset',
      {
        title: '上传资产',
        description:
          'Add an asset to the library. Give the file as base64 content, or as a URL ' +
          'the server downloads. The request body limit caps the base64 form at about ' +
          '1.5 MB; use the URL form for anything larger.',
        inputSchema: {
          filename: z.string().describe('文件名，带扩展名'),
          mime_type: z.string().optional().describe('MIME 类型，默认按文件名推断'),
          content_base64: z.string().optional().describe('文件内容的 base64'),
          url: z.string().optional().describe('文件地址，由服务器下载'),
          title: z.string().optional().describe('标题'),
          description: z.string().optional().describe('描述'),
          category_id: z.string().optional().describe('分类 id'),
          tag_names: z.string().optional().describe('标签名，逗号分隔'),
          source_tool: z.string().optional().describe('来源工具名'),
          prompt: z.string().optional().describe('生成提示词'),
        },
      },
      async (args) => {
        try {
          if (!args.content_base64 && !args.url) {
            return errorResult('Give either content_base64 or url');
          }
          let file;
          if (args.content_base64) {
            const buffer = Buffer.from(args.content_base64, 'base64');
            if (!buffer.length) return errorResult('The content is empty');
            file = {
              buffer,
              originalname: args.filename,
              mimetype: args.mime_type || 'application/octet-stream',
              size: buffer.length,
            };
          } else {
            file = await fetchRemoteFile(args.url, getConfig().maxFileSize);
            if (args.filename) file.originalname = args.filename;
          }
          // A write lands in one concrete tenant. A platform administrator's
          // token reaches every tenant until the request narrows it with
          // `X-Tenant`, and a write that names no tenant would leave an
          // orphan row that no tenant administrator can read or delete.
          const tenantId = await resolveWriteTenant(db, scope);
          const result = await processUpload({
            db,
            storageDir: getConfig().storageDir,
            file,
            ownerId: principal.user.id,
            source: 'mcp',
            extra: {
              source_tool: args.source_tool || 'mcp',
              prompt: args.prompt || null,
              title: args.title || null,
              description: args.description || null,
              category_id: args.category_id || null,
              tag_names: args.tag_names || null,
            },
            tenantId,
          });
          return jsonResult({ duplicate: result.duplicate, asset: toAsset(result.asset) });
        } catch (error) {
          return errorResult(error.message);
        }
      },
    );

    server.registerTool(
      'update_asset',
      {
        title: '修改资产',
        description:
          "Change an asset's title, description, category or tags. The fields that are " +
          'not given keep their value.',
        inputSchema: {
          id: z.string().describe('资产 id'),
          title: z.string().optional().describe('新标题'),
          description: z.string().optional().describe('新描述'),
          category_id: z.string().optional().describe('新分类 id'),
          tag_names: z.string().optional().describe('新标签名，逗号分隔'),
        },
      },
      async (args) => {
        try {
          const asset = await findAssetById(db, scope, args.id);
          if (!asset) return errorResult(`There is no asset '${args.id}'`);
          const updated = await updateAsset(db, scope, asset, {
            title: args.title,
            description: args.description,
            category_id: args.category_id,
            tag_names: args.tag_names,
          });
          return jsonResult(toAsset(updated));
        } catch (error) {
          return errorResult(error.message);
        }
      },
    );
  }

  // --- Delete ---------------------------------------------------------------

  if (may('delete')) {
    server.registerTool(
      'delete_asset',
      {
        title: '删除资产',
        description:
          'Move an asset to the trash. The default is a soft delete — the row and the ' +
          'file stay and the asset can be restored. With permanent the row and the ' +
          'file are erased.',
        inputSchema: {
          id: z.string().describe('资产 id'),
          permanent: z.boolean().optional().describe('是否彻底删除，默认否'),
        },
      },
      async (args) => {
        try {
          const asset = await findAssetById(db, scope, args.id);
          if (!asset) return errorResult(`There is no asset '${args.id}'`);
          if (args.permanent) {
            await permanentlyDeleteAsset(db, getConfig().storageDir, scope, asset);
            return jsonResult({ deleted: asset.id, permanent: true });
          }
          const updated = await softDeleteAsset(db, scope, asset);
          return jsonResult({ deleted: updated.id, permanent: false, asset: toAsset(updated) });
        } catch (error) {
          return errorResult(error.message);
        }
      },
    );
  }

  return server;
}

module.exports = {
  createMcpServer,
  jsonResult,
  errorResult,
};
