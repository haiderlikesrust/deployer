import type { Deployment, EnvSchema } from '../api/client';

export interface RequiredEnvKey {
  key: string;
  example?: string;
  description?: string;
  secret?: boolean;
}

const NOTE_RE = /missing (?:required )?env(?:ironment)? var(?:iable)?s?:?\s*(.+)/i;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function splitKeys(blob: string): string[] {
  return blob
    .split(/[,\s]+/)
    .map((s) => s.replace(/[`'"().]/g, '').trim())
    .filter((s) => KEY_RE.test(s));
}

function fromSchema(schema: EnvSchema | null | undefined, keys: string[]): RequiredEnvKey[] {
  const byKey = new Map(schema?.vars.map((v) => [v.key, v]) ?? []);
  return keys.map((key) => {
    const spec = byKey.get(key);
    const out: RequiredEnvKey = { key };
    if (spec?.example) out.example = spec.example;
    if (spec?.description) out.description = spec.description;
    if (spec?.secret) out.secret = true;
    return out;
  });
}

/**
 * Which env vars a deployment is waiting on. Server-side detection wins; the
 * regex fallbacks exist so this still says something useful against an older
 * server that has no `.env.example` support. Returns [] when there is nothing
 * real to say — a speculative "you might need env vars" banner trains people
 * to ignore it.
 */
export function detectRequiredEnv(
  deployment: Deployment | null | undefined,
  currentEnvKeys: Iterable<string> = []
): RequiredEnvKey[] {
  if (!deployment) return [];
  const have = new Set(currentEnvKeys);

  // (a) authoritative: the server told us exactly which keys are missing
  if (deployment.envMissing && deployment.envMissing.length) {
    return fromSchema(
      deployment.envSchema,
      deployment.envMissing.filter((k) => !have.has(k))
    );
  }

  // (b) the resolved config's notes
  const found: string[] = [];
  for (const note of deployment.config?.notes ?? []) {
    const m = NOTE_RE.exec(note);
    if (m?.[1]) found.push(...splitKeys(m[1]));
  }

  // (c) last resort: the failure text
  if (!found.length && deployment.error) {
    const m = NOTE_RE.exec(deployment.error);
    if (m?.[1]) found.push(...splitKeys(m[1]));
  }

  const unique = [...new Set(found)].filter((k) => !have.has(k));
  return fromSchema(deployment.envSchema, unique);
}

/** Stable id for the sessionStorage dismissal key. */
export function envKeysHash(keys: string[]): string {
  const joined = [...keys].sort().join(',');
  let h = 0;
  for (let i = 0; i < joined.length; i++) h = (Math.imul(31, h) + joined.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
