# Architecture

## Containers

| Service (container) | Image | Port | Role |
|---|---|---|---|
| `web` (`datadog-search-web`) | `nginxinc/nginx-unprivileged:1.27-alpine` + built SPA | 8080 (published) | Serves the React app, proxies `/api`, `/healthz` and `/readyz` to the api, adds security headers and CSP. Read-only root filesystem, `/tmp` tmpfs |
| `api` (`datadog-search-api`) | `python:3.12-slim` + FastAPI/uvicorn (2 workers), UID 10001 | 8000 (internal) | REST API: auth, RBAC, search, facets, suggest, export, bulk lookup, inspector data, reports, change history, admin, live Datadog lookups. On start: migrations, first admin, demo seed |
| `worker` (`datadog-search-worker`) | same image as api, `python -m app.worker` | – | Sync scheduler and queue consumer, retention, recovery of orphaned jobs, demo timestamp refresh, heartbeat |
| `db` (`datadog-search-db`) | `postgres:16-alpine` | 5432 (internal) | System of record: users, sessions, inventory, relationships, change history, saved searches, audit, sync jobs, settings |
| `redis` (`datadog-search-redis`) | `redis:7-alpine` (AOF on, 128 MB, volatile-lru) | 6379 (internal) | Job queue, search result cache, login throttling counters, worker heartbeat, data version |

Named volumes: `db_data` (PostgreSQL), `redis_data` (Redis AOF) and `history_archive` (change-history archives, mounted at `/archive` in api and worker,
replaceable with a host folder via `HISTORY_ARCHIVE_PATH`). Each service has a health check (except the worker), a restart
policy and CPU/memory limits.

## Request flow

```
Browser ──HTTP──► nginx (web)
                   ├─ /, /assets/*         → static SPA (immutable cache for hashed assets)
                   └─ /api/*, /healthz…    → api:8000 (X-Real-IP = client address)
                                              │
                                              ├─ security.current_user  (cookie → session → user + permissions; CSRF check on writes)
                                              ├─ route handler
                                              │    ├─ PostgreSQL (psycopg3 pool, 1–10 connections per process)
                                              │    └─ Redis (cache / throttle / queue)
                                              └─ (live lookups) → Datadog API
```

## Sync pipeline

```
worker loop (every ≤5 s)
  ├─ heartbeat → redis ds:worker_heartbeat (TTL 60 s)
  ├─ every 30 s: schedule_due()   → if enabled and interval elapsed → sync.enqueue("schedule")
  ├─ every 60 s: refresh DEMO last_observed
  ├─ every 1 h:  retention()      → audit, search log, sessions, old jobs, orphaned jobs
  │                                  + history.purge("schedule"): change history roll-off (containers/pods vs rest, 0 = forever),
  │                                    archived to /archive/*.csv.gz first when enabled, deleted in 20k batches
  └─ BLPOP ds:jobs → sync.run(job_id)

sync.run(job)
  1. mark job running; load the connection (site and keys: env overrides DB; keys decrypted)
  2. for each enabled collector (hosts, monitors, devices, interfaces, kubernetes, services, synthetics, dashboards, aws):
       records = Client.<collector>()                          ← paginated, retried, categorised errors
       BEGIN
         inventory.apply_records(collector, records, tracker):
           existing = {(type, external_id): (id, content_hash, last_observed)}   ← one query per collector
           for record:
             fingerprint unchanged → no rewrite; batch a narrow last_observed update if it moved ≥ 10 min
             changed / new         → upsert + tracker diff → resource_changes
           batched UPDATE … FROM unnest(ids, timestamps)       ← heap-only (HOT) updates, no index writes
           prune: DELETE … WHERE collector=… AND id NOT IN (seen) RETURNING → "removed"
         source_status = ok
       COMMIT                                                  (failure → rollback, source_status = error, sync_errors row)
  3. BEGIN
       tags enabled ? apply_records("tags", tag_records()) : delete Tag entities
       delete records of disabled collectors
       rebuild_relationships()   ← computed into a temp table, then only the difference is applied
     COMMIT
  4. real records collected and auto_purge_demo → demo.purge()
  5. bump redis ds:data_version (invalidates the search cache)
  6. job status success | partial | failed, counts (incl. changes), audit event
```

