/**
 * The MCP probe — what an AI client can and cannot do with this library.
 *
 * The probe builds two tenants, each with an account, and issues a per-account
 * MCP token for every role. It then speaks the MCP protocol over the
 * Streamable HTTP transport and checks three things:
 *
 *   1. the tool set follows the account's role — a viewer is offered reads
 *      and nothing else, an editor is offered the writes, an admin the
 *      deletes;
 *   2. the data a client sees is the data its account may see — a token
 *      never reaches another tenant's assets;
 *   3. a token can be cut off on its own, without touching anything else.
 *
 * The probe owns its own schema and storage directory.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'server', 'server.js');

dotenv.config({ path: path.join(ROOT, '.env') });

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3307', 10);
const DB_USER = process.env.DB_USER || 'dam';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

const SCHEMA = 'dam_contract_mcp_probe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 1x1 PNG — enough for sharp to report a size, small enough to inline.
 *
 * These are the bytes sharp itself writes, so every chunk carries the CRC
 * libpng checks. A PNG that only looks right is refused by the decoder, and
 * the refusal is swallowed as "non-fatal" — the thumbnail is then never
 * written and the path that writes it is never exercised.
 */
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x09, 0x70, 0x48, 0x59,
  0x73, 0x00, 0x00, 0x03, 0xE8, 0x00, 0x00, 0x03,
  0xE8, 0x01, 0xB5, 0x7B, 0x52, 0x6B, 0x00, 0x00,
  0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7,
  0x63, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x5E, 0xF3, 0x2A, 0x3A, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);

let tmpRoot = null;
let child = null;
let port = null;
let rpcId = 0;

/**
 * @param {string} schema
 * @returns {Promise<void>}
 */
async function dropSchema(schema) {
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
  });
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${schema}\``);
  } finally {
    await connection.end();
  }
}

/**
 * @returns {Promise<number>}
 */
async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * @param {number} targetPort
 * @returns {Promise<void>}
 */
async function waitForHealth(targetPort) {
  const deadline = Date.now() + 60000;
  let last = 'never answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(200);
  }
  throw new Error(`backend did not become healthy: ${last}`);
}

/**
 * Call the admin API.
 *
 * @param {string} pathname
 * @param {object} [options]
 * @returns {Promise<{status: number, body: any}>}
 */
async function call(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * Read the JSON-RPC frame out of a transport answer.
 *
 * The Streamable HTTP transport answers with an event stream, so the frame is
 * the last `data:` line of it.
 *
 * @param {string} text
 * @returns {any}
 */
function parseFrame(text) {
  const frames = String(text || '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const last = frames[frames.length - 1];
  if (!last) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return text;
    }
  }
  try {
    return JSON.parse(last);
  } catch (error) {
    return last;
  }
}

/**
 * Speak one MCP method.
 *
 * @param {string|null} token the account's MCP token
 * @param {string} method
 * @param {object} [params]
 * @param {object} [headers]
 * @returns {Promise<{status: number, body: any}>}
 */
async function mcp(token, method, params = {}, headers = {}) {
  rpcId += 1;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: parseFrame(text) };
}

/**
 * The tool names the server offered.
 *
 * @param {string|null} token
 * @returns {Promise<string[]>}
 */
async function toolNames(token) {
  const response = await mcp(token, 'tools/list');
  assert.equal(response.status, 200, `tools/list must succeed: ${JSON.stringify(response.body)}`);
  const tools = response.body && response.body.result ? response.body.result.tools : [];
  return tools.map((tool) => tool.name).sort();
}

/**
 * Call a tool and read its JSON payload.
 *
 * @param {string|null} token
 * @param {string} name
 * @param {object} args
 * @param {object} [headers]
 * @returns {Promise<any>}
 */
async function callTool(token, name, args = {}, headers = {}) {
  const response = await mcp(token, 'tools/call', { name, arguments: args }, headers);
  assert.equal(response.status, 200, `the call must reach the server: ${JSON.stringify(response.body)}`);
  const result = response.body && response.body.result;
  if (result && result.isError) {
    throw new Error(`the tool reported an error: ${result.content[0].text}`);
  }
  const text = result && result.content ? result.content[0].text : '{}';
  return JSON.parse(text);
}

