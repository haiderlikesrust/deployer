import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { appHost } from '../config.js';
import type { AppRow, AppType, AppVolume, ConfigSource, ResolvedConfig } from '../types.js';
import { findDockerfile, sniffExpose } from './detect/dockerfile.js';
import { analyzeNode, nodeServerDockerfile, nodeStaticDockerfile } from './detect/node.js';
import { analyzePython, pythonDockerfile } from './detect/python.js';
import { hasRootIndexHtml, staticDockerfile, NGINX_CONF } from './detect/static.js';

const DEPLOY_YML_KEYS = ['type', 'port', 'build', 'start', 'dockerfile', 'health', 'domain', 'env', 'release', 'volumes'] as const;

const deployYmlSchema = z.object({
  type: z.enum(['web', 'worker', 'static']).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  build: z.string().optional(),
  start: z.string().optional(),
  dockerfile: z.string().optional(),
  health: z.string().regex(/^\//, 'health must be a path starting with /').optional(),
  domain: z.string().optional(),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  release: z.string().optional(),
  /** volumes: { data: /app/data } — name to container mount path */
  volumes: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'volume names are dns-safe slugs'), z.string().regex(/^\//, 'mount paths are absolute')).optional(),
});

type DeployYml = z.infer<typeof deployYmlSchema>;

const WORKER_REASON =
  'no web framework detected — running as a worker; no domain and no HTTP health check. ' +
  'Set type=web in app settings or deploy.yml if this is wrong.';

export interface ResolveOutput {
  cfg: ResolvedConfig;
  /** null when the repo's own Dockerfile is used. */
  generatedDockerfile: string | null;
  /** Extra files to place into the build context (e.g. nginx.conf). */
  extraContextFiles: { relPath: string; content: string }[];
}

/** Commands are injected into a generated Dockerfile — newlines would allow escaping the RUN/CMD line. */
function sanitizeCmd(cmd: string | null, what: string): string | null {
  if (cmd == null) return null;
  const c = cmd.replace(/\r/g, '').trim();
  if (c === '') return null;
  if (c.includes('\n')) throw new Error(`${what} must be a single line`);
  return c;
}

function parseDeployYml(repoDir: string, notes: string[]): DeployYml {
  const ymlPath = ['deploy.yml', 'deploy.yaml'].map((f) => path.join(repoDir, f)).find((p) => fs.existsSync(p));
  if (!ymlPath) return {};
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(ymlPath, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(ymlPath)} is not valid YAML: ${(e as Error).message}`);
  }
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path.basename(ymlPath)} must be a YAML mapping`);
  const unknown = Object.keys(raw).filter((k) => !(DEPLOY_YML_KEYS as readonly string[]).includes(k));
  if (unknown.length) notes.push(`deploy.yml: ignoring unknown keys: ${unknown.join(', ')}`);
  const parsed = deployYmlSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`deploy.yml is invalid — ${issues}`);
  }
  notes.push(`found ${path.basename(ymlPath)}`);
  return parsed.data;
}

/**
 * Merge config with per-key precedence: dashboard setting > deploy.yml > auto-detected.
 * The result (with per-key sources) is snapshotted into the deployment row.
 */
