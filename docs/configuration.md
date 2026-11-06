# Configuration

There are two layers of configuration:

1. **Environment variables** in `.env`, read by Docker Compose. These cover secrets, the bootstrap admin, the port and defaults. Changes need `docker compose up -d`.
2. **In-app settings**, stored in PostgreSQL and changed by administrators in the UI. These take effect immediately.

## Environment variables

| Variable | Default | Required | Used by | Description |
|---|---|---|---|---|
| `HTTP_PORT` | `8080` | no | web | Host port published by nginx |
| `ADMIN_USERNAME` | `admin` | no | api | Username of the first administrator (created only when no users exist) |
| `ADMIN_PASSWORD` | – | **yes** | api | Password of the first administrator, 12+ characters. Ignored after the first start |
| `SESSION_SECRET` | – | **yes** | api, worker | 32+ character secret used to HMAC session tokens. Changing it signs everyone out |
| `DATA_ENCRYPTION_KEY` | – | **yes** | api, worker | Secret from which the key that encrypts Datadog API/app keys at rest is derived. Changing it makes stored keys unreadable (re-enter them in the UI) |
| `POSTGRES_PASSWORD` | – | **yes** | db, api, worker | Database password. Only applied when the database volume is first created |
| `COOKIE_SECURE` | `false` | no | api | `true` sets the `Secure` flag on cookies. Required behind HTTPS |
| `DEMO_DATA` | `true` | no | api | Seed synthetic DEMO inventory at start-up when the database has none (and no real Datadog data exists while auto-purge is on) |
| `DATADOG_SITE` | `datadoghq.com` | no | api, worker | Default site until one is saved in the UI. One of `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `ddog-gov.com` |
| `DATADOG_ORG` | `default` | no | api | Initial organization label shown in the header (editable in the UI) |
| `DATADOG_API_KEY` | empty | no | api, worker | If set together with `DATADOG_APP_KEY`, overrides the keys stored in the UI, and the UI shows them as read-only |
| `DATADOG_APP_KEY` | empty | no | api, worker | Application key paired with `DATADOG_API_KEY` |
| `TAG_ENFORCER_URL` | empty | no | api, worker | Tag Enforcer base URL **as the containers reach it**, e.g. `http://host.docker.internal:8087` on the same machine or `http://tag-enforcer:8080` on a shared Docker network. With `TAG_ENFORCER_TOKEN`, turns on the [integration](tag-enforcer.md#connecting-the-two-apps) |
| `TAG_ENFORCER_TOKEN` | empty | no | api, worker | Tag Enforcer's `TE_API_TOKEN` (`TAG_ENFORCER_TOKEN_FILE` also works) |
| `TAG_ENFORCER_PUBLIC_URL` | `TAG_ENFORCER_URL` | no | api | Tag Enforcer URL **as your browser reaches it**, e.g. `http://localhost:8087`, for *Open in Tag Enforcer* links |
| `HISTORY_ARCHIVE_PATH` | Docker volume `history_archive` | no | api, worker | Where change-history archives are written (mounted at `/archive`). Set it to a host folder (e.g. `./archive`) to get the files directly on the host. On Linux, the folder must be writable by UID 10001: `mkdir -p ./archive && sudo chown 10001:10001 ./archive` |

Variables set inside `compose.yaml` that you normally don't change:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://search:${POSTGRES_PASSWORD}@db:5432/search` | Point it at an external PostgreSQL 14+ with the `pg_trgm` extension available |
| `REDIS_URL` | `redis://redis:6379/0` | Point it at an external Redis 6+ |

### Docker secrets / files

Every secret can be supplied as a file instead of a value by appending `_FILE`: `SESSION_SECRET_FILE`, `DATA_ENCRYPTION_KEY_FILE`,
`ADMIN_PASSWORD_FILE`, `DATADOG_API_KEY_FILE`, `DATADOG_APP_KEY_FILE` or `DATABASE_URL_FILE`. The file's contents are used, which works with Docker or
Kubernetes secrets mounted as files.

## In-app settings (Admin › Settings)

| Setting | Default | Range | Effect |
|---|---|---|---|
| Session lifetime (hours) | 8 | 1–72 | How long a sign-in lasts. Applies to new sessions |
| Viewers may export data | off | on/off | Gives the Viewer role the `export` permission (CSV/JSON) |
| Remove DEMO data automatically once real Datadog data has synced | on | on/off | After a sync that collected real records, DEMO resources and their sample history are deleted, and they are not re-seeded on restart |
| Required tag keys | `env, app, costcenter` | comma-separated keys | Used by **Reports › Missing required tags** |
| Mark infrastructure stale after (hours) | 24 | 1–2160 | Hosts, devices, VMware and cloud records not observed for longer are flagged stale (amber “Last Seen”) and listed in **Reports › Stale inventory** |
| Keep change history (days) | 365 | 1–36500, or **Keep forever** | Change-history entries for everything except containers and pods older than this roll off (hourly, or with **Purge now**) |
| Record changes for containers and pods | on | on/off | Off = no history entries at all for Container and Pod (stops tracking deploy churn) |
| Keep container and pod change history (days) | 14 | 1–36500, or **Keep forever** | Shorter window for the fastest-growing part of the history |
| Archive entries to a gzip CSV file before they roll off | off | on/off | Each roll-off first writes the expiring entries to `change-history-<UTC timestamp>-<schedule\|manual>.csv.gz` in the archive folder. If the folder isn't writable, the roll-off is skipped and nothing is deleted |
| Audit log and search history retention (days) | 365 | 7–3650 | Audit events and search history older than this are deleted hourly by the worker |

## Datadog connection (Admin › Datadog Config)

| Field | Notes |
|---|---|
| Organization label | Display name shown in the header (`org: …`) |
| Datadog site | Must match your organization. It determines the API base `https://api.<site>` and the deep-link host (`app.datadoghq.com`, `us3.datadoghq.com`, `app.ddog-gov.com`, …) |
| API key / Application key | Write-only fields. The current values are shown masked (last 4 characters). Leave blank to keep the existing key |
| Scheduled sync enabled | When on, the worker queues a sync every *interval* minutes after the previous one was queued |
| Sync interval (minutes) | 5–1440, default 15 |
| Data sources | Toggle each collector on or off (saved immediately). Disabling a source deletes its records at the next sync. See [datadog-sources.md](datadog-sources.md) |

## Theme (per browser)

Each user picks **Dark**, **Light** or **Match system** from the user menu, or clicks the sun/moon button in the header.
The choice is stored in the browser's `localStorage` (`dde-theme`) and applied before the page renders.

## Files you may customise

| File | What you might change |
|---|---|
| `compose.yaml` | Resource limits, published port binding (e.g. `127.0.0.1:8080:8080`), external DB/Redis |
| `web/nginx.conf` | Security headers, CSP, body size, timeouts |
| `api/app/datadog.py` → `AWS_METRICS` | Which AWS services are discovered and by which metric and tag |
| `api/app/datadog.py` → `DB_METRICS` | Which database engines are discovered and by which metric and tags |
| `api/app/datadog.py` → `ALIAS_TAG_KEYS` | Which tag keys are copied into host aliases |
| `api/app/inventory.py` → `HIGH_CARDINALITY_TAG_KEYS` | Tag keys that are never promoted to Tag entities |
| `web/src/components/MeshMountain.tsx` → `PEAKS` | The animated header mountain |

Rebuild after editing: `docker compose up -d --build`.
