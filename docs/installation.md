# Installation

This guide takes you from an empty machine to a running Datadog Discovery Engine, then covers TLS, upgrades and removal.

- [Requirements](#requirements)
- [1. Get the code](#1-get-the-code)
- [2. Create the environment file](#2-create-the-environment-file)
- [3. Build and start](#3-build-and-start)
- [4. First sign-in](#4-first-sign-in)
- [5. Connect Datadog](#5-connect-datadog)
- [TLS / reverse proxy](#tls--reverse-proxy)
- [Changing the port](#changing-the-port)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)
- [Installation troubleshooting](#installation-troubleshooting)

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Docker | Engine 24+ with Compose v2 (`docker compose`) | latest stable |
| CPU | 2 vCPU | 4 vCPU |
| Memory | 1.5 GB free | 4 GB |
| Disk | 2 GB (images) + database growth | 10 GB |
| Network | Outbound HTTPS to `api.<your-datadog-site>` from the worker and api containers | |
| Browser | Current Chrome, Edge, Firefox or Safari | |

Container resource limits are set in `compose.yaml`: web 0.5 CPU / 128 MB, api 1 CPU / 512 MB, worker 1 CPU / 512 MB,
db 1 CPU / 512 MB, redis 0.25 CPU / 192 MB. Raise them for very large estates (more than about 50k resources).

Docker Desktop (macOS / Windows), Docker Engine on Linux and Podman with docker-compose compatibility all work.
Building on Apple Silicon or ARM servers produces native ARM images.

## 1. Get the code

Copy the `datadog-search` folder to the host, or clone your repository, and `cd` into it:

```bash
cd datadog-search
```

## 2. Create the environment file

The helper script copies `.env.example` to `.env` and fills in random secrets:

```bash
./scripts/init-env.sh
```

It generates `ADMIN_PASSWORD` (24 hex characters), `SESSION_SECRET` and `DATA_ENCRYPTION_KEY` (64 hex characters each) and
`POSTGRES_PASSWORD`. It sets the file mode to `600` and refuses to overwrite an existing `.env`.

To create it by hand instead:

```bash
cp .env.example .env
openssl rand -hex 32   # use for SESSION_SECRET
openssl rand -hex 32   # use for DATA_ENCRYPTION_KEY
openssl rand -hex 16   # use for POSTGRES_PASSWORD
```

and edit `.env`. Every variable is described in [configuration.md](configuration.md).

> **Keep `.env` safe and backed up.** `DATA_ENCRYPTION_KEY` decrypts the Datadog keys stored in the database. If you lose it, you
> must re-enter the keys in the UI. Never commit `.env` (it is listed in `.gitignore`).

## 3. Build and start

```bash
docker compose up -d --build
```

The first build downloads base images and dependencies and takes 2–4 minutes. Compose starts the services in dependency order:

1. `db` (PostgreSQL) and `redis` start, and their health checks pass.
2. `api` starts, waits for the database, applies schema migrations, creates the first administrator and seeds demo data.
3. `worker` starts once the api is healthy.
4. `web` (nginx) starts once the api is healthy and publishes port `8080`.

Check the status:

```bash
docker compose ps
```

All services except the worker (which has no health check) should show `healthy`. To watch start-up:

```bash
docker compose logs -f api worker
```

Expected log lines include `applying migration 001_init.sql`, `created initial administrator 'admin'`, `seeded N DEMO records`
and `worker started`.

## 4. First sign-in

Open **http://localhost:8080** (or `http://<server>:8080`) and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`:

```bash
grep -E '^ADMIN_(USERNAME|PASSWORD)=' .env
```

Next steps:

1. Change the password: user menu (top right) › **Account & password**.
2. Create named accounts for your team: **Admin › Users**.
3. Explore the DEMO data: try the quick searches on Home, open a resource, look at **What Changed** and **Reports**.

> The first administrator is created **only** when the users table is empty. Changing `ADMIN_PASSWORD` later has no effect;
> use the Account page or **Admin › Users › Reset password** instead.

## 5. Connect Datadog

See [admin-guide.md › Datadog configuration](admin-guide.md#datadog-configuration) for the full procedure and
[datadog-sources.md](datadog-sources.md#permissions) for the key scopes. In short:

1. **Admin › Datadog Config** › choose your **Datadog site** › paste an **API key** and an **application key** › **Save configuration**.
2. **Test connection** should report both keys as valid.
3. **Sync now**. The **Sync jobs** table shows progress, and **Data sources & freshness** shows per-source results.
4. Turn on **Scheduled sync** to keep the inventory fresh (default every 15 minutes).

After the first successful sync with real data, the DEMO records are removed automatically. You can change this in **Admin › Settings**.

## 6. Optional: connect Tag Enforcer

If you also run [Tag Enforcer](https://github.com/rc01820/Datadog_Tag_Enforcer), Discovery can import its tag-policy verdicts
and show **monitor blind spots**. It needs three lines in `.env` (`TAG_ENFORCER_URL`, `TAG_ENFORCER_TOKEN`,
`TAG_ENFORCER_PUBLIC_URL`) and a matching `TE_API_TOKEN` on Tag Enforcer's side. Both apps default to port 8080, so run
Tag Enforcer on another port (`TE_HTTP_PORT=8087`). Step by step, with the same-machine, shared-network and separate-host
variants: [tag-enforcer.md › Connecting the two apps](tag-enforcer.md#connecting-the-two-apps).

## TLS / reverse proxy

The bundled nginx serves plain HTTP on port 8080. For any shared deployment, terminate TLS in front of it and set:

```dotenv
COOKIE_SECURE=true
```

then `docker compose up -d` so the session cookies are only sent over HTTPS.

The proxy must:

- forward to `http://<host>:8080`;
- set `X-Real-IP` to the client address. The inner nginx (`web/nginx.conf`) sends `X-Real-IP $remote_addr` to the api, which uses it
  for login throttling and the audit log. Behind an outer proxy, `$remote_addr` is the proxy's address. To record real client IPs, add
  `set_real_ip_from <proxy-ip>; real_ip_header X-Real-IP;` to the `server` block in `web/nginx.conf` so the inner nginx trusts that
  proxy only, then rebuild the web image;
- allow request bodies of at least 1 MB.

**Caddy** (automatic Let's Encrypt certificates):

```caddyfile
search.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name search.example.com;
    ssl_certificate     /etc/ssl/certs/search.crt;
    ssl_certificate_key /etc/ssl/private/search.key;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

When a proxy runs on the same host, publish the app on localhost only, so it cannot be reached directly. In `compose.yaml`:

```yaml
    ports:
      - "127.0.0.1:${HTTP_PORT:-8080}:8080"
```

## Changing the port

Set `HTTP_PORT` in `.env` (for example `HTTP_PORT=9090`) and run `docker compose up -d`. Only the web container publishes a
port; api, worker, db and redis are reachable only on the internal Compose network.

If Tag Enforcer links here, update its `TE_DISCOVERY_URL` to the new port too.

## Upgrading

```bash
./scripts/backup.sh              # always back up first
git pull                         # or copy the new release over the folder (keep your .env)
docker compose up -d --build     # rebuild images and restart
docker compose logs api | grep -i migration
```

Schema migrations in `api/app/migrations/` run automatically when the api starts. They are applied exactly once, in order,
under a PostgreSQL advisory lock, so running several api workers is safe. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading.

To roll back, restore the backup taken before the upgrade and start the previous release. See [operations.md](operations.md#restore).

## Uninstalling

```bash
docker compose down            # stop and remove containers; keeps data volumes
docker compose down -v         # ALSO deletes the database, redis and history-archive volumes (irreversible)
docker image rm datadog-search-web:1.4.0 datadog-search-api:1.4.0
```

## Installation troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Set POSTGRES_PASSWORD in .env` (or another variable) | `.env` missing or incomplete | Run `./scripts/init-env.sh`, or fill in the variable |
| api restarts with `SESSION_SECRET must be at least 32 characters` | Secret too short | Use `openssl rand -hex 32` |
| api restarts with `ADMIN_PASSWORD must be at least 12 characters` | First start with a short password | Set a 12+ character password and run `docker compose up -d` |
| `port is already allocated` | 8080 already in use | Set `HTTP_PORT` to a free port |
| web stays `starting`, browser shows 502 | api not healthy yet | `docker compose logs api` and wait for migrations to finish |
| Sign-in says “Too many failed sign-in attempts” | Throttling (5 failures per username, or 20 per IP, within 5 minutes) | Wait 5 minutes |
| Changed the database password in `.env` and now the api can't connect | PostgreSQL keeps the password it was created with | Change it with `ALTER USER search PASSWORD '…'`, or recreate the volume (data loss) |

More in [operations.md › Troubleshooting](operations.md#troubleshooting).