Each collector is **independent**: its own transaction, its own prune scope (`collector` column), and its own freshness row.

### Write efficiency

A sync only writes what changed:

- **Content fingerprint.** `content_hash` is the MD5 of everything stored except observation timestamps. Lists that are really sets (tags,
  IPs, aliases, list attributes such as host `sources`) are sorted first, because Datadog doesn't return them in a stable order. An unchanged
  record is not rewritten, so its trigram and GIN indexes aren't touched.
- **Narrow "last seen" updates.** When only `last_observed` moved (by at least 10 minutes), the ids are batch-updated in one statement. Only a
  non-indexed column changes and the table has `fillfactor = 80`, so these are **HOT** (heap-only) updates that need no index maintenance and are
  cleaned up in-page.
- **Seen-set pruning** replaces the old “every row gets a new `sync_version`” scheme, so unchanged rows need no write at all.
- **Relationship diff.** Edges are computed into a temp table, and only added or removed edges are written.

On the reference instance, a sync with no changes writes **0 rows** and about 25 kB of WAL (against about 500 kB before). At 500k resources
that's the difference between a few MB and several GB of WAL per sync. `last_indexed` (“Content changed” in the inspector) now means “the last time the record's content changed”.

## Query compiler

`api/app/query.py`:

1. `tokenize()` produces `LP`, `RP`, `AND`, `OR`, `NOT` and `TERM` tokens. It handles quotes with escapes, `/regex/` after `field:`,
   parentheses inside terms (so `regex:^(a|b)` works), and a leading `-` as NOT.
2. `Parser` is recursive descent with precedence OR < AND < NOT and implicit AND. It enforces the term-count and depth limits.
3. `make_term()` resolves the field (with synonyms such as `aws:`/`mac:` → `alias`) and the match type (exact, wildcard, regex, CIDR,
   presence, contains), treats unknown `key:value` as a tag and bare MACs as text, and validates regex and CIDR syntax.
4. `compile_sql()` emits a parameterised predicate over `resources r`. Array fields use `EXISTS (SELECT 1 FROM unnest(r.tags) x(v) WHERE …)`,
   wildcards become `LIKE … ESCAPE '\'` on lower-cased values, CIDR uses `x.v::inet <<= %s::inet`, and regex uses `~*`.
5. `matching_alias()` re-evaluates the terms in Python to report which alias matched, for display.

The search endpoint runs, in one transaction with `SET LOCAL statement_timeout = '5s'`:
the page query (`count(*) OVER()` for the total), type counts (ignoring scope), and status, environment and tag facets (within scope).
The response is cached in Redis for 30 s under a hash of (data version, all parameters).

## Database schema

| Table | Purpose | Key columns |
|---|---|---|
| `schema_migrations` | applied migration versions | `version` |
| `roles` | role definitions | `name`, `permissions[]` |
| `users`, `user_roles` | accounts | `username` (unique), `password_hash` (Argon2id), `enabled` |
| `sessions` | server-side sessions | `token_hash` (HMAC-SHA256), `csrf_token`, `expires_at`, `ip`, `user_agent` |
| `organizations` | org label | `name` |
| `datadog_connections` | per-org connection | `site`, `api_key_enc`, `app_key_enc` (Fernet), `enabled`, `sync_interval_minutes`, `sources[]` |
| `resources` | normalised inventory | `type`, `name`, `external_id`, `status`, `status_group`, `ips[]`, `aliases[]`, `tags[]`, `env`, `os`, `vendor`, `model`, `agent_version`, `deep_link`, `attributes` (JSONB), `search_blob`, `source`, `collector`, `content_hash`, `sync_version`, timestamps (`fillfactor 80`). **Unique** `(org_id, source, type, external_id)` |
| `monitors` | monitor details | `query`, `message`, `monitor_type`, `muted` |
| `resource_relationships` | stored edges | `(from_id, to_id, relation)`, `evidence` |
| `resource_changes` | change history | `at`, `resource_id` (nullable), `resource_key`, `change`, `before`/`after` (JSONB), `summary`, `job_id` |
| `saved_searches` | private and shared searches | `owner_id`, `query`, `scope`, `shared`, `run_count` |
| `favorites` | per-user stars | `(user_id, kind, ref)` |
| `search_audit` | every executed search | `user_id`, `query`, `result_count`, `took_ms` |
| `audit_events` | admin and auth audit | `username`, `action`, `target`, `detail`, `ip` |
| `sync_jobs`, `sync_errors` | job history and per-source errors | `status`, `counts`, `category`, `message` |
| `source_status` | per-source freshness | `last_success`, `last_attempt`, `last_error`, `category`, `record_count` |
| `app_settings` | in-app settings | `key`, `value` (JSONB) |

