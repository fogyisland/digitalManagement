'use strict';

/**
 * The MCP endpoint.
 *
 * An AI client speaks to this endpoint with the MCP protocol — JSON-RPC over
 * the Streamable HTTP transport — and carries a per-account MCP token:
 *
 *   POST /mcp   Authorization: Bearer dam_mcp_…
 *
 * The token speaks for one account, and the account speaks for one tenant, so
 * the tools a client gets are exactly the ones that account may use. A
 * platform administrator's token reaches every tenant until the request
 * narrows it with `X-Tenant` — the same header, and the same rule, as the
 * rest of the application.
 *
 * The transport is stateless: every request builds its own server and its own
 * tool set, and closes them when the request ends. A session that outlived a
 * request would keep a token's permissions alive after the token was revoked,
 * so there is deliberately no session to keep.
 */

const express = require('express');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { resolveMcpPrincipal, touchMcpToken } = require('../lib/mcp-tokens');
const { createMcpServer } = require('../lib/mcp-tools');

/**
 * The bearer token the client sent.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * A JSON-RPC error body.
 *
 * The protocol answers errors in its own shape, so a client can read the
 * reason instead of parsing an HTTP page.
 *
 * @param {number} code the JSON-RPC error code
 * @param {string} message
 * @returns {object}
 */
function rpcError(code, message) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  };
}

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createMcpRouter({ db }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const presented = bearerToken(req);
    if (!presented) {
      return res.status(401).json(rpcError(-32001, 'Missing MCP token'));
    }

    let principal;
    try {
      principal = await resolveMcpPrincipal(db, presented, req);
    } catch (error) {
      // A header that names a tenant that does not exist is the client's
      // mistake, and the reason travels back in the protocol's own shape.
      return res
        .status(400)
        .json(rpcError(-32002, error && error.message ? error.message : 'Invalid request'));
    }
    if (!principal) {
      return res.status(401).json(rpcError(-32001, 'Invalid MCP token'));
    }

    await touchMcpToken(db, principal.token.id, principal.token.tenant_id);

    const server = createMcpServer(db, principal);
    // No session id generator: the transport keeps no session, so a request
    // ends with its own server and its own tool set.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] request failed:', error);
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, 'Internal server error'));
      }
    }
    return undefined;
  });

  // The transport is POST-only in the stateless mode. Saying so plainly is
  // better than letting the client discover it from a 404.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json(rpcError(-32000, 'Method not allowed'));

  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  return router;
}

module.exports = createMcpRouter;
