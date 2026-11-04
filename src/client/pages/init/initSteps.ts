/**
 * The setup wizard's step mapping.
 *
 * The wizard has to survive a reload. `GET /api/init/status` reports how
 * far the installation got — `steps.database`, `steps.admin`, `steps.seed` —
 * and the wizard has to open on the step that is still missing. Without
 * this, an operator who closed the browser after the database step comes
 * back to a form for a database that already exists, and the wizard cannot
 * get past it: the backend refuses the step with "The administrator step has
 * not run yet", or with a duplicate-database error.
 *
 * The mapping lives here, in its own module with no imports, because it is
 * pure logic and both the wizard and the contract guard need to read it.
 *
 * The rule is simple and follows the order the steps run in: a step is
 * reachable only when every step before it is done.
 */

/** The wizard's steps, in the order they run. */
export type InitStep = 0 | 1 | 2;

/** The database page. */
export const STEP_DATABASE = 0;

/** The administrator page. */
export const STEP_ADMIN = 1;

/** The confirmation page. */
export const STEP_REVIEW = 2;

/** The steps the backend reports. */
export interface InitSteps {
  database: boolean;
  admin: boolean;
  seed: boolean;
}

/**
 * The step the wizard should open on.
 *
 * A step is only reachable when the steps before it are done, so a status
 * that reports a later step without the earlier ones still lands on the
 * first unfinished step. The seed step does not change the answer on its
 * own: it writes the configuration, which happens on the confirmation page.
 *
 * @param steps the `steps` object from `GET /api/init/status`
 * @returns the step to open on
 */
export function stepFromStatus(steps: InitSteps): InitStep {
  if (!steps || !steps.database) return STEP_DATABASE;
  if (!steps.admin) return STEP_ADMIN;
  return STEP_REVIEW;
}
