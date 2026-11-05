# Datadog Discovery Engine

**One search box for everything in your Datadog estate.** Find any host, network device, interface, monitor, container,
pod, cluster, AWS resource, service, synthetic test, dashboard or tag by name, IP, CIDR range, AWS instance ID, MAC
address, tag, status or regular expression. See how it relates to everything else, and when it changed or disappeared.

Datadog Discovery Engine is a self-hosted Docker application for NOC shifts, infrastructure operators and administrators.
It indexes your Datadog inventory on a schedule, adds a query language built for operations work, and keeps a change
history that Datadog itself does not keep.

> Project / container name: `datadog-search` · Version 1.3.0 · Default Datadog site: US1 (`datadoghq.com`)

---

## Contents

- [Highlights](#highlights)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [Connecting Datadog](#connecting-datadog)
- [Search in 60 seconds](#search-in-60-seconds)
- [Architecture at a glance](#architecture-at-a-glance)
- [Feature tour](#feature-tour)
- [Documentation](#documentation)
- [Project layout](#project-layout)
- [Common commands](#common-commands)
- [Security notes](#security-notes)
- [Limitations & roadmap](#limitations--roadmap)

---

## Highlights

| Area | What you get |
|---|---|
| **Search** | Free text, `field:value`, wildcards, exact match, CIDR ranges, regex, `AND`/`OR`/`NOT`/parentheses, `has:`/`missing:`, autocomplete, sub-30 ms results |
| **Coverage** | Hosts, VMware, cloud hosts, network devices & interfaces, monitors, containers, pods, clusters, 15 AWS service types, APM services, synthetics, dashboards, tags |
| **Bulk lookup** | Paste up to 2,000 IPs, hostnames, FQDNs, instance IDs, MACs, container IDs or CIDR ranges. You get a found / multiple / not found / previously-seen table, can copy the misses and export CSV |
| **Aliases** | AWS instance IDs, EC2/RDS DNS names, AWS Name tags, container IDs, MAC addresses and interface descriptions are all searchable |
| **Correlation** | Monitors scoped to a host, containers on a host, pods in a cluster, interfaces of a device, shared app tags, IP collisions, each shown with evidence |
| **Efficient at scale** | Syncs only rewrite records whose content changed (fingerprints, heap-only “last seen” updates, relationship diffs), and container and pod history has its own short retention. A 500k-resource estate fits in about 15–25 GB. See [capacity planning](docs/operations.md#capacity-planning) |
| **Change history** | Retention you control (separate for containers and pods, or keep forever), **Purge now** with a preview, optional gzip CSV **archive before roll-off**, and a usage panel. Every sync is compared with the last one: added, removed, status, tag, IP and alias changes, and renames. A **What Changed** view, a timeline per resource, and answers to “when did this disappear?” |
| **Reports** | Alerting resources, duplicate IPs, missing required tags, stale inventory, infrastructure without monitors, agent version drift |
| **Operations UX** | Resource inspector (overview, monitors, related, metrics, logs, history), deep links into Datadog, saved and shared searches, favorites, history, CSV/JSON export, keyboard shortcuts, dark and light themes, a Help page with 100+ runnable examples |
| **Administration** | Users and roles (Administrator / Operator / Viewer), per-source sync toggles and freshness, scheduled and manual syncs, audit log, system health, demo data |
| **Security** | Argon2id passwords, HttpOnly SameSite=Strict cookies, CSRF tokens, login throttling, CSP, Datadog keys encrypted at rest, non-root read-only containers |

## Quick start (5 minutes)

**Prerequisites:** Docker Engine 24+ with Docker Compose v2, about 1.5 GB of free RAM, and port 8080 free.

```bash
cd datadog-search
./scripts/init-env.sh            # creates .env with random secrets and an admin password
docker compose up -d --build     # builds and starts 5 containers (first build takes 2–4 minutes)
docker compose ps                # wait until api, db, redis and web report "healthy"
```

Open **http://localhost:8080** and sign in. The username and password are `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`:

```bash
grep -E '^ADMIN_(USERNAME|PASSWORD)=' .env
```

On first start the app seeds a synthetic **DEMO** inventory (hosts, devices, Kubernetes, AWS, interfaces, monitors and change
history), so every feature can be explored before Datadog is connected. Demo records carry a `DEMO` badge. They are removed
automatically after the first real Datadog sync.

Full instructions, including TLS, upgrades and uninstalling: **[docs/installation.md](docs/installation.md)**.

## Connecting Datadog

1. Create a **read-only** API key and application key in Datadog (Organization Settings › API / Application Keys).
   For the scopes each data source needs, see [docs/datadog-sources.md](docs/datadog-sources.md#permissions).
2. In the app, open **Admin › Datadog Config**. Choose your **site**, paste both keys and click **Save configuration**.
   Keys are encrypted at rest and never sent to the browser.
3. Click **Test connection**, then **Sync now**.
4. Optionally turn on **Scheduled sync** (every 5–1440 minutes, default 15).
5. In **Data sources & freshness**, choose which sources to collect: Hosts, Monitors, Network devices, Device
   interfaces, Containers/pods/clusters, Services, Synthetics, Dashboards, AWS services and Tags. The table shows record counts per
   resource type, last success and attempt, and any error category for each source.

Supported sites: US1 `datadoghq.com` (default), US3, US5, EU1 `datadoghq.eu`, AP1, AP2 and US1-FED GovCloud `ddog-gov.com`.
Keys can also be supplied through `DATADOG_API_KEY` / `DATADOG_APP_KEY` in `.env`, in which case the UI shows them as managed by the environment.

## Search in 60 seconds

| I want to… | Search |
|---|---|
| Find the node with IP 10.10.50.21 (exactly) | `ip:"10.10.50.21"` |
| Find everything in a subnet | `10.10.50.0/24` |
| Find a node by AWS instance ID | `i-0a1b2c3d4e5f6g7h8` |
| Find things tagged **app:xyz and costcenter:abc** | `app:xyz costcenter:abc` (or `tag:app:xyz AND tag:costcenter:abc`) |
| Find either tag | `app:xyz OR costcenter:abc` |
| Names starting with `eoc-` | `name:eoc-*` |
| Alerting monitors | `type:monitor status:alert` |
| Prod resources of either app | `(app:xyz OR app:abc) env:prod` |
| Hosts missing a costcenter tag | `type:host missing:costcenter` |
| Exited containers | `type:container status:alert` |
| An interface by MAC | `mac:00:1a:2b:*` |
| Lambda functions | `aws_service:lambda` |
| Check 300 IPs from a ticket | paste them into **Bulk Lookup** |

The complete language reference: **[docs/search-syntax.md](docs/search-syntax.md)**. The in-app **Search Help** page has a live
query tester and more than 100 runnable examples.

## Architecture at a glance

```
             Browser (React + TypeScript SPA)
                         │  HTTP :8080
┌────────────────────────▼────────────────────────┐
│ datadog-search-web     nginx (unprivileged)     │  static UI, /api reverse proxy, CSP & security headers
└────────────────────────┬────────────────────────┘
                         │  /api → api:8000
┌────────────────────────▼────────────────────────┐
│ datadog-search-api     FastAPI (2 workers)      │  auth, RBAC, query parser → SQL, search, correlation,
│                                                 │  change history, reports, admin, live Datadog lookups
└───────┬───────────────────────────┬─────────────┘
        │                           │
┌───────▼─────────┐        ┌────────▼────────┐        ┌──────────────────────────────┐
│ datadog-search- │        │ datadog-search- │◄──────►│ datadog-search-worker        │
│ db  PostgreSQL  │◄──────►│ redis  Redis 7  │  jobs  │ scheduled/manual sync,       │
│ 16 (pg_trgm)    │        │ queue, cache,   │        │ retention, change detection  │
└─────────────────┘        │ throttling      │        └──────────────┬───────────────┘
                           └─────────────────┘                       │ HTTPS (read-only keys)
                                                          Datadog API (your site)
```

Details on data flow, database schema, the sync pipeline, the query compiler and caching: **[docs/architecture.md](docs/architecture.md)**.

## Feature tour

- **Home**: a search box, inventory tiles per type, what's alerting, what changed in the last 24 hours, recent searches, favorites, inventory-health counts.
- **Bulk Lookup**: paste a list from a ticket, spreadsheet or firewall log, or load a `.txt`/`.csv` file. Each item is matched exactly against names,
  aliases, Datadog IDs and IPs (CIDR supported), with optional short-name matching (`web01` ↔ `web01.corp.example.com`). Items that no longer exist are
  checked against the change history. Results can be filtered by outcome, misses copied, matches opened in Search, and everything exported as CSV.
- **Search**: scope chips, faceted filters (type, status, environment, tags), type tiles, sortable and paginated results, bulk select and export,
  and URLs you can share (query, filters, sort, page and selection all live in the URL).
- **Resource inspector**: identifiers, IPs, aliases, tags (click to add to search), freshness (demo / cached / inferred), Datadog deep links,
  quick actions, and tabs for **Monitors**, **Related** (with evidence), **Metrics** (sparklines), **Logs** (last 60 minutes), **History** (timeline) and **Raw**.
- **What Changed**: every change for today, 24 hours, or 7/30/90 days, filterable by kind, type and text, with CSV export.
- **Reports**: six NOC hygiene reports. Every row links back into search.
- **Saved Searches** (private or shared, with templates), **Favorites** (resources and queries), **History** (your recent searches).
- **Search Help**: syntax reference, live query tester and more than 100 runnable examples.
- **Admin**: Users, Roles & permissions, Settings, Datadog Config (sources, freshness, sync jobs, demo data), Audit Log, System Health.
- **Themes**: dark (default), light, or match the system. Use the sun/moon button or the user menu.

A screen-by-screen walkthrough: **[docs/user-guide.md](docs/user-guide.md)**. Administration: **[docs/admin-guide.md](docs/admin-guide.md)**.

## Documentation

| Document | Contents |
|---|---|
| [docs/installation.md](docs/installation.md) | Requirements, first run, TLS / reverse proxy, upgrades, uninstall |
| [docs/configuration.md](docs/configuration.md) | Every environment variable and in-app setting |
| [docs/user-guide.md](docs/user-guide.md) | Using every screen, keyboard shortcuts, exports, themes |
| [docs/search-syntax.md](docs/search-syntax.md) | Complete query language reference with examples |
| [docs/datadog-sources.md](docs/datadog-sources.md) | Each data source: Datadog API, permissions, field mapping, relationships, limits |
| [docs/change-history.md](docs/change-history.md) | How change detection works, baselines, retention, “when did this disappear?” |
| [docs/admin-guide.md](docs/admin-guide.md) | Users, roles, settings, Datadog config, demo data, audit, health |
| [docs/architecture.md](docs/architecture.md) | Containers, data flow, schema, sync pipeline, query compiler, caching |
| [docs/api.md](docs/api.md) | REST API reference with curl examples |
| [docs/security.md](docs/security.md) | Security model and production hardening checklist |
| [docs/operations.md](docs/operations.md) | Backup/restore, logs, monitoring, capacity planning, troubleshooting, FAQ |
| [docs/development.md](docs/development.md) | Local development, tests, adding a data source or a query field |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Project layout

```
datadog-search/
├── compose.yaml            5 services, health checks, resource limits, named volumes
├── .env.example            configuration template (copy via scripts/init-env.sh)
├── api/                    Python 3.12 FastAPI backend + worker (same image)
│   ├── app/
│   │   ├── main.py         app entry, bootstrap (migrations, first admin, demo seed)
│   │   ├── worker.py       sync scheduler/queue consumer, retention
│   │   ├── query.py        query language: tokenizer → AST → parameterised SQL
│   │   ├── datadog.py      Datadog adapter: sites, deep links, retries, collectors
│   │   ├── sync.py         sync job: collect, apply changes only, prune, change tracking
│   │   ├── inventory.py    normalised storage, change tracker, relationships, tags
│   │   ├── security.py     Argon2id, sessions, CSRF, throttling, RBAC, encryption
│   │   ├── demo.py         synthetic demo inventory and history
│   │   ├── routes/         auth, search, bulk, resources, personal, reports, changes, admin
│   │   └── migrations/     numbered SQL migrations (applied automatically)
│   └── tests/              query-language unit tests
├── web/                    React 19 + TypeScript + Vite SPA served by nginx
│   ├── nginx.conf          proxy + security headers + CSP
│   └── src/                pages/, components/, styles.css (dark & light themes)
├── scripts/                init-env.sh, backup.sh, restore.sh
└── docs/                   this documentation set
```

## Common commands

```bash
docker compose ps                                   # container health
docker compose logs -f api worker                   # follow logs
docker compose up -d --build                        # rebuild after changes / upgrade
docker compose exec api python -m pytest -q tests   # run unit tests
./scripts/backup.sh                                 # PostgreSQL dump to ./backups
./scripts/restore.sh backups/<file>.sql.gz          # restore a dump
docker compose down                                 # stop (data is kept in volumes)
docker compose down -v                              # stop AND delete all data
```

## Security notes

- Put a TLS-terminating reverse proxy in front of the app and set `COOKIE_SECURE=true` ([docs/installation.md](docs/installation.md#tls--reverse-proxy)).
- Everyone who can sign in can see everything the configured Datadog key can see. Local RBAC controls features, not
  per-resource Datadog visibility. Restrict access to people who are allowed to see the whole organization.
- Use read-only Datadog keys, and rotate them through Admin › Datadog Config.
- See [docs/security.md](docs/security.md) for the full model and a hardening checklist.

## Limitations & roadmap

Not implemented yet: OIDC/SSO and MFA (local accounts only), multi-organization tenancy (the schema is org-scoped but the UI
manages one org), log indexing (logs are a live per-resource lookup), and a graphical topology view.
Pods and clusters are derived from container tags, and AWS service resources from integration metrics in the last 4 hours.
See [docs/datadog-sources.md](docs/datadog-sources.md) for each source's exact coverage.
