'use strict';

/**
 * HTTP helpers.
 */

/**
 * Wrap an asynchronous Express handler.
 *
 * Express 4 does not await a handler: when the handler returns a rejected
 * promise, the failure never reaches the error middleware and the request
 * hangs until the client gives up. This wrapper forwards the rejection, so
 * a validation failure stays a 400 instead of turning into a 500.
 *
 * @param {(req: any, res: any, next: any) => Promise<any>} handler
 * @returns {(req: any, res: any, next: any) => void}
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
