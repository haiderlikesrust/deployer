#!/usr/bin/env node
/**
 * Simulates upgrading a LIVE install: builds a database at migration 1 only,
 * fills it with apps, env vars and deployment history, then runs the current
 * migration set and asserts nothing was lost and every new column exists.
 *
 *   node scripts/test-migration-upgrade.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from '../server/node_modules/better-sqlite3/lib/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const { migrations } = await import(pathToFileURL(path.join(ROOT, 'server/src/db/migrations.ts')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-mig-'));
const file = path.join(dir, 'deployer.db');
const db = new Database(file);
db.pragma('foreign_keys = ON');

let pass = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- an install that only ever ran migration 1 ----
db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
const first = migrations.find((m) => m.id === 1);
db.exec(first.sql);
db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(1, first.name, new Date().toISOString());

const ts = new Date().toISOString();
db.prepare(
  `INSERT INTO apps (id, name, repo_url, branch, type, domain, port, active_deployment_id, created_at, updated_at)
   VALUES (1, 'blog', 'https://github.com/me/blog', 'main', NULL, NULL, NULL, 10, ?, ?)`
).run(ts, ts);
db.prepare(
  `INSERT INTO apps (id, name, repo_url, branch, type, domain, port, active_deployment_id, created_at, updated_at)
   VALUES (2, 'arcsniper', 'https://github.com/me/arcsniper', 'main', 'worker', NULL, NULL, NULL, ?, ?)`
).run(ts, ts);
db.prepare('INSERT INTO env_vars (app_id, key, value) VALUES (1, ?, ?)').run('SECRET', 'keepme');
db.prepare(
  `INSERT INTO deployments (id, app_id, status, trigger, commit_sha, commit_msg, config_json, image_tag, container_id, created_at)
   VALUES (10, 1, 'live', 'manual', 'abc123', 'ship it', ?, 'dep-blog:10', 'dep-blog-10', ?)`
).run(JSON.stringify({ type: 'web', containerPort: 3000 }), ts);
db.prepare(
  `INSERT INTO deployments (id, app_id, status, trigger, created_at) VALUES (9, 1, 'superseded', 'manual', ?)`
).run(ts);
db.close();

// ---- upgrade using the real migration runner ----
process.env.DATA_DIR = dir;
const { getDb } = await import(pathToFileURL(path.join(ROOT, 'server/src/db/db.ts')).href);
const up = getDb();

console.log('\nmigration upgrade from a live install:');
const applied = up.prepare('SELECT id FROM migrations ORDER BY id').all().map((r) => r.id);
check('all migrations applied in order', JSON.stringify(applied) === JSON.stringify(migrations.map((m) => m.id)), applied.join(','));

const appCols = up.prepare('PRAGMA table_info(apps)').all().map((c) => c.name);
for (const col of ['root_dir', 'skip_env_check', 'env_schema_json', 'env_schema_detected_at']) {
  check(`apps.${col} exists`, appCols.includes(col));
}
const depCols = up.prepare('PRAGMA table_info(deployments)').all().map((c) => c.name);
for (const col of ['env_schema_json', 'env_missing_json']) {
  check(`deployments.${col} exists`, depCols.includes(col));
}

console.log('\nexisting data survives:');
const blog = up.prepare('SELECT * FROM apps WHERE name = ?').get('blog');
check('app row preserved', blog?.repo_url === 'https://github.com/me/blog');
check('active deployment pointer preserved', blog?.active_deployment_id === 10);
check('explicit worker type preserved', up.prepare('SELECT type FROM apps WHERE name = ?').get('arcsniper')?.type === 'worker');
check('env var preserved', up.prepare('SELECT value FROM env_vars WHERE app_id = 1 AND key = ?').get('SECRET')?.value === 'keepme');
const dep = up.prepare('SELECT * FROM deployments WHERE id = 10').get();
check('deployment history preserved', dep?.status === 'live' && dep?.commit_sha === 'abc123');
check('new columns default to NULL on old rows', dep.env_schema_json === null && dep.env_missing_json === null);
check('skip_env_check defaults falsy on old apps', !blog.skip_env_check);

console.log('\nlive web app keeps its type after upgrade:');
const cfg = JSON.parse(dep.config_json);
check('active deployment still records type=web', cfg.type === 'web');

// running the runner twice must be a no-op
const before = up.prepare('SELECT count(*) n FROM migrations').get().n;
const { getDb: again } = await import(pathToFileURL(path.join(ROOT, 'server/src/db/db.ts')).href + '?v=2');
again();
check('re-running migrations is idempotent', up.prepare('SELECT count(*) n FROM migrations').get().n === before);

up.close();
// Windows keeps a handle on the WAL files briefly; a failed cleanup must not
// mask the result of the checks above.
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // temp dir is disposable
}

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
