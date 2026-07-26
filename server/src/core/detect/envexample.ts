import fs from 'node:fs';
import path from 'node:path';
import type { EnvSchema, EnvVarSpec } from '../../types.js';

/** Checked in order at the resolved build root; first match wins, no recursion. */
const CANDIDATE_FILES = ['.env.example', '.env.sample', '.env.template', 'env.example', '.env.dist'];

const MAX_FILE_BYTES = 256_000;
const MAX_VARS = 200;
const MAX_DESCRIPTION = 300;

/** PORT is injected by the runner, so a repo can never make it mandatory. */
const NEVER_REQUIRED = ['PORT'];

const ASSIGN_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENTED_ASSIGN_RE = /^#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const SECRET_RE = /(SECRET|TOKEN|_KEY|^KEY$|KEY$|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|CREDENTIALS|_DSN$|AUTH|SIGNING|SALT|CERT)/i;

const PLACEHOLDER_EXACT = new Set([
  'changeme', 'change', 'changethis', 'changethisvalue', 'todo', 'tbd', 'fixme', 'placeholder', 'replaceme',
  'yourvaluehere', 'yourkeyhere', 'yourapikey', 'yourapikeyhere', 'yoursecret', 'yoursecretkey', 'yourtoken',
  'yourpassword', 'yourpasswordhere', 'yourusername', 'myapikey', 'mysecret', 'secret', 'secretkey', 'apikey',
  'apikeyhere', 'token', 'tokenhere', 'password', 'passwordhere', 'insertkeyhere', 'addyourkeyhere',
  'enteryourkeyhere', 'none', 'null', 'undefined', 'required', 'optional',
]);

const PLACEHOLDER_PATTERNS = [
  /^<.+>$/,
  /^\{\{.*\}\}$/,
  /^\[.+\]$/,
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/,
  /^x{3,}$/i,
  /^\.{3,}$/,
  /^-+$/,
  /^your[-_. ]/i,
  /^my[-_]?(api|secret|token|key|password)/i,
  /^(change|replace|insert|enter|add)[-_ ]?(me|this|it|here|your)/i,
  /(goes[-_ ]?here|[-_ ]here)$/i,
  /^(example|sample|dummy|fake)[-_.]?(key|token|secret|value|password|id|url)$/i,
  /^(sk|pk)[-_](test|live)?[-_]?x+$/i,
];

/**
 * Look for a committed env example file at the build root. Returns null when
 * there is none (or it is implausibly large); `log` surfaces the skip reason.
 * `commitSha` is left null — the pipeline fills it in.
 */
export function detectEnvSchema(buildRoot: string, log?: (msg: string) => void): EnvSchema | null {
  for (const file of CANDIDATE_FILES) {
    const full = path.join(buildRoot, file);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      log?.(`note: ${file} is ${stat.size} bytes — too large to parse, skipping the environment check`);
      return null;
    }
    return parseEnvExample(fs.readFileSync(full, 'utf8'), file);
  }
  return null;
}

interface Occurrence {
  key: string;
  value: string;
  commentedOut: boolean;
  description: string | null;
  group: string | null;
}

