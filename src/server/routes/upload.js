'use strict';

/**
 * Chunked upload routes.
 *
 * Large files are uploaded in pieces so a flaky connection does not lose a
 * 2 GB video. The client drives the session:
 *
 *   POST /upload/init              {filename, file_size, ...} -> session descriptor
 *   PUT  /upload/chunk/:session_id ?chunk_index=N   multipart "chunk" -> 200
 *   POST /upload/complete          {session_id, ...}       -> Asset
 *
 * Contract (mirrored by `frontend/src/api/assets.ts`):
 *   init    -> {session_id, chunk_size, total_chunks, received_chunks[], expires_at}
 *   chunk   -> {received_chunks: number[], received: number, total_chunks: number}
 *   complete-> Asset
 *
 * Chunk payloads are written to `STORAGE_DIR/tmp/<session_id>/<index>.part`
 * and concatenated — in index order — when the session completes.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { nanoid } = require('nanoid');
const { getConfig } = require('../config');
const { authRequired, parseDateTime } = require('../lib/auth');
const { resolveWriteTenant, SUPERADMIN_ROLE } = require('../lib/tenant');
const { toAsset } = require('../lib/dto');
const { processUpload } = require('../lib/assets');
const { parsePositiveInt, parseNonNegativeInt } = require('../lib/util');
const { createChunkUploader } = require('../lib/upload');
const { asyncHandler } = require('../lib/http');

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
const MIN_CHUNK_SIZE = 256 * 1024; // 256 KiB
const MAX_CHUNK_SIZE = 64 * 1024 * 1024; // 64 MiB
const SESSION_TTL_MINUTES = 60;
const MAX_CHUNKS = 20000;

/**
 * Absolute path of the scratch directory holding a session's chunks.
 *
 * @param {string} storageDir
 * @param {string} sessionId
 * @returns {string}
 */
function sessionDir(storageDir, sessionId) {
  return path.join(storageDir, 'tmp', sessionId);
}

/**
 * Read the received chunk indexes of a session.
 *
 * @param {object} db
 * @param {string} tenantId
 * @param {string} sessionId
 * @returns {Promise<{session: any, received: number[]}|null>}
 */
