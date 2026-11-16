'use strict';

/**
 * The API documentation this instance serves.
 *
 * The specification lives in `src/server/openapi.yaml` and is the same file
 * the contract guard reads: the documentation the reader sees and the
 * documentation the build checks cannot drift apart, because there is only
 * one of them.
 *
 * Three things are served:
 *
 *   - `/docs` — Swagger UI, for reading and trying the endpoints;
 *   - `/redoc` — ReDoc, for reading them;
 *   - `/openapi.json` — the specification itself, for tooling.
 *
 * They are mounted on the instance, not on a separate site, so they are
 * always the documentation *of this instance*: the "servers" entry in the
 * specification points at the address the platform says this instance answers
 * at, which is the same address the interface shows and the same address a
 * link in the interface carries.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const { currentSettings } = require('./platform-settings');

/** The specification, next to this file's directory's parent. */
const SPEC_FILE = path.join(__dirname, '..', 'openapi.yaml');

/** ReDoc's browser bundle, straight out of the package. */
const REDOC_BUNDLE = require.resolve('redoc/bundles/redoc.standalone.js');

/**
 * The parsed specification.
 *
 * The paths never change while the process runs, so the file is read once.
 * The server address does change — the platform administrator can set it at
 * any time — so that part is refreshed on every request.
 */
let cached = null;

/**
 * Read the specification from disk, once.
 *
 * @returns {object}
 */
function loadSpec() {
  if (cached !== null) return cached;
  const spec = yaml.load(fs.readFileSync(SPEC_FILE, 'utf8'));
  if (!spec || typeof spec !== 'object') {
    throw new Error(`the OpenAPI specification at ${SPEC_FILE} could not be read`);
  }
  cached = spec;
  return cached;
}

/**
 * The specification as it should be served right now.
 *
 * @returns {object}
 */
function currentSpec() {
  const spec = loadSpec();
  const domain = String(currentSettings().access_domain || '').replace(/\/+$/, '');
  spec.servers = domain
    ? [{ url: domain, description: '这个实例对外的地址' }]
    : [{ url: '/', description: '这个实例自己' }];
  return spec;
}

/**
 * The page ReDoc renders. It fetches the specification itself.
 *
 * The page deliberately carries no styling of its own: ReDoc brings its own
 * theme, and a background painted underneath it only fights with the text it
 * draws — dark text on a dark page is unreadable, and the reader has no way
 * of knowing that is a mistake rather than the design.
 */
const REDOC_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>接口文档 · 数字资产管理系统</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="/redoc/redoc.standalone.js"></script>
  </body>
</html>
`;

/**
 * Mount the documentation on the application.
 *
 * These are pages, not API operations: they are not part of the route table
 * the contract guard compares the specification against, and the
 * specification does not describe them.
 *
 * @param {import('express').Application} app
 */
function mountDocs(app) {
  // Swagger UI's own assets (the CSS and the JavaScript) live under /docs.
  app.use('/docs', swaggerUi.serve);
  app.get('/docs', (req, res, next) => {
    swaggerUi.setup(currentSpec(), { customSiteTitle: '接口文档 · 数字资产管理系统' })(
      req,
      res,
      next,
    );
  });

  app.get('/redoc', (_req, res) => {
    res.type('html').send(REDOC_PAGE);
  });
  app.get('/redoc/redoc.standalone.js', (_req, res) => {
    res.sendFile(REDOC_BUNDLE);
  });

  // The specification itself, for tools that want the machine-readable form.
  app.get('/openapi.json', (_req, res) => {
    res.json(currentSpec());
  });
}

module.exports = {
  SPEC_FILE,
  loadSpec,
  currentSpec,
  mountDocs,
};
