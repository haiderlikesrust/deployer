import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { migrations } from './migrations.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(paths.logs(), { recursive: true });
  fs.mkdirSync(paths.builds(), { recursive: true });
  fs.mkdirSync(paths.tmp(), { recursive: true });

  db = new Database(paths.db());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM migrations').all().map((r: any) => r.id as number));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db!.exec(m.sql);
      db!.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, new Date().toISOString());
    })();
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