async function loadSession(db, tenantId, sessionId) {
  const session = await db
    .prepare('SELECT * FROM upload_sessions WHERE tenant_id = ? AND id = ?')
    .get(String(tenantId), String(sessionId));
  if (!session) return null;
  let received = [];
  try {
    const parsed = JSON.parse(session.received_chunks || '[]');
    received = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch (e) {
    console.warn('[upload] corrupt received_chunks for session', sessionId, e.message);
    received = [];
  }
  return { session, received };
}

/**
 * Has this session run out of time?
 *
 * A session is a promise to finish an upload within an hour. After that the
 * scratch directory it owns is reclaimed — so a session that is still
 * accepted would be writing into a directory that no longer exists.
 *
 * The database stores UTC (`SET time_zone = '+00:00'`), so the DATETIME is
 * read back as UTC — reading it as local time would make every session look
 * expired by the machine's UTC offset.
 *
 * @param {any} session
 * @returns {boolean}
 */
function sessionExpired(session) {
  const when = parseDateTime(session && session.expires_at);
  if (!when) return false;
  return when.getTime() < Date.now();
}

/**
 * Persist the received chunk indexes of a session.
 *
 * @param {object} db
 * @param {string} tenantId
 * @param {string} sessionId
 * @param {number[]} received
 * @returns {Promise<void>}
 */
async function saveReceived(db, tenantId, sessionId, received) {
  await db
    .prepare(
      "UPDATE upload_sessions SET received_chunks = ?, updated_at = NOW() WHERE tenant_id = ? AND id = ?",
    )
    .run(JSON.stringify(received), String(tenantId), sessionId);
}

/**
 * @param {{db: object}} deps
 * @returns {import('express').Router}
 */
function createUploadRouter({ db }) {
  const router = express.Router();
  // The chunked protocol has its own door, with its own memory ceiling.
  const chunkUploader = createChunkUploader(MAX_CHUNK_SIZE);

  router.post('/upload/init', authRequired(db), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const filename = String(body.filename || '').trim();
    const fileSize = parsePositiveInt(body.file_size, 0, Number.MAX_SAFE_INTEGER);
    if (!filename) return res.status(400).json({ detail: 'filename required' });
    if (!fileSize || fileSize <= 0) return res.status(400).json({ detail: 'file_size required' });

    const maxBytes = getConfig().maxFileSize;
    if (fileSize > maxBytes) {
      return res.status(413).json({
        code: 'FILE_TOO_LARGE',
        message: `File exceeds ${maxBytes} bytes`,
        request_id: nanoid(),
      });
    }

    const chunkSize = Math.min(
      Math.max(parsePositiveInt(body.chunk_size, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE), MIN_CHUNK_SIZE),
      MAX_CHUNK_SIZE,
    );
    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
    if (totalChunks > MAX_CHUNKS) {
      return res.status(400).json({ detail: `File requires more than ${MAX_CHUNKS} chunks` });
    }

    const sessionId = nanoid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    await db
      .prepare(
        `INSERT INTO upload_sessions (id, tenant_id, owner_id, filename, file_size, mime_type, file_hash, chunk_size,
         total_chunks, received_chunks, title, description, category_id, tag_names, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NOW(), NOW())`,
      )
      .run(
        sessionId,
        await resolveWriteTenant(db, req.tenantScope, req),
        req.user.id,
        filename,
        fileSize,
        body.mime_type || 'application/octet-stream',
        body.file_hash || null,
        chunkSize,
        totalChunks,
        '[]',
        body.title || null,
        body.description || null,
        body.category_id || null,
        body.tag_names || null,
        expiresAt,
      );

    fs.mkdirSync(sessionDir(getConfig().storageDir, sessionId), { recursive: true });

    return res.status(201).json({
      session_id: sessionId,
      chunk_size: chunkSize,
      total_chunks: totalChunks,
      received_chunks: [],
      expires_at: expiresAt,
    });
  }));

  router.put(
    '/upload/chunk/:session_id',
    authRequired(db),
    // A chunk is bounded by the largest chunk size the server hands out at
    // all — not by the whole-file limit. The file limit is for a file; a
    // chunk is a fraction of one, and a chunk of two gigabytes is a request
    // that would cost the process the memory before the protocol could
    // refuse it.
    chunkUploader.single('chunk'),
    asyncHandler(async (req, res) => {
      const sessionId = String(req.params.session_id || '');
      // A write lands in one concrete tenant — see `resolveWriteTenant`.
      const tenantId = await resolveWriteTenant(db, req.tenantScope, req);
      const loaded = await loadSession(db, tenantId, sessionId);
      if (!loaded) return res.status(404).json({ detail: 'Upload session not found' });
      const { session, received } = loaded;
      if (session.status !== 'pending') {
        return res.status(409).json({ detail: `Upload session is ${session.status}` });
      }
      if (sessionExpired(session)) {
        return res.status(410).json({ detail: 'Upload session has expired' });
      }
      if (session.owner_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== SUPERADMIN_ROLE) {
        return res.status(403).json({ detail: 'This upload session belongs to another user' });
      }
      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ detail: 'chunk required' });
      }
      // The session said how big a chunk is, and the client was told the
      // same number in the init answer. A chunk bigger than that is not a
      // chunk — and without this check a session could ask for a megabyte
      // and be sent gigabytes, one per index, until the disk was full.
      if (req.file.size > session.chunk_size) {
        return res.status(400).json({
          detail: `chunk is ${req.file.size} bytes; this session accepts ${session.chunk_size} bytes per chunk`,
        });
      }

      // The first chunk is index 0, so this must accept 0 — `parsePositiveInt`
      // would reject it and make every upload impossible to complete.
      const chunkIndex = parseNonNegativeInt(req.query.chunk_index, -1, MAX_CHUNKS);
      if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
        return res.status(400).json({
          detail: `chunk_index must be between 0 and ${session.total_chunks - 1}`,
        });
      }

      const dir = sessionDir(getConfig().storageDir, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${chunkIndex}.part`), req.file.buffer);

      if (!received.includes(chunkIndex)) {
        received.push(chunkIndex);
        received.sort((a, b) => a - b);
        await saveReceived(db, tenantId, sessionId, received);
      }

      return res.json({
        received_chunks: received,
        received: received.length,
        total_chunks: session.total_chunks,
      });
    }),
  );

  router.post('/upload/complete', authRequired(db), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const sessionId = String(body.session_id || '').trim();
    if (!sessionId) return res.status(400).json({ detail: 'session_id required' });

    const loaded = await loadSession(db, await resolveWriteTenant(db, req.tenantScope, req), sessionId);
    if (!loaded) return res.status(404).json({ detail: 'Upload session not found' });
    const { session, received } = loaded;
    if (session.owner_id !== req.user.id && req.user.role !== 'admin' && req.user.role !== SUPERADMIN_ROLE) {
      return res.status(403).json({ detail: 'This upload session belongs to another user' });
    }
    if (session.status === 'completed') {
      return res.status(409).json({ detail: 'Upload session is already completed' });
    }
    if (sessionExpired(session)) {
      return res.status(410).json({ detail: 'Upload session has expired' });
    }
    if (received.length !== session.total_chunks) {
      return res.status(400).json({
        detail: `Upload is incomplete: ${received.length}/${session.total_chunks} chunks received`,
      });
    }

    // The parts are merged **on disk**. Reading them into memory and
    // concatenating is what this endpoint exists to avoid: a file that does
    // not fit in memory is the reason a caller chunks it in the first place,
    // and the merge must not undo that.
    const dir = sessionDir(getConfig().storageDir, sessionId);
    const mergedPath = path.join(dir, 'merged');
    let mergedSize = 0;
    try {
      const out = fs.createWriteStream(mergedPath);
      for (let index = 0; index < session.total_chunks; index += 1) {
        const partPath = path.join(dir, `${index}.part`);
        if (!fs.existsSync(partPath)) {
          throw Object.assign(new Error(`Chunk ${index} is missing`), { status: 400 });
        }
        mergedSize += fs.statSync(partPath).size;
        await pipeline(fs.createReadStream(partPath), out, { end: false });
      }
      await new Promise((resolve, reject) => {
        out.end((error) => (error ? reject(error) : resolve()));
      });
    } catch (e) {
      return res.status(e.status || 500).json({ detail: e.message });
    }

    const result = await processUpload({
      db,
      storageDir: getConfig().storageDir,
      file: {
        path: mergedPath,
        originalname: session.filename,
        mimetype: session.mime_type || 'application/octet-stream',
        size: mergedSize,
      },
      ownerId: session.owner_id,
      source: 'chunked-upload',
      // The session already belongs to the caller's tenant — an upload can
      // never land in a tenant the credential does not speak for.
      tenantId: session.tenant_id || req.tenantScope.tenantId,
      extra: {
        title: body.title || session.title || null,
        description: body.description !== undefined ? body.description : session.description,
        category_id: body.category_id || session.category_id || null,
        tag_names: body.tag_names || session.tag_names || null,
      },
    });

    await db
      .prepare(
        "UPDATE upload_sessions SET status = 'completed', updated_at = NOW() WHERE tenant_id = ? AND id = ?",
      )
      .run(session.tenant_id, sessionId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[upload] failed to clean session scratch dir:', e.message);
    }

    return res.status(201).json(toAsset(result.asset));
  }));

  return router;
}

module.exports = createUploadRouter;
