import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { registerChild, unregisterChild } from './children.js';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Registers the child so a deployment cancel can kill it. */
  deploymentId?: number;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 2 * 1024 * 1024; // cap in-memory capture; full output goes through onLine

/**
 * Spawn a process with an args array (never a shell — no quoting bugs),
 * stream lines to onLine, capture bounded stdout/stderr.
 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (opts.deploymentId != null) registerChild(opts.deploymentId, child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 5000).unref();
      }, opts.timeoutMs);
    }

    readline.createInterface({ input: child.stdout! }).on('line', (l) => {
      if (stdout.length < MAX_CAPTURE) stdout += l + '\n';
      opts.onLine?.(l, 'stdout');
    });
    readline.createInterface({ input: child.stderr! }).on('line', (l) => {
      if (stderr.length < MAX_CAPTURE) stderr += l + '\n';
      opts.onLine?.(l, 'stderr');
    });

    const done = (fn: () => void) => {
      if (timer) clearTimeout(timer);
      if (opts.deploymentId != null) unregisterChild(opts.deploymentId, child);
      fn();
    };
    child.on('error', (err) => done(() => reject(err)));
    child.on('close', (code) => done(() => resolve({ code: code ?? -1, stdout, stderr, timedOut })));
  });
}
