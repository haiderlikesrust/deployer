import path from 'node:path';

export type SslMode = 'letsencrypt' | 'letsencrypt-staging' | 'none';

const env = process.env;

export const config = {
  /** All persistent state lives under here: sqlite db, build workspaces, logs, tmp. */
  dataDir: env.DATA_DIR ?? (process.platform === 'win32' ? path.resolve('data') : '/data'),
  port: parseInt(env.PORT ?? '3000', 10),
  host: env.HOST ?? '0.0.0.0',
  /** Apps get <name>.<baseDomain>; the dashboard itself is deploy.<baseDomain>. */
  baseDomain: env.BASE_DOMAIN ?? 'localhost',
  sslMode: (env.SSL_MODE ?? 'none') as SslMode,
  /**
   * Scheme used in the URLs we show/link. Normally implied by sslMode, but when
   * running behind someone else's TLS terminator (nginx fallback) the deployer
   * speaks plain HTTP while the browser speaks HTTPS.
   */
  publicScheme: (env.PUBLIC_SCHEME ?? ((env.SSL_MODE ?? 'none') === 'none' ? 'http' : 'https')) as 'http' | 'https',
  /** Consumed once on first boot to seed the admin password hash. */
  adminPasswordBootstrap: env.ADMIN_PASSWORD,
  /** Docker network shared by traefik, the deployer, and all app containers. */
  dockerNetwork: env.DOCKER_NETWORK ?? 'deployer',
  /**
   * How health probes reach app containers. 'direct' = plain HTTP from this
   * process (works when the deployer runs on the same docker network).
   * 'docker' = via a disposable busybox container (needed when the server runs
   * on a Windows/macOS host where container IPs aren't routable).
   */
  probeMode: (env.PROBE_MODE ?? (process.platform === 'win32' || process.platform === 'darwin' ? 'docker' : 'direct')) as 'direct' | 'docker',
  buildTimeoutMs: parseInt(env.BUILD_TIMEOUT_MS ?? String(20 * 60 * 1000), 10),
  cloneTimeoutMs: parseInt(env.CLONE_TIMEOUT_MS ?? String(5 * 60 * 1000), 10),
  /** Images kept per app (beyond the active one) for future rollback. */
  imageRetention: parseInt(env.IMAGE_RETENTION ?? '3', 10),
  /** Fail a deploy before building when free disk falls below this. */
  minFreeDiskBytes: parseInt(env.MIN_FREE_DISK_BYTES ?? String(1024 * 1024 * 1024), 10),
  isProd: env.NODE_ENV === 'production',
};

export const paths = {
  db: () => path.join(config.dataDir, 'deployer.db'),
  logs: () => path.join(config.dataDir, 'logs'),
  deployLog: (deploymentId: number) => path.join(config.dataDir, 'logs', `deploy-${deploymentId}.log`),
  builds: () => path.join(config.dataDir, 'builds'),
  buildDir: (appName: string, deploymentId: number) => path.join(config.dataDir, 'builds', appName, String(deploymentId)),
  tmp: () => path.join(config.dataDir, 'tmp'),
};

/** Host an app is served on: custom domain if set, else <name>.<baseDomain>. */
export function appHost(appName: string, customDomain: string | null): string {
  return customDomain && customDomain.trim() !== '' ? customDomain.trim().toLowerCase() : `${appName}.${config.baseDomain}`;
}

export function appUrl(appName: string, customDomain: string | null): string {
  return `${config.publicScheme}://${appHost(appName, customDomain)}`;
}
