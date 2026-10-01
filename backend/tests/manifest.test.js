const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), 'manifest-test.db');
try { fs.unlinkSync(tmpDb); } catch {}
const db = new Database(tmpDb);
db.exec(`CREATE TABLE assets (
  id TEXT PRIMARY KEY, title TEXT, asset_type TEXT, file_size INTEGER,
  original_path TEXT, thumbnail_path TEXT, created_at TEXT,
  source_tool TEXT, prompt TEXT, seed INTEGER, model_name TEXT, job_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE manifest_writes (id TEXT PRIMARY KEY, asset_id TEXT, op TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now')));`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
const m = require('../src/lib/manifest');
assert.strictEqual(typeof m.writeManifestIndex, 'function');
console.log('manifest lib OK');
db.close(); fs.unlinkSync(tmpDb); fs.rmSync(tmpDir, { recursive: true });

const Database2 = require('better-sqlite3');
const fs2 = require('fs');
const path2 = require('path');
const os2 = require('os');
const assert2 = require('assert');

(async () => {
  const db2 = new Database2(':memory:');
  db2.exec(`CREATE TABLE assets (id TEXT PRIMARY KEY, title TEXT, asset_type TEXT, file_size INTEGER, original_name TEXT, mime_type TEXT, width INTEGER, height INTEGER, duration REAL, source_tool TEXT, prompt TEXT, seed INTEGER, model_name TEXT, job_id TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT, status TEXT NOT NULL DEFAULT 'ready', thumbnail_path TEXT);
  CREATE TABLE manifest_writes (id TEXT PRIMARY KEY, asset_id TEXT, op TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  db2.prepare("INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('a1','Test','image',1024,'a1.png','image/png',1024,1024,null,'comfyui','a cat',42,'sdxl','job-1',null,new Date().toISOString(),new Date().toISOString(),'ready',null);

  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mf2-'));
  const res = await m.writeManifestIndex(db2, dir);
  assert2.strictEqual(res.count, 1);
  const out = JSON.parse(fs2.readFileSync(path2.join(dir, 'manifests', 'index.json'), 'utf8'));
  assert2.strictEqual(out.assets[0].id, 'a1');
  assert2.strictEqual(out.assets[0].source_tool, 'comfyui');
  assert2.strictEqual(out.assets[0].seed, 42);
  console.log('manifest write OK');
  fs2.rmSync(dir, { recursive: true });
  db2.close();
})();
