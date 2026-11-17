#!/usr/bin/env node

/**
 * Build the release bundle in `up/` — the content that goes to the server.
 *
 * The bundle is not a guess at what the server needs: it is the same set the
 * `Dockerfile` copies into its runtime stage, minus the container's own
 * concerns (the image builds the frontend; here the frontend is built first
 * and shipped).
 *
 *   dist/              the frontend build — the server serves it as static files
 *   src/server/        the runtime — the application is plain CommonJS, and
 *                      nothing outside this directory is required at run time
 *   package.json       + package-lock.json — so `npm ci --omit=dev` reproduces
 *                      the exact dependency tree that was tested
 *   .env.example       the configuration contract
 *   storage/           the writable skeleton
 *   scripts/           the database bootstrap SQL
 *   docs/              the Nginx guide
 *
 * `node_modules` is deliberately **not** in the bundle: `sharp` and `bcryptjs`
 * carry native binaries, and they have to be built for the machine that will
 * run them. The server installs them with `npm ci --omit=dev`.
 *
 * Usage:
 *   node scripts/build-release.mjs              build the frontend, then bundle
 *   node scripts/build-release.mjs --skip-build use the existing dist/
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT_DIR, 'up');
const TEMPLATE_DIR = path.join(ROOT_DIR, 'scripts', 'release');

/**
 * Every directory the application writes to. They are created empty, with a
 * `.gitkeep` so the shape survives the upload.
 */
const STORAGE_DIRS = [
  'originals',
  'thumbnails',
  'previews',
  'temp',
  'manifests',
  'placeholders',
];

/**
 * Copy a file or a directory tree.
 *
 * @param {string} from absolute source path
 * @param {string} to absolute destination path
 */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

/**
 * The newest modification time under a path.
 *
 * @param {string} target absolute path
 * @returns {number} epoch milliseconds, 0 when the path does not exist
 */
