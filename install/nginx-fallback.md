# Running deployer behind an existing nginx

If your VPS already serves sites with nginx on ports 80/443, install with:

```bash
sudo bash install.sh --mode behind-nginx --base-domain example.com
```

In this mode Traefik binds only `127.0.0.1:8081` and terminates plain HTTP.
Your nginx keeps 80/443 and TLS, and forwards every deployer host with **one**
server block — you never touch nginx again when adding apps:

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name deploy.example.com *.example.com;

    # your existing certbot/TLS config:
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;              # REQUIRED — Traefik routes on Host
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / streaming endpoints need buffering off
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_http_version 1.1;
    }
}
```

Notes:

- You need a **wildcard certificate** for `*.example.com` on the nginx side
  (certbot with a DNS plugin), or list each app subdomain explicitly.
- `proxy_set_header Host $host` is what makes routing work — Traefik picks the
  app container by hostname.
- New apps require **zero** nginx changes: any `*.example.com` host reaching
  Traefik is routed by its labels.
- If nginx ever moves off this box, re-run the installer without
  `--mode behind-nginx` to let Traefik own 80/443 directly.