/**
 * Log an assertion the way the other probes do.
 *
 * @param {string} what
 * @param {boolean} ok
 */
function report(what, ok) {
  console.log(`  ${what.padEnd(56)} ${ok ? 'OK' : '<-- FAILED'}`);
  assert.ok(ok, what);
}

async function main() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-mcp-'));
  const storageDir = path.join(tmpRoot, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });

  port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_NAME: SCHEMA,
      STORAGE_DIR: storageDir,
      JWT_SECRET: 'mcp-probe-secret',
      SEED_SAMPLE_ASSETS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[backend] ${chunk}`));

  try {
    await waitForHealth(port);

    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: SCHEMA,
    });
    const password = await bcrypt.hash('Probe@123456', 10);

    // Two tenants. The first one holds an account per role; the second one
    // holds a single asset that no account of the first tenant may see.
    for (const tenant of ['mcp-a', 'mcp-b']) {
      await db.query('INSERT INTO tenants (id, name, slug, status) VALUES (?, ?, ?, ?)', [
        tenant,
        `Tenant ${tenant}`,
        tenant,
        'active',
      ]);
      await db.query(
        'INSERT INTO assets (id, tenant_id, title, filename, original_name, mime_type, file_size, file_hash, asset_type, storage_path, source, status) VALUES (?, ?, ?, ?, ?, ?, 10, ?, \'image\', ?, \'admin\', \'ready\')',
        [
          `a-${tenant}`,
          tenant,
          `asset-${tenant}`,
          `${tenant}.png`,
          `${tenant}.png`,
          'image/png',
          `hash-${tenant}`,
          `originals/${tenant}.png`,
        ],
      );
    }
    for (const [username, role] of [
      ['mcp-viewer', 'viewer'],
      ['mcp-editor', 'editor'],
      ['mcp-admin', 'admin'],
    ]) {
      await db.query(
        'INSERT INTO users (id, tenant_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
        [`u-${username}`, 'mcp-a', username, `${username}@dam.local`, password, role],
      );
    }
    await db.end();

    const json = { 'content-type': 'application/json' };

    /**
     * Log in and issue an MCP token for the account.
     *
     * @param {string} username
     * @returns {Promise<string>} the clear token
     */
    async function issueFor(username) {
      const login = await call('/api/v1/auth/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username, password: 'Probe@123456' }),
      });
      assert.equal(login.status, 200, `${username} must be able to log in`);
      const created = await call('/api/v1/mcp/tokens', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${login.body.access_token}` },
        body: JSON.stringify({ name: `${username} 的 MCP 接入` }),
      });
      assert.equal(created.status, 201, `${username} must be able to issue a token`);
      assert.ok(created.body.token, 'the issued token must be shown once');
      return created.body.token;
    }

    // --- the protocol ------------------------------------------------------
    console.log('\n--- the MCP protocol ---');
    const viewerToken = await issueFor('mcp-viewer');
    const editorToken = await issueFor('mcp-editor');
    const adminToken = await issueFor('mcp-admin');

    const init = await mcp(viewerToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-probe', version: '1.0.0' },
    });
    report(
      'initialize answers with the server it is talking to',
      init.status === 200 &&
        init.body &&
        init.body.result &&
        init.body.result.serverInfo &&
        init.body.result.serverInfo.name === 'digital-management',
    );

    const noToken = await mcp(null, 'tools/list');
    report('a request without a token is refused', noToken.status === 401);

    const badToken = await mcp('dam_mcp_not_a_real_token', 'tools/list');
    report('a request with a token that does not exist is refused', badToken.status === 401);

    // --- the tool set follows the role -------------------------------------
    console.log('\n--- the tool set follows the account ---');
    const viewerTools = await toolNames(viewerToken);
    const editorTools = await toolNames(editorToken);
    const adminTools = await toolNames(adminToken);

    report(
      'a viewer is offered the reads and nothing else',
      viewerTools.join(',') ===
        'get_asset,get_library_stats,list_assets,list_categories,list_tags',
    );
    report(
      'an editor is offered the writes as well',
      editorTools.includes('upload_asset') &&
        editorTools.includes('update_asset') &&
        !editorTools.includes('delete_asset'),
    );
    report(
      'an admin is offered the deletes as well',
      adminTools.includes('delete_asset') &&
        adminTools.includes('upload_asset') &&
        adminTools.includes('update_asset'),
    );

    const refused = await mcp(viewerToken, 'tools/call', {
      name: 'delete_asset',
      arguments: { id: 'a-mcp-a' },
    });
    report(
      'a tool the account may not use cannot be called',
      Boolean(
        refused.body &&
          (refused.body.error || (refused.body.result && refused.body.result.isError)),
      ),
    );

    // --- the data follows the account --------------------------------------
    console.log('\n--- the data follows the account ---');
    const listed = await callTool(viewerToken, 'list_assets');
    report(
      "a token only reaches its own tenant's assets",
      listed.items.length === 1 && listed.items[0].id === 'a-mcp-a',
    );

    const otherTenant = await mcp(viewerToken, 'tools/call', {
      name: 'get_asset',
      arguments: { id: 'a-mcp-b' },
    });
    const otherResult = otherTenant.body && otherTenant.body.result;
    const otherText = otherResult && otherResult.content ? otherResult.content[0].text : '';
    report(
      "another tenant's asset is not reachable",
      Boolean(otherResult) && !otherText.includes('asset-mcp-b'),
    );

    // The tenant header is not a way out of the account's tenant.
    const crossed = await callTool(
      viewerToken,
      'list_assets',
      {},
      { 'x-tenant': 'mcp-b' },
    );
    report(
      'the tenant header does not move a read out of the account tenant',
      crossed.items.length === 1 && crossed.items[0].id === 'a-mcp-a',
    );

    // --- the writes --------------------------------------------------------
    console.log('\n--- the writes ---');
    const uploaded = await callTool(editorToken, 'upload_asset', {
      filename: 'probe.png',
      mime_type: 'image/png',
      content_base64: PNG_1X1.toString('base64'),
      title: 'uploaded through MCP',
    });
    report(
      'an editor can add an asset',
      Boolean(uploaded.asset && uploaded.asset.id && uploaded.asset.title === 'uploaded through MCP'),
    );

    const listedAfter = await callTool(editorToken, 'list_assets');
    report(
      'the new asset is in the tenant it was uploaded into',
      listedAfter.items.some((asset) => asset.id === uploaded.asset.id),
    );

    const renamed = await callTool(editorToken, 'update_asset', {
      id: uploaded.asset.id,
      title: 'renamed through MCP',
    });
    report(
      'an editor can change an asset',
      renamed.title === 'renamed through MCP',
    );

    const deleted = await callTool(adminToken, 'delete_asset', { id: uploaded.asset.id });
    report('an admin can move an asset to the trash', deleted.deleted === uploaded.asset.id);

    const afterDelete = await callTool(editorToken, 'list_assets', { status: 'deleted' });
    report(
      'the trashed asset is still there, and still findable',
      afterDelete.items.some((asset) => asset.id === uploaded.asset.id),
    );

    // --- the token can be cut off ------------------------------------------
    console.log('\n--- the credential ---');
    const tokens = await call('/api/v1/mcp/tokens', {
      headers: { authorization: `Bearer ${(await call('/api/v1/auth/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: 'mcp-admin', password: 'Probe@123456' }),
      })).body.access_token}` },
    });
    assert.equal(tokens.status, 200, 'the token list must be readable');
    const own = tokens.body.items.find((item) => item.name === 'mcp-admin 的 MCP 接入');
    assert.ok(own, 'the issued token must be listed');

    const revoked = await call(`/api/v1/mcp/tokens/${own.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${(await call('/api/v1/auth/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: 'mcp-admin', password: 'Probe@123456' }),
      })).body.access_token}` },
    });
    assert.equal(revoked.status, 204, `the token must be revocable: ${JSON.stringify(revoked.body)}`);

    const afterRevoke = await mcp(adminToken, 'tools/list');
    report('a revoked token stops working', afterRevoke.status === 401);

    console.log('\nmcp probe OK');
  } finally {
    if (child) {
      child.kill();
      child = null;
    }
    await dropSchema(SCHEMA);
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error('[mcp] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