function newestMtime(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

/**
 * Is the frontend build newer than everything that goes into it?
 *
 * A stale `dist/` is the quiet failure: the bundle looks complete, the server
 * starts, and it serves the previous build's chunks — which the previous
 * build's `index.html` names, so nothing breaks visibly, and the operator
 * believes they deployed the new code.
 *
 * @returns {{ok: boolean, reason: string}}
 */
function checkFrontendFreshness() {
  const indexHtml = path.join(ROOT_DIR, 'dist', 'index.html');
  if (!fs.existsSync(indexHtml)) {
    return { ok: false, reason: 'there is no dist/ — the frontend has never been built' };
  }
  const builtAt = fs.statSync(indexHtml).mtimeMs;
  const sources = [
    path.join(ROOT_DIR, 'src', 'client'),
    path.join(ROOT_DIR, 'index.html'),
    path.join(ROOT_DIR, 'vite.config.ts'),
    path.join(ROOT_DIR, 'package.json'),
  ];
  for (const source of sources) {
    const changedAt = newestMtime(source);
    if (changedAt > builtAt) {
      return {
        ok: false,
        reason: `${path.relative(ROOT_DIR, source)} is newer than dist/ — the build is stale`,
      };
    }
  }
  return { ok: true, reason: 'dist/ is newer than every source that goes into it' };
}

/**
 * Run the frontend build.
 *
 * On Windows `npm` is a `.cmd` shim, which Node refuses to spawn without a
 * shell. The reason the build failed is always printed — a build step that
 * fails quietly is a build step whose failure gets shipped.
 *
 * @returns {number} the exit code
 */
function buildFrontend() {
  console.log('[build] npm run build (tsc -b && vite build) ...');
  const result =
    process.platform === 'win32'
      ? spawnSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit', shell: true })
      : spawnSync('npm', ['run', 'build'], { cwd: ROOT_DIR, stdio: 'inherit' });
  if (result.error) {
    console.error(`[build] the build could not be started: ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error('[build] the build was killed before it finished');
    return 1;
  }
  if (result.status !== 0) {
    console.error(`[build] the frontend build failed (exit ${result.status}) — nothing was written`);
  }
  return result.status;
}

/**
 * Every file in the bundle, relative to the bundle root, sorted.
 *
 * @param {string} dir absolute directory
 * @param {string} [prefix] the relative prefix to prepend
 * @returns {string[]} relative paths, using forward slashes
 */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), relative));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

/**
 * The git commit the bundle was cut from.
 *
 * @returns {string} the short hash, or 'unknown'
 */
function gitCommit() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'unknown';
  return result.stdout.trim() || 'unknown';
}

/**
 * Whether the working tree is clean — a bundle cut from a dirty tree is not
 * reproducible, and nobody can say afterwards what was in it.
 *
 * @returns {string} 'clean' or a description
 */
function gitState() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (result.status !== 0) return 'unknown';
  const lines = result.stdout.trim();
  return lines === '' ? 'clean' : 'dirty';
}

function main() {
  const skipBuild = process.argv.includes('--skip-build');

  if (!skipBuild) {
    const code = buildFrontend();
    if (code !== 0) {
      console.error('[build] the frontend build failed — nothing was written to up/');
      process.exit(code);
    }
  }

  const freshness = checkFrontendFreshness();
  if (!freshness.ok) {
    console.error(`[build] refusing to bundle: ${freshness.reason}`);
    console.error('[build] run `npm run build` first, or drop --skip-build');
    process.exit(1);
  }
  console.log(`[build] ${freshness.reason}`);

  console.log(`[bundle] writing ${path.relative(ROOT_DIR, OUT_DIR)}/ ...`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // --- The runtime ---------------------------------------------------------
  copy(path.join(ROOT_DIR, 'dist'), path.join(OUT_DIR, 'dist'));
  copy(path.join(ROOT_DIR, 'src', 'server'), path.join(OUT_DIR, 'src', 'server'));
  copy(path.join(ROOT_DIR, 'package.json'), path.join(OUT_DIR, 'package.json'));
  copy(path.join(ROOT_DIR, 'package-lock.json'), path.join(OUT_DIR, 'package-lock.json'));
  copy(path.join(ROOT_DIR, '.env.example'), path.join(OUT_DIR, '.env.example'));
  copy(
    path.join(ROOT_DIR, 'scripts', 'create-database.sql'),
    path.join(OUT_DIR, 'scripts', 'create-database.sql'),
  );
  copy(
    path.join(ROOT_DIR, 'docs', 'DEPLOY-NGINX.md'),
    path.join(OUT_DIR, 'docs', 'DEPLOY-NGINX.md'),
  );

  // --- The writable skeleton ----------------------------------------------
  for (const dir of STORAGE_DIRS) {
    const target = path.join(OUT_DIR, 'storage', dir);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.gitkeep'), '');
  }

  // --- The operator's files ------------------------------------------------
  for (const name of fs.readdirSync(TEMPLATE_DIR)) {
    if (name.endsWith('.md') || name.endsWith('.sh') || name.endsWith('.example')) {
      copy(path.join(TEMPLATE_DIR, name), path.join(OUT_DIR, name));
    }
  }

  // --- The manifest --------------------------------------------------------
  const files = listFiles(OUT_DIR).filter(
    (name) => name !== 'SHA256SUMS' && name !== 'MANIFEST.txt',
  );
  const lines = [];
  let total = 0;
  for (const relative of files) {
    const absolute = path.join(OUT_DIR, relative);
    const bytes = fs.readFileSync(absolute);
    total += bytes.length;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    // The two-space separator is what `sha256sum -c` expects.
    lines.push(`${digest}  ${relative}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS'), lines.join('\n') + '\n', 'utf8');

  const commit = gitCommit();
  const state = gitState();
  const manifest = [
    '数字资产管理系统 (DAM) — 发布清单',
    '',
    `生成时间    ${new Date().toISOString()}`,
    `源码提交    ${commit}（工作树：${state}）`,
    `Node 版本   ${process.version}`,
    `文件数      ${files.length}`,
    `总大小      ${(total / 1024 / 1024).toFixed(2)} MB`,
    '',
    '校验：',
    '  sha256sum -c SHA256SUMS                 （Linux）',
    '  certutil -hashfile <file> SHA256        （Windows，逐个）',
    '',
    '这个包里有什么：',
    '  dist/              前端构建产物（服务器直接作为静态文件发出）',
    '  src/server/        服务端运行时（含 openapi.yaml，喂 /docs 与 /redoc）',
    '  package.json       依赖清单（服务器执行 npm ci --omit=dev）',
    '  package-lock.json  锁定版本，保证装的和测过的是同一棵依赖树',
    '  .env.example       配置模板',
    '  storage/           可写目录骨架',
    '  scripts/create-database.sql  建库与建账号',
    '  docs/DEPLOY-NGINX.md         Nginx 部署指南',
    '  start.sh           启动脚本',
    '  nginx.conf.example 反向代理配置样例',
    '  DEPLOY.md          部署步骤',
    '',
    '这个包里没有什么：',
    '  node_modules/      故意不带。sharp 与 bcryptjs 带原生二进制，必须在目标',
    '                     机上编译，服务器上执行 npm ci --omit=dev 生成。',
    '  .env               故意不带。里面是密钥。照 .env.example 改一份。',
    '  storage/ 的内容    只有目录骨架。上传的原件不在发布包里。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.txt'), manifest, 'utf8');

  console.log(`[bundle] ${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[bundle] commit ${commit} (${state})`);
  console.log('[bundle] done — next: node scripts/release/verify-release.mjs');
}

main();
