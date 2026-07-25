import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { exec } from './exec.js';

export interface CloneResult {
  sha: string;
  message: string;
}

/**
 * Tokens are delivered to git via GIT_ASKPASS + an env var — never on the
 * command line (visible in `ps`) and never embedded in the remote URL
 * (visible in logs and .git/config).
 */
function ensureAskpassScript(): string {
  const dir = paths.tmp();
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const file = path.join(dir, 'askpass.bat');
    fs.writeFileSync(file, '@echo off\r\necho(%DEPLOYER_GIT_TOKEN%\r\n');
    return file;
  }
  const file = path.join(dir, 'askpass.sh');
  fs.writeFileSync(
    file,
    '#!/bin/sh\ncase "$1" in\n  *sername*) echo "${DEPLOYER_GIT_USERNAME:-x-access-token}" ;;\n  *) echo "$DEPLOYER_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o755 }
  );
  return file;
}

export async function cloneRepo(opts: {
  url: string;
  branch: string;
  dest: string;
  token?: string | null;
  deploymentId: number;
  log: (line: string) => void;
}): Promise<CloneResult> {
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });

  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (opts.token) {
    env.GIT_ASKPASS = ensureAskpassScript();
    env.DEPLOYER_GIT_TOKEN = opts.token;
  }

  const args = ['clone', '--depth', '1', '--single-branch'];
  if (opts.branch) args.push('--branch', opts.branch);
  args.push('--', opts.url, opts.dest);

  const res = await exec('git', args, {
    env,
    timeoutMs: config.cloneTimeoutMs,
    deploymentId: opts.deploymentId,
    onLine: (l) => opts.log(l),
  });
  if (res.timedOut) throw new Error('git clone timed out');
  if (res.code !== 0) {
    const detail = res.stderr.trim().split('\n').slice(-3).join(' | ');
    if (/Authentication failed|could not read Username|403|401/i.test(res.stderr)) {
      throw new Error(
        `git clone failed — authentication. For private repos, add a personal access token in the app settings. (${detail})`
      );
    }
    if (/not found|Could not resolve host|repository .* does not exist/i.test(res.stderr)) {
      throw new Error(`git clone failed — repo not found or unreachable: ${detail}`);
    }
    throw new Error(`git clone failed: ${detail}`);
  }

  const head = await exec('git', ['-C', opts.dest, 'log', '-1', '--format=%H%x1f%s'], { deploymentId: opts.deploymentId });
  if (head.code !== 0) throw new Error(`could not read HEAD commit: ${head.stderr.trim()}`);
  const [sha = '', message = ''] = head.stdout.trim().split('\x1f');
  return { sha, message };
}
