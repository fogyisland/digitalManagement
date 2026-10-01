const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const tmp = path.join(__dirname, 'tmp.db');
try { fs.unlinkSync(tmp); } catch {}
const db = new Database(tmp);
const schemaPath = path.join(__dirname, '..', 'src', 'server.js');
const src = fs.readFileSync(schemaPath, 'utf8');
const m = src.match(/db\.exec\(`([\s\S]*?)`\);/);
db.exec(m[1]);

const cols = db.prepare("PRAGMA table_info(assets)").all().map(c => c.name);
['source_tool','prompt','seed','model_name','job_id','metadata_json'].forEach(c => {
  if (!cols.includes(c)) throw new Error('missing column: ' + c);
});

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name);
['webhook_endpoints','webhook_logs','manifest_writes'].forEach(t => {
  if (!tables.includes(t)) throw new Error('missing table: ' + t);
});

console.log('schema OK');
db.close();
fs.unlinkSync(tmp);