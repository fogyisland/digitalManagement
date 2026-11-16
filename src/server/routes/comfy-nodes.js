'use strict';

/**
 * The ComfyUI nodes this tenant talks to.
 *
 * A node is a ComfyUI installation that pushes assets into this instance. It
 * announces itself when it starts working and refreshes its row every time it
 * does, so the list is a picture of the fleet rather than a log of logins.
 *
 * The route is read-only on purpose. A node is registered by the node itself,
 * through the ingest door, and the credential it uses says which tenant it
 * writes into — so there is nothing here for a person to change.
 *
 * Contract (mirrored by `frontend/src/api/comfyNodes.ts`):
 *   GET /comfy-nodes -> ComfyNode[]
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { listNodes } = require('../lib/comfy-nodes');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createComfyNodesRouter({ db }) {
  const router = express.Router();

  router.get(
    '/comfy-nodes',
    authRequired(db),
    asyncHandler(async (req, res) => {
      const nodes = await listNodes(db, req.tenantScope);
      return res.json(nodes);
    }),
  );

  return router;
}

module.exports = createComfyNodesRouter;
