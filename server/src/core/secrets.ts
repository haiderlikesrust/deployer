/**
 * Registry of secret values (git tokens) that must never appear in any
 * build log, error message, or SSE stream. Every log-emission point runs
 * lines through scrub().
 */
const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined) {
  if (value && value.length >= 6) secrets.add(value);
}

export function forgetSecret(value: string | null | undefined) {
  if (value) secrets.delete(value);
}

export function scrub(line: string): string {
  for (const s of secrets) {
    if (line.includes(s)) line = line.split(s).join('[redacted]');
  }
  return line;
}
