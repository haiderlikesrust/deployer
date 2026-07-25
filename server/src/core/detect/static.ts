import fs from 'node:fs';
import path from 'node:path';

export function hasRootIndexHtml(repoDir: string): boolean {
  return fs.existsSync(path.join(repoDir, 'index.html'));
}

export function staticDockerfile(): string {
  return [
    'FROM nginx:1.27-alpine',
    'COPY .deployer/nginx.conf /etc/nginx/conf.d/default.conf',
    'COPY . /usr/share/nginx/html',
    'RUN rm -rf /usr/share/nginx/html/.deployer',
    'EXPOSE 80',
    '',
  ].join('\n');
}

/** nginx config with SPA fallback — right for SPAs, harmless for plain sites. */
export const NGINX_CONF = `server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }
}
`;
