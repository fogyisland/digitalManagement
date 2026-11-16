'use strict';

/**
 * The instance's own settings, as everybody sees them.
 *
 * Contract (mirrored by `frontend/src/api/settings.ts`):
 *   GET /settings -> {access_domain: string}
 *
 * The platform administrator sets the address in the platform console. Every
 * other account only reads it, because the interface has to show the address
 * the instance answers at rather than the address the browser happened to
 * arrive at — a link or an endpoint copied out of the interface has to work
 * where it is pasted, not only where it was copied from.
 *
 * The cross-origin list is *not* here: it says who may call this instance,
 * and that is the platform administrator's business alone.
 */

const express = require('express');
const { authRequired } = require('../lib/auth');
const { readSettings } = require('../lib/platform-settings');
const { asyncHandler } = require('../lib/http');

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createSettingsRouter({ db }) {
  const router = express.Router();

  router.get('/settings', authRequired(db), asyncHandler(async (_req, res) => {
    const settings = await readSettings(db);
    return res.json({ access_domain: settings.access_domain });
  }));

  return router;
}

module.exports = createSettingsRouter;
