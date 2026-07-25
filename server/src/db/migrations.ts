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
];