export function resolveConfig(
  app: AppRow,
  envVars: { key: string; value: string }[],
  repoDir: string,
  opts: { previousType?: AppType | null; serviceEnv?: Record<string, string> } = {}
): ResolveOutput {
  const notes: string[] = [];
  const sources: Record<string, ConfigSource> = {};
  const yml = parseDeployYml(repoDir, notes);

  const pick = <T>(key: string, ui: T | null | undefined, ymlVal: T | null | undefined, auto: T | null | undefined): T | null => {
    if (ui != null && ui !== ('' as unknown as T)) {
      sources[key] = 'ui';
      return ui;
    }
    if (ymlVal != null && ymlVal !== ('' as unknown as T)) {
      sources[key] = 'yml';
      return ymlVal;
    }
    if (auto != null) {
      sources[key] = 'auto';
      return auto;
    }
    return null;
  };

  const uiBuild = sanitizeCmd(app.build_cmd, 'build command');
  const uiStart = sanitizeCmd(app.start_cmd, 'start command');
  const ymlBuild = sanitizeCmd(yml.build ?? null, 'deploy.yml build');
  const ymlStart = sanitizeCmd(yml.start ?? null, 'deploy.yml start');

  const explicitType = (app.type ?? undefined) != null ? (app.type as AppType) : yml.type ?? null;
  if (app.type) sources.type = 'ui';
  else if (yml.type) sources.type = 'yml';

  /**
   * Guessing "worker" for something already serving traffic would drop its
   * Traefik route while the deploy still reports success — the site goes dark
   * silently. Detection may promote to web, never demote away from it.
   */
  const keepsWebFromHistory = explicitType == null && opts.previousType === 'web';
  const autoTypeFrom = (evidence: string | null): { type: AppType; fromHistory: boolean } => {
    if (evidence) return { type: 'web', fromHistory: false };
    if (keepsWebFromHistory) return { type: 'web', fromHistory: true };
    return { type: 'worker', fromHistory: false };
  };
  const HISTORY_REASON =
    'no web framework detected, but this app is already serving as a web app — keeping type=web. ' +
    'Set type=worker in app settings or deploy.yml if it should be a background job.';

  const dockerfileOverride = pick('dockerfile', app.dockerfile_path, yml.dockerfile ?? null, null);
  const dockerfileFound = findDockerfile(repoDir, dockerfileOverride);

  let builder: ResolvedConfig['builder'];
  let type: AppType;
  let containerPort: number;
  let buildCmd = pick('build', uiBuild, ymlBuild, null);
  let startCmd = pick('start', uiStart, ymlStart, null);
  let generatedDockerfile: string | null = null;
  const extraContextFiles: ResolveOutput['extraContextFiles'] = [];
  /** The auto-detection story; only used when the type was not set explicitly. */
  let autoTypeReason = '';
  let webEvidence: string | null = null;

  if (dockerfileFound) {
    builder = 'dockerfile';
    // A committed Dockerfile is strong intent to serve something — never demote it to a worker.
    type = explicitType ?? 'web';
    if (!sources.type) sources.type = 'auto';
    const sniffed = sniffExpose(repoDir, dockerfileFound.relPath);
    const port = pick('port', app.port, yml.port ?? null, sniffed ?? 3000);
    containerPort = port!;
    webEvidence = `repo Dockerfile '${dockerfileFound.relPath}'`;
    autoTypeReason = `repo Dockerfile found — running as a web app on port ${containerPort}`;
    if (!sniffed && explicitType == null) {
      notes.push(
        `no EXPOSE in the Dockerfile — assuming a web app on port ${containerPort}; ` +
          'set type=worker in app settings or deploy.yml if this is a background job'
      );
    }
    if (sources.port === 'auto') {
      notes.push(
        sniffed
          ? `using repo Dockerfile '${dockerfileFound.relPath}' — port ${sniffed} sniffed from EXPOSE`
          : `using repo Dockerfile '${dockerfileFound.relPath}' — no EXPOSE found, assuming port 3000 (set the port in app settings or deploy.yml if wrong)`
      );
    } else {
      notes.push(`using repo Dockerfile '${dockerfileFound.relPath}' (port ${containerPort} from ${sources.port})`);
    }
    if (buildCmd || startCmd) notes.push('note: build/start command overrides are ignored when a Dockerfile is used');
  } else {
    const node = analyzeNodeSafe(repoDir, explicitType, startCmd, notes);
    if (node) {
      notes.push(...node.notes);
      const wantsStatic = explicitType === 'static' || (node.kind === 'static' && explicitType == null);
      if (wantsStatic && node.buildCmd == null && !startCmd) {
        if (hasRootIndexHtml(repoDir)) {
          builder = 'static';
          type = 'static';
          containerPort = 80;
          generatedDockerfile = staticDockerfile();
          extraContextFiles.push({ relPath: '.deployer/nginx.conf', content: NGINX_CONF });
          autoTypeReason = 'no build script, index.html at the repo root — building once and serving with nginx';
          notes.push('no build script — serving repository files directly with nginx');
        } else {
          throw new Error('type is static but there is no build script and no index.html at the repo root');
        }
      } else if (wantsStatic) {
        builder = 'node-static';
        type = 'static';
        containerPort = 80;
        const build = buildCmd ? `RUN ${buildCmd}` : node.buildCmd!;
        generatedDockerfile = nodeStaticDockerfile({ installCmds: node.installCmds, copyFiles: node.copyFiles, buildCmd: build });
        extraContextFiles.push({ relPath: '.deployer/nginx.conf', content: NGINX_CONF });
        autoTypeReason = 'frontend build script detected — building once and serving with nginx';
        if (app.port || yml.port) notes.push('note: port setting ignored for static sites (nginx serves on 80 internally)');
      } else {
        builder = 'node';
        const auto = autoTypeFrom(node.webEvidence);
        type = explicitType ?? auto.type;
        if (!sources.type) sources.type = 'auto';
        webEvidence = node.webEvidence;
        const port = pick('port', app.port, yml.port ?? null, 3000);
        containerPort = port!;
        autoTypeReason = node.webEvidence
          ? `${node.webEvidence} — running as a web app on port ${containerPort}`
          : auto.fromHistory
            ? HISTORY_REASON
            : WORKER_REASON;
        const finalStart = startCmd ?? node.startCmd;
        if (!finalStart) throw new Error('could not determine a start command — set one in app settings or deploy.yml');
        if (!startCmd && node.startCmd) sources.start = 'auto';
        startCmd = finalStart;
        const build = buildCmd ? `RUN ${buildCmd}` : node.buildCmd;
        if (!buildCmd && node.buildCmd) sources.build = 'auto';
        generatedDockerfile = nodeServerDockerfile({
          installCmds: node.installCmds,
          copyFiles: node.copyFiles,
          buildCmd: build,
          startCmd: finalStart,
          pruneCmd: node.pruneCmd,
          port: containerPort,
        });
      }
    } else {
      const py = analyzePython(repoDir);
      if (py) {
        notes.push(...py.notes);
        builder = 'python';
        const auto = autoTypeFrom(py.webEvidence);
        type = explicitType ?? auto.type;
        if (!sources.type) sources.type = 'auto';
        webEvidence = py.webEvidence;
        const port = pick('port', app.port, yml.port ?? null, 3000);
        containerPort = port!;
        autoTypeReason = py.webEvidence
          ? `${py.webEvidence} — running as a web app on port ${containerPort}`
          : auto.fromHistory
            ? HISTORY_REASON
            : WORKER_REASON;
        const finalStart = startCmd ?? py.startCmd;
        if (!finalStart) {
          throw new Error(
            'Python project detected but no start command could be determined — set one in app settings or deploy.yml (e.g. "uvicorn main:app --host 0.0.0.0 --port $PORT")'
          );
        }
        if (!startCmd && py.startCmd) sources.start = 'auto';
        startCmd = finalStart;
        generatedDockerfile = pythonDockerfile({ installLines: py.installLines, buildCmd, startCmd: finalStart, port: containerPort });
      } else if (hasRootIndexHtml(repoDir)) {
        builder = 'static';
        type = explicitType ?? 'static';
        if (!sources.type) sources.type = 'auto';
        containerPort = 80;
        generatedDockerfile = staticDockerfile();
        extraContextFiles.push({ relPath: '.deployer/nginx.conf', content: NGINX_CONF });
        autoTypeReason = 'index.html found at the repo root — building once and serving with nginx';
        notes.push('index.html found at repo root — serving as a static site with nginx');
      } else {
        throw new Error(
          'could not detect how to build this repo: no Dockerfile, no package.json, no requirements.txt/pyproject.toml, no index.html. ' +
            'Commit a Dockerfile to deploy any other stack.'
        );
      }
    }
  }

  const typeReason =
    sources.type === 'ui'
      ? `type=${type} (set in app settings)`
      : sources.type === 'yml'
        ? `type=${type} (set in deploy.yml)`
        : autoTypeReason;
  notes.push(typeReason);

  let healthPath = pick('health', app.healthcheck_path, yml.health ?? null, null);
  const domain = pick('domain', app.domain, yml.domain ?? null, null);
  const domainHost = type === 'worker' ? null : appHost(app.name, domain);
  if (type !== 'worker' && !sources.domain) sources.domain = 'auto';

  if (type === 'worker') {
    if (healthPath) {
      notes.push('note: health path ignored for workers (no HTTP route)');
      healthPath = null;
      delete sources.health;
    }
    if (domain) {
      notes.push('note: domain ignored for workers (no HTTP route)');
      delete sources.domain;
    }
  }

  // env merge: deploy.yml < injected service URLs < dashboard, PORT forced last
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(yml.env ?? {})) env[k] = String(v);
  for (const [k, v] of Object.entries(opts.serviceEnv ?? {})) env[k] = v;
  for (const { key, value } of envVars) env[key] = value;
  if (env.PORT && env.PORT !== String(containerPort)) {
    notes.push(`note: PORT env override (${env.PORT}) replaced with the resolved container port ${containerPort} — set "port" instead`);
  }
  env.PORT = String(containerPort);

  const releaseCmd = pick('release', sanitizeCmd(app.release_cmd, 'release command'), sanitizeCmd(yml.release ?? null, 'deploy.yml release'), null);

  // volumes: dashboard replaces yml wholesale (per-key merging of mounts would surprise)
  let volumes: AppVolume[] = [];
  const uiVolumes = parseVolumesJson(app.volumes_json);
  if (uiVolumes.length) {
    volumes = uiVolumes;
    sources.volumes = 'ui';
  } else if (yml.volumes && Object.keys(yml.volumes).length) {
    volumes = Object.entries(yml.volumes).map(([name, p]) => ({ name, path: p }));
    sources.volumes = 'yml';
  }
  if (volumes.length) {
    notes.push(
      `persistent volume(s): ${volumes.map((v) => `${v.name} → ${v.path}`).join(', ')} — deploys use stop-then-start (brief downtime) so two containers never share the data`
    );
  }

  const cfg: ResolvedConfig = {
    type,
    domainHost,
    containerPort,
    buildCmd,
    startCmd,
    healthPath,
    env,
    builder,
    dockerfilePath: dockerfileFound?.relPath ?? null,
    sources,
    notes,
    typeReason,
    webEvidence,
    volumes,
    releaseCmd,
  };
  return { cfg, generatedDockerfile, extraContextFiles };
}

export function parseVolumesJson(json: string | null): AppVolume[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is AppVolume => typeof v?.name === 'string' && typeof v?.path === 'string');
  } catch {
    return [];
  }
}

/** Node analysis, but soft-failing into "not a node repo" only when package.json is absent. */
function analyzeNodeSafe(
  repoDir: string,
  explicitType: AppType | null,
  startOverride: string | null,
  notes: string[]
): ReturnType<typeof analyzeNode> {
  try {
    return analyzeNode(repoDir);
  } catch (e) {
    // A start override rescues repos analyzeNode couldn't classify
    if (startOverride && fs.existsSync(path.join(repoDir, 'package.json'))) {
      notes.push('package.json could not be auto-classified — using the configured start command');
      return {
        kind: explicitType === 'static' ? 'static' : 'server',
        installCmds: ['RUN npm install'],
        buildCmd: null,
        startCmd: startOverride,
        pruneCmd: null,
        copyFiles: ['package.json'],
        // A hand-configured start command stays a web app: demoting it would silently
        // strip the domain from installs that work today.
        webEvidence: 'custom start command configured',
        notes: [],
      };
    }
    throw e;
  }
}
