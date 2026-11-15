'use strict';

/**
 * Multipart upload plumbing.
 *
 * The uploader is created per server instance (not per module) so the file
 * size limit is picked up from the environment at boot time — the backend
 * test suite lowers `UPLOAD_MAX_FILE_SIZE_MB` and re-requires the server.
 *
 * Two limits, not one:
 *
 *   - **per file** — `UPLOAD_MAX_FILE_SIZE_MB`, the size of a single asset;
 *   - **per request** — `UPLOAD_MAX_REQUEST_SIZE_MB`, the total a request
 *     may carry.
 *
 * The second one exists because the files are buffered *in memory*: the
 * per-file limit alone would let one request (`files` is capped at 20) pull
 * twenty times the limit into the process and take it down with an
 * out-of-memory error. The request budget is what keeps the memory a single
 * request may cost bounded.
 */

const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');

/**
 * A memory storage that refuses to buffer more than a fixed number of bytes.
 *
 * Two ceilings are enforced here rather than by multer's own limits:
 *
 *   - **per file** — the size of a single file;
 *   - **per request** — the total a request may carry.
 *
 * Multer has no request-level limit, and its file limit truncates the stream
 * instead of refusing the file, so the number in the answer would be the
 * configured one rather than the one that was actually hit.
 *
 * The running total lives on the request itself — the engine instance is
 * shared by every request, so the counter cannot live on it — and the bytes
 * are released as soon as a ceiling is crossed.
 *
 * @param {{fileSize: number, requestSize: number}} limits
 * @returns {import('multer').StorageEngine}
 */
function boundedMemoryStorage({ fileSize, requestSize }) {
  return {
    _handleFile(req, file, cb) {
      // The budget belongs to the request, not to the file: twenty files of
      // a tenth of the limit each are over the limit together.
      const state = req.__damUploadBudget || (req.__damUploadBudget = { bytes: 0, error: null });
      const chunks = [];
      let size = 0;
      let settled = false;

      /**
       * Report the refusal.
       *
       * Only once the whole request has been read: a response that is sent
       * while the client is still writing comes back as a reset connection
       * instead of the status the client needs to see. So the rest of the
       * body is drained, and the answer follows it.
       */
      const refuse = () => {
        if (settled) return;
        settled = true;
        if (req.readableEnded || req.complete) {
          cb(state.error);
          return;
        }
        req.once('end', () => cb(state.error));
      };

      file.stream.on('data', (chunk) => {
        // Already over a ceiling: the rest of this file is drained, not held.
        if (state.error) return;
        size += chunk.length;
        state.bytes += chunk.length;
        if (size > fileSize) {
          state.error = Object.assign(new Error(`File exceeds ${fileSize} bytes`), {
            code: 'LIMIT_FILE_SIZE',
          });
        } else if (state.bytes > requestSize) {
          state.error = Object.assign(
            new Error(`The request carries more than ${requestSize} bytes`),
            { code: 'LIMIT_REQUEST_SIZE' },
          );
        }
        if (state.error) {
          // What was held so far is released now, not when the file ends.
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      file.stream.on('end', () => {
        if (settled) return;
        if (state.error) {
          refuse();
          return;
        }
        settled = true;
        cb(null, {
          buffer: Buffer.concat(chunks),
          size,
          originalname: file.originalname,
          mimetype: file.mimetype,
        });
      });
      file.stream.on('error', (error) => {
        if (settled) return;
        settled = true;
        cb(error);
      });
    },
    _removeFile(_req, _file, cb) {
      // Nothing was written to disk, so there is nothing to remove.
      cb(null);
    },
  };
}

/**
 * The uploader for a multipart request that carries whole files.
 *
 * @param {{fileSize?: number, requestSize?: number}} [options]
 * @returns {import('multer').Multer}
 */
function createUploader(options = {}) {
  const config = getConfig();
  const fileSize = options.fileSize || config.maxFileSize;
  const requestSize = options.requestSize || config.maxRequestSize;
  return multer({
    storage: boundedMemoryStorage({ fileSize, requestSize }),
  });
}

/**
 * The uploader for one chunk of a chunked upload.
 *
 * A chunk is bounded by the largest chunk size the server hands out at all —
 * so one request cannot ask for more memory than the protocol allows.
 *
 * @param {number} maxBytes
 * @returns {import('multer').Multer}
 */
function createChunkUploader(maxBytes) {
  return multer({
    storage: boundedMemoryStorage({ fileSize: maxBytes, requestSize: maxBytes }),
  });
}

/**
 * Express error handler that turns a size-limit error into the canonical 413
 * payload.
 *
 * @param {Error & {code?: string}} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function uploadErrorHandler(err, _req, res, next) {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_REQUEST_SIZE')) {
    const isRequest = err.code === 'LIMIT_REQUEST_SIZE';
    return res.status(413).json({
      code: isRequest ? 'REQUEST_TOO_LARGE' : 'FILE_TOO_LARGE',
      message: isRequest
        ? 'The request carries more data than this server accepts'
        : err.message || `File exceeds ${getConfig().maxFileSize} bytes`,
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

/**
 * Reclaim the upload sessions that ran out of time.
 *
 * A session that is never completed keeps its scratch directory — and the
 * chunks in it — for as long as the server runs. Somebody who starts an
 * upload and walks away would otherwise fill the disk, one abandoned
 * session at a time.
 *
 * @param {object} db
 * @param {string} storageDir
 * @returns {Promise<number>} how many sessions were reclaimed
 */
async function reapExpiredUploadSessions(db, storageDir) {
  let rows = [];
  try {
    // tenant-lint: allow a sweeper that reclaims expired sessions across every tenant
    rows = await db
      .prepare("SELECT id FROM upload_sessions WHERE status = 'pending' AND expires_at < NOW()")
      .all();
  } catch (e) {
    console.warn('[upload] could not list expired sessions:', e.message);
    return 0;
  }
  let reaped = 0;
  for (const row of rows) {
    try {
      fs.rmSync(path.join(storageDir, 'tmp', String(row.id)), { recursive: true, force: true });
      // tenant-lint: allow a sweeper that reclaims expired sessions across every tenant
      await db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(String(row.id));
      reaped += 1;
    } catch (e) {
      console.warn('[upload] could not reap session', row.id, e.message);
    }
  }
  if (reaped > 0) {
    console.log(`[upload] reclaimed ${reaped} expired upload session(s)`);
  }
  return reaped;
}

module.exports = { createUploader, createChunkUploader, uploadErrorHandler, reapExpiredUploadSessions };
