import { config } from '../config.js';
import type { ResolvedConfig } from '../types.js';

/**
 * Traefik integration is entirely label-driven: routers/services are named per
 * APP (not per deployment), so during a blue-green overlap the old and new
 * containers merge into one Traefik service and get load-balanced until the
 * old one is removed.
 */
export function traefikLabels(appName: string, deploymentId: number, cfg: ResolvedConfig): string[] {
  const labels = ['deployer.managed=true', `deployer.app=${appName}`, `deployer.deployment=${deploymentId}`];
  if (cfg.type === 'worker' || !cfg.domainHost) return labels;

  const r = `dep-${appName}`;
  labels.push(
    'traefik.enable=true',
    `traefik.docker.network=${config.dockerNetwork}`,
    `traefik.http.routers.${r}.rule=Host(\`${cfg.domainHost}\`)`,
    `traefik.http.routers.${r}.service=${r}`,
    `traefik.http.services.${r}.loadbalancer.server.port=${cfg.containerPort}`
  );
  if (config.sslMode === 'none') {
    labels.push(`traefik.http.routers.${r}.entrypoints=web`);
  } else {
    labels.push(`traefik.http.routers.${r}.entrypoints=websecure`, `traefik.http.routers.${r}.tls.certresolver=le`);
  }
  if (cfg.healthPath) {
    labels.push(
      `traefik.http.services.${r}.loadbalancer.healthcheck.path=${cfg.healthPath}`,
      `traefik.http.services.${r}.loadbalancer.healthcheck.interval=5s`,
      `traefik.http.services.${r}.loadbalancer.healthcheck.timeout=3s`
    );
  }
  return labels;
}