Indexes: trigram GIN on `lower(name)`, `search_blob` and `resource_changes.name`; GIN on `tags`, `ips` and `aliases`; B-tree on
type, status group, collector, change time and key.

Migrations (`api/app/migrations/NNN_name.sql`) are applied in order, once, in a transaction, under `pg_advisory_lock(424242)`.

## Bulk lookup

`POST /api/v1/bulk-lookup` (`routes/bulk.py`) parses and deduplicates the pasted text, classifies each item (IP, CIDR, instance ID, MAC,
container ID, name), and runs one indexed query per item inside a single transaction (`statement_timeout` 30 s):

- IP: `%s = ANY(r.ips)` (GIN index on `ips`)
- CIDR: `EXISTS (unnest(r.ips) … ::inet <<= %s::inet)`
- everything else: `lower(name) = %s OR lower(external_id) = %s OR EXISTS (unnest(aliases) … lower(a) = %s)`, then optionally a
  short-name pass on `split_part(lower(name), '.', 1)`
- misses: one lookup in `resource_changes` for a `removed` entry by name, a `before->'ips'` element or a `before->'aliases'` element

2,000 items typically resolve in well under a second. The run is written to `search_audit`, and CSV exports also go to `audit_events`.

## Caching & invalidation

| Key | Content | TTL |
|---|---|---|
| `ds:search:<sha256>` | search response JSON | 30 s |
| `ds:data_version` | counter bumped after sync, demo seed or purge, and live refresh. Part of every cache key | – |
| `ds:login_fail:u:<user>` / `:ip:<ip>` | failed sign-in counters | 300 s |
| `ds:worker_heartbeat` | ISO timestamp | 60 s |
| `ds:next_scheduled_sync` | ISO timestamp | – |
| `ds:jobs` | queue of sync job IDs | – |

The app runs without Redis (caching, throttling and the queue degrade), but the worker needs Redis to receive jobs.

## Frontend

React 19 + TypeScript (strict) + Vite, served as static files. There's no state library: state lives in an `AppProvider` context (user,
status, theme, toasts), and search state lives in the URL (`useSearchParams`). Icons come from `lucide-react`. Styles are one CSS file with variables.
The light theme overrides those variables under `:root[data-theme="light"]`, and `public/theme.js` applies the saved theme before the first paint.
The header mesh (`MeshMountain.tsx`) is a canvas animation at 30 fps. It pauses off-screen, respects `prefers-reduced-motion` and reads its colours from CSS variables.

## Scaling notes

- A single PostgreSQL easily handles tens of thousands of resources. Searches take 5–30 ms on the demo and small real estates.
- To scale the api, raise the `--workers` count or run more api replicas behind nginx. Sessions are in PostgreSQL and the cache in Redis, so it's stateless.
- Run exactly **one** worker, because jobs are serialised per org. Running more is safe (only one job is queued per org), but it doesn't help.
- For very large container estates, consider disabling *Tags* or increasing the sync interval.
