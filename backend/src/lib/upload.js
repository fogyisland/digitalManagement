'use strict';

/**
 * Multipart upload plumbing.
 *
 * The uploader is created per server instance (not per module) so the file
 * size limit is picked up from the environment at boot time — the backend
 * test suite lowers `UPLOAD_MAX_FILE_SIZE_MB` and re-requires the server.
 */

const multer = require('multer');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');

/**
 * @returns {import('multer').Multer}
 */
function createUploader() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: getConfig().maxFileSize },
  });
}

/**
 * Express error handler that turns multer's size-limit error into the
 * canonical 413 payload.
 *
 * @param {Error & {code?: string}} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function uploadErrorHandler(err, _req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      code: 'FILE_TOO_LARGE',
      message: `File exceeds ${getConfig().maxFileSize} bytes`,
      request_id: nanoid(),
    });
  }
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      code: 'BAD_INPUT',
      message: `Unexpected field: ${err.field || 'unknown'}`,
      request_id: nanoid(),
    });
  }
  return next(err);
}

module.exports = { createUploader, uploadErrorHandler };
