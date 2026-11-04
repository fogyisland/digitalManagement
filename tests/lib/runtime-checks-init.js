/**
 * Runtime contract checks — the setup wizard.
 *
 * The wizard has to survive a reload. The backend reports how far the
 * installation got (`GET /api/init/status` answers with `steps`), and the
 * wizard has to open on the step that is still missing — otherwise an
 * operator who closed the browser after the database step comes back to a
 * form for a database that already exists, and the wizard cannot get past
 * it.
 *
 * The mapping is pure logic, so it is checked here directly against the
 * frontend's own module: the wizard and this check read the same function,
 * so a change that breaks the resume behaviour breaks the check.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importFrontendModule } from './runtime.js';

/**
 * @typedef {import('./runtime-checks.js').RuntimeCheck} RuntimeCheck
 */

/** @type {RuntimeCheck[]} */
export const initChecks = [
  {
    name: 'the wizard opens on the step the installation has not reached yet',
    async run(ctx) {
      const { stepFromStatus } = ctx.initSteps;

      // Nothing done yet: the first page.
      assert.equal(stepFromStatus({ database: false, admin: false, seed: false }), 0);

      // The database step is done: the wizard opens on the administrator.
      assert.equal(stepFromStatus({ database: true, admin: false, seed: false }), 1);

      // The administrator exists too: the wizard opens on the confirmation.
      assert.equal(stepFromStatus({ database: true, admin: true, seed: false }), 2);

      // Everything is done: the wizard stays on the confirmation.
      assert.equal(stepFromStatus({ database: true, admin: true, seed: true }), 2);

      // The seed step does not unlock the confirmation on its own — the
      // administrator has to exist first, or there is nothing to confirm.
      assert.equal(stepFromStatus({ database: true, admin: false, seed: true }), 1);
    },
  },

  {
    name: 'the wizard never opens on a step that depends on an earlier one',
    async run(ctx) {
      const { stepFromStatus } = ctx.initSteps;

      // A status that reports a later step without the earlier one is not
      // something the backend produces, but the wizard must not open on a
      // page whose data is missing: the administrator page needs the
      // database values, the confirmation page needs both.
      assert.equal(stepFromStatus({ database: false, admin: true, seed: true }), 0);
      assert.equal(stepFromStatus({ database: false, admin: false, seed: true }), 0);
    },
  },

  {
    // The mapping being right proves nothing on its own: the finding was that
    // the wizard reads `status.initialized` and never `status.steps`, so the
    // first page came back after an interruption no matter what the function
    // says. There is no DOM test runner in this project, so the wiring is
    // checked at the source: the status handler has to seed the step state
    // from the function's answer.
    name: 'the wizard opens on the page the backend reports, not always on the first one',
    async run(ctx) {
      const file = path.join(ctx.srcDir, 'pages', 'init', 'InitWizard.tsx');
      assert.ok(fs.existsSync(file), `the wizard source is missing: ${file}`);
      const source = fs.readFileSync(file, 'utf8');

      const handler = /initApi\s*\.status\(\)[\s\S]*?\.then\(\s*\(?\s*status[\s\S]*?\n\s*\}\)/
        .exec(source);
      assert.ok(handler, 'the wizard has no handler for GET /api/init/status');

      const body = handler[0].replace(/\s+/g, ' ');

      const call = /(\w+)\s*=\s*stepFromStatus\(\s*status\.steps\s*\)/.exec(body);
      const direct = /setStep\(\s*stepFromStatus\(\s*status\.steps\s*\)\s*\)/.test(body);
      const viaLocal = call !== null && new RegExp(`setStep\\(\\s*${call[1]}\\s*\\)`).test(body);

      assert.ok(
        direct || viaLocal,
        'the wizard never opens on the step GET /api/init/status reports — the ' +
          'status handler has to seed the step state from stepFromStatus(status.steps), ' +
          'or an operator who closed the browser mid-setup comes back to a form for a step that is done',
      );
    },
  },
];

/**
 * Load the wizard's step module.
 *
 * The module is loaded from the frontend source tree, so the check reads
 * exactly the function the wizard uses.
 *
 * @param {string} srcDir the frontend source directory
 * @returns {Promise<any>}
 */
export async function loadInitSteps(srcDir) {
  return importFrontendModule(srcDir, 'pages/init/initSteps.ts');
}
