/**
 * Migrations are embedded as strings (rather than .sql files) so `tsc` output
 * is self-contained — nothing extra to copy into the runtime image.
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE apps (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL UNIQUE,
  repo_url             TEXT NOT NULL,
  branch               TEXT NOT NULL DEFAULT '',
  type                 TEXT CHECK (type IN ('web','worker','static')),
  domain               TEXT,
  port                 INTEGER,
  build_cmd            TEXT,
  start_cmd            TEXT,
  healthcheck_path     TEXT,
  dockerfile_path      TEXT,
  memory_limit         TEXT,
  git_token            TEXT,
  webhook_secret       TEXT,
  active_deployment_id INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE env_vars (
  id     INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  UNIQUE (app_id, key)
);

CREATE TABLE deployments (
  id           INTEGER PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'queued',
  failed_stage TEXT,
  error        TEXT,
  trigger      TEXT NOT NULL DEFAULT 'manual',
  commit_sha   TEXT,
  commit_msg   TEXT,
  config_json  TEXT,
  image_tag    TEXT,
  container_id TEXT,
  log_file     TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE INDEX idx_deployments_app ON deployments(app_id, id DESC);
CREATE INDEX idx_env_vars_app ON env_vars(app_id);
`,
  },
  {
    id: 2,
    name: 'app_root_dir',
    // Monorepos: build from a subdirectory instead of the repo root.
    sql: `ALTER TABLE apps ADD COLUMN root_dir TEXT;`,
  },
  {
    id: 3,
    name: 'env_schema_and_skip',
    // .env.example detection: the latest parsed schema is cached on the app so the
    // Environment tab can show it before a successful deploy exists.
    sql: `
ALTER TABLE apps ADD COLUMN env_schema_json TEXT;
ALTER TABLE apps ADD COLUMN env_schema_detected_at TEXT;
ALTER TABLE apps ADD COLUMN skip_env_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN env_schema_json TEXT;
ALTER TABLE deployments ADD COLUMN env_missing_json TEXT;
`,
  },
  {
    id: 4,
    name: 'state_volumes_services_release',
    // Stateful apps: named volumes, a release (migration) command, and managed
    // database containers linked to apps via injected env vars.
    sql: `
ALTER TABLE apps ADD COLUMN volumes_json TEXT;
ALTER TABLE apps ADD COLUMN release_cmd TEXT;

CREATE TABLE services (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('postgres','redis','mongo')),
  version    TEXT NOT NULL,
  password   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE service_links (
  id         INTEGER PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env_key    TEXT NOT NULL,
  UNIQUE (service_id, app_id)
);
`,
  },
  {
    id: 5,
    name: 'metrics',
    // 30s samples from docker stats, pruned after 25h — enough for a day of sparklines.
    sql: `
CREATE TABLE metrics (
  app_id    INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  cpu_pct   REAL NOT NULL,
  mem_bytes INTEGER NOT NULL
);
CREATE INDEX idx_metrics_app_ts ON metrics(app_id, ts);
`,
  },
];