/** Pure: turns the text of a .env.example into a typed schema. */
export function parseEnvExample(content: string, file: string): EnvSchema {
  const order: string[] = [];
  const byKey = new Map<string, Occurrence[]>();
  let pending: string[] = [];
  let group: string | null = null;

  const record = (key: string, value: string, commentedOut: boolean, inlineComment: string | null) => {
    const description = joinDescription([...pending, ...(inlineComment ? [inlineComment] : [])]);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push({ key, value, commentedOut, description, group });
    pending = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();

    if (t === '') {
      // a comment block separated from a key by a blank line is not its description
      pending = [];
      continue;
    }

    if (t.startsWith('#') && (/^#\s*[-=*#_]{2,}/.test(t) || /[-=*#_]{3,}\s*$/.test(t))) {
      const heading = t.replace(/^#+/, '').replace(/^[-=*#_\s]+/, '').replace(/[-=*#_\s]+$/, '');
      if (heading !== '') group = heading;
      pending = [];
      continue;
    }

    const commented = t.match(COMMENTED_ASSIGN_RE);
    if (commented) {
      const { value, inlineComment } = extractValue(commented[2]);
      record(commented[1], value, true, inlineComment);
      continue;
    }

    if (t.startsWith('#')) {
      pending.push(t.replace(/^#\s?/, ''));
      continue;
    }

    const assign = t.match(ASSIGN_RE);
    if (assign) {
      const { value, inlineComment } = extractValue(assign[2]);
      record(assign[1], value, false, inlineComment);
      continue;
    }

    pending = [];
  }

  const vars: EnvVarSpec[] = [];
  for (const key of order) {
    const occs = byKey.get(key)!;
    // the real assignment always beats a commented-out one for the same key
    const pool = occs.filter((o) => !o.commentedOut);
    const winner = (pool.length ? pool : occs).at(-1)!;
    const description = occs.find((o) => o.description != null)?.description ?? null;
    const varGroup = occs.find((o) => o.group != null)?.group ?? null;
    const hint = [description, winner.description].filter(Boolean).join(' ');
    const placeholder = isPlaceholder(winner.value, key);
    vars.push({
      key,
      required: decideRequired(key, winner.commentedOut, hint, placeholder),
      description,
      example: placeholder ? null : winner.value,
      secret: SECRET_RE.test(key),
      group: varGroup,
      commentedOut: winner.commentedOut,
    });
  }

  return { file, detectedAt: new Date().toISOString(), commitSha: null, vars: vars.slice(0, MAX_VARS) };
}

export function missingRequiredKeys(schema: EnvSchema, provided: Set<string>): string[] {
  return schema.vars.filter((v) => v.required && !provided.has(v.key)).map((v) => v.key);
}

function joinDescription(parts: string[]): string | null {
  const joined = parts.join(' ').trim();
  return joined === '' ? null : joined.slice(0, MAX_DESCRIPTION);
}

/**
 * Split the right-hand side into the declared value and any trailing comment.
 * The comment becomes part of that key's description — `FOO=  # required` is a
 * very common way of saying "you must fill this in".
 */
function extractValue(rhs: string): { value: string; inlineComment: string | null } {
  const v = rhs.trim();
  if (v === '') return { value: '', inlineComment: null };

  if (v.startsWith('#')) return { value: '', inlineComment: v.replace(/^#\s?/, '').trim() || null };

  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const end = v.indexOf(quote, 1);
    if (end < 0) return { value: v.slice(1), inlineComment: null };
    // `FOO="" # optional` is common — the marker after the closing quote decides
    // whether the key is required, so it must not be discarded with the quotes.
    const trailing = v.slice(end + 1).match(/#\s?(.*)$/);
    return { value: v.slice(1, end), inlineComment: trailing?.[1].trim() || null };
  }

  const cut = v.search(/\s#/);
  if (cut >= 0) return { value: v.slice(0, cut).trim(), inlineComment: v.slice(cut + 2).trim() || null };
  return { value: v, inlineComment: null };
}

/**
 * A false "required" costs the user one form field; a false "optional" costs
 * them a crashed deploy — so ambiguity resolves to required.
 */
function decideRequired(key: string, commentedOut: boolean, hint: string, placeholder: boolean): boolean {
  if (NEVER_REQUIRED.includes(key)) return false;
  if (commentedOut) return false;
  if (/\(?\boptional\b\)?/i.test(hint) || /\bnot required\b/i.test(hint)) return false;
  if (/\(?\brequired\b\)?/i.test(hint) || /\bmust be set\b/i.test(hint)) return true;
  return placeholder;
}

function isPlaceholder(value: string, key: string): boolean {
  if (value === '') return true;
  const n = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (PLACEHOLDER_EXACT.has(n)) return true;
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(value))) return true;
  return n !== '' && n === key.toLowerCase().replace(/[^a-z0-9]/g, '');
}
