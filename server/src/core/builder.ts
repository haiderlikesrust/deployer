import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { docker, imageTag } from './docker.js';
import { appendLog } from './buildlogs.js';
import type { ResolvedConfig } from '../types.js';

const GENERATED_DOCKERFILE_PATH = '.deployer/Dockerfile';

export async function buildImage(opts: {
  appName: string;
  deploymentId: number;
  cfg: ResolvedConfig;
  generatedDockerfile: string | null;
  extraContextFiles: { relPath: string; content: string }[];
  contextDir: string;
}): Promise<string> {
  const { appName, deploymentId, cfg, contextDir } = opts;
  const tag = imageTag(appName, deploymentId);

  let dockerfileArg: string;
  if (opts.generatedDockerfile) {
    dockerfileArg = GENERATED_DOCKERFILE_PATH;
    fs.mkdirSync(path.join(contextDir, '.deployer'), { recursive: true });
    fs.writeFileSync(path.join(contextDir, GENERATED_DOCKERFILE_PATH), opts.generatedDockerfile);
    for (const f of opts.extraContextFiles) {
      fs.mkdirSync(path.dirname(path.join(contextDir, f.relPath)), { recursive: true });
      fs.writeFileSync(path.join(contextDir, f.relPath), f.content);
    }
    // keep the build context lean when the repo doesn't manage its own ignore file
    if (!fs.existsSync(path.join(contextDir, '.dockerignore'))) {
      fs.writeFileSync(path.join(contextDir, '.dockerignore'), '.git\nnode_modules\n');
    }
    appendLog(deploymentId, 'Generated Dockerfile:');
    appendLog(deploymentId, '────────────────────────────────────────');
    appendLog(deploymentId, opts.generatedDockerfile.trimEnd());
    appendLog(deploymentId, '────────────────────────────────────────');
  } else {
    dockerfileArg = cfg.dockerfilePath ?? 'Dockerfile';
    appendLog(deploymentId, `Building with the repository's ${dockerfileArg}`);
  }

  const build = (buildkit: boolean) =>
    docker(['build', '--tag', tag, '--file', dockerfileArg, '.'], {
      cwd: contextDir,
      env: { DOCKER_BUILDKIT: buildkit ? '1' : '0' },
      timeoutMs: config.buildTimeoutMs,
      deploymentId,
      onLine: (l) => appendLog(deploymentId, l),
    });

  let res = await build(true);
  // Some hosts have BuildKit enabled but no usable buildx plugin. Rather than
  // failing every deploy, fall back to the classic builder once.
  if (res.code !== 0 && /buildx component is missing|BuildKit is enabled but/i.test(res.stderr + res.stdout)) {
    appendLog(deploymentId, 'buildx unavailable — retrying with the classic builder');
    res = await build(false);
  }
  if (res.timedOut) throw new Error(`docker build timed out after ${Math.round(config.buildTimeoutMs / 60000)} minutes`);
  if (res.code !== 0) throw new Error('docker build failed — see the build log above for the compiler/installer error');
  return tag;
}
