# Operations

- [Day-to-day commands](#day-to-day-commands)
- [Backup](#backup)
- [Restore](#restore)
- [Logs](#logs)
- [Monitoring the app](#monitoring-the-app)
- [Database access](#database-access)
- [Maintenance tasks](#maintenance-tasks)
- [Capacity planning](#capacity-planning)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## Day-to-day commands

```bash
docker compose ps                          # status and health
docker compose up -d                       # apply .env / compose changes
docker compose up -d --build               # rebuild images (after code or upgrade)
docker compose restart worker              # restart one service
docker compose logs -f --tail=100 worker   # follow logs
docker compose down                        # stop (data volumes kept)
```

## Backup

```bash
./scripts/backup.sh
# → backups/datadog-search-YYYYMMDD-HHMMSS.sql.gz
```

This runs `pg_dump --clean --if-exists` inside the db container and gzips the output. A dump holds users (password hashes), sessions,
inventory, change history, saved searches, audit, settings, and the **encrypted** Datadog keys. Redis holds only caches and
the queue, so it doesn't need a backup.

Change-history **archives** (if enabled) live outside the database, in the `history_archive` volume or your `HISTORY_ARCHIVE_PATH` folder.
Copy them off-host as part of your backups:

```bash
docker run --rm -v datadog-search_history_archive:/a -v "$PWD/backups":/b alpine sh -c 'cp /a/*.csv.gz /b/ 2>/dev/null || true'
```

Also back up **`.env` separately**. Without `DATA_ENCRYPTION_KEY`, the stored Datadog keys can't be decrypted.

Nightly at 02:30 with 14-day retention (crontab):

```cron
30 2 * * * cd /opt/datadog-search && ./scripts/backup.sh >/dev/null && find backups -name '*.sql.gz' -mtime +14 -delete
```

## Restore

```bash
./scripts/restore.sh backups/datadog-search-20261104-170129.sql.gz
```

The script asks for confirmation, stops `api`, `worker` and `web`, loads the dump into the database (`ON_ERROR_STOP`), then starts them again.
Everyone is signed out if `SESSION_SECRET` differs from the one used when the backup was taken.

To restore onto a new host: install, copy `.env` (same `DATA_ENCRYPTION_KEY`), `docker compose up -d`, then run `restore.sh`.

## Logs

| Service | What to look for |
|---|---|
| api | `applying migration`, `created initial administrator`, `seeded N DEMO records`, request lines with status codes, tracebacks |
| worker | `worker started`, `scheduled sync job N`, `running sync job N`, `synced <source>: N records (written W, touched T, unchanged U, pruned P; changes {...}) in Xs`, `removed N DEMO records`, `rate limited … waiting`, `retention removed …`, `history roll-off (schedule): deleted N entries …, archived to …`, `change-history roll-off skipped: …` |
| web | nginx access log (health checks are not logged) |
| db / redis | start-up, checkpoints, AOF rewrites |

Logs go to stdout (Docker's json-file driver by default). Ship them to Datadog with the Agent's Docker log collection, filtering on
the `datadog-search-*` containers.

## Monitoring the app

| Check | Expectation |
|---|---|
| `GET http://<host>:8080/readyz` | 200 `{"ok":true}`. 503 means PostgreSQL or Redis is unreachable |
| `GET http://<host>:8080/healthz` | 200 while the api is up |
| `docker compose ps` | web, api, db and redis `healthy` |
| Worker heartbeat | **Admin › System Health › Sync worker** OK. The header shows “worker offline” when the heartbeat is older than 60 s |
| Sync freshness | **Admin › Datadog Config › Data sources & freshness** shows every enabled source as OK, with a recent *Last success* |
| Last sync | header “Last Sync”. Alert if it's older than about 3× the sync interval |

A Datadog HTTP check on `/readyz`, plus a monitor on the worker container's restarts, covers most failures.

## Database access

```bash
docker compose exec db psql -U search -d search
```

Useful queries:

```sql
-- inventory by source / type
SELECT source, type, count(*) FROM resources GROUP BY 1,2 ORDER BY 1,2;
-- freshness
SELECT source, record_count, last_success, category, last_error FROM source_status ORDER BY source;
-- last jobs
SELECT id, trigger, status, counts, started_at, finished_at FROM sync_jobs ORDER BY id DESC LIMIT 10;
-- changes today
SELECT at, change, type, name, summary FROM resource_changes WHERE at > date_trunc('day', now()) ORDER BY at DESC;
-- when did X disappear?
SELECT at, summary, before FROM resource_changes WHERE change='removed' AND name ILIKE '%web-03%';
```

## Maintenance tasks

| Task | How |
|---|---|
| Force a full resync | **Sync now** (every sync is complete per source) |
| Rebuild relationships / tags only | run a sync |
| Re-seed demo data | Admin › Datadog Config › **Seed demo data** |
| Remove demo data | **Remove demo data**, or leave auto-purge on |
| Reset a forgotten admin password (no admins can sign in) | `docker compose exec api python -c "from app import db,security; db.open_pool(); c=db.pool.getconn(); c.execute(\"UPDATE users SET password_hash=%s, enabled=true WHERE username='admin'\", (security.hash_password('NewPassword123!'),)); c.commit()"` |
| Clear the search cache | `docker compose exec redis redis-cli INCR ds:data_version` |
| Unlock a throttled login | `docker compose exec redis redis-cli --scan --pattern 'ds:login_fail:*' \| xargs docker compose exec -T redis redis-cli DEL` |
| Roll off change history now | Admin › Settings › Change history storage › **Purge now** |
| Free disk after a big roll-off | autovacuum reuses the space. To return it to the OS: `VACUUM FULL resource_changes;` (locks the table briefly) |
| Vacuum / analyze | PostgreSQL autovacuum handles it. Run `VACUUM ANALYZE resources;` manually after very large syncs if needed |

## Capacity planning

Measured cost per stored item, including indexes:

| Item | Approx. size |
|---|---|
| Host / monitor / device | 2.5–3 KB |
| Container (tag-heavy) | ~5 KB |
| Tag entity | ~1.5 KB |
| Change-history entry | 1–2 KB |
| Search-history row | ~0.25 KB |

Estimates with the default retention (365 days for most history, **14 days for containers and pods**):

| | Small | Medium | Large enterprise |
|---|---|---|---|
| Example estate | 2k hosts, 5k monitors, 5k containers | 10k hosts, 1k devices (30k interfaces), 15k monitors, 50k containers | 20k hosts, 5k devices (150k interfaces), 30k monitors, 200k containers, 60k pods, 5k AWS resources |
| Indexed resources | ~20k | ~150k | ~500k |
| Current inventory | ~0.1 GB | ~0.6 GB | 2–4 GB |
| Change history (steady state) | <1 GB | 2–5 GB | 8–20 GB |
| Search history and audit log per year | <0.5 GB | ~1 GB | ~2 GB |
| **Total** | **<2 GB** | **4–8 GB** | **15–25 GB** |

Without the container/pod setting (all history kept 365 days), a large Kubernetes estate can reach 60–160 GB, mostly from
deploy churn (each replaced container is a *removed* plus an *added* entry). Turning **Record changes for containers and pods** off removes that
part entirely.

Sizing guidance for large estates:

- Give PostgreSQL 4–8 GB of RAM (raise the `db` memory limit in `compose.yaml`) and fast SSD storage. Provision about 2× the estimated size as disk.
- Because unchanged records aren't rewritten, write traffic per sync scales with **what changed**, not with inventory size.
  A 15-minute sync interval is comfortable at 500k resources.
- Compressed backups are about 15–25% of the database size.
- Check actual sizes in **Admin › System Health** (database size) or with:
  ```sql
  SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class
  WHERE relkind='r' AND relnamespace='public'::regnamespace ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;
  ```

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Header shows “Demo mode” after connecting | No real records synced yet | Run **Sync now** and check Sync jobs / freshness |
| Header shows “worker offline” | worker stopped or Redis down | `docker compose ps`, `docker compose logs worker`, `docker compose up -d worker` |
| A source shows **Permission denied** | missing key scope, wrong site | Check scopes ([datadog-sources.md](datadog-sources.md#permissions)) and that the site matches the org |
| **Not available for org/site** for devices / interfaces | NDM not enabled | Disable those sources |
| **Rate limited** | too many calls (often interfaces) | Raise the sync interval, or disable *Device interfaces* |
| Job stuck “running” | worker was killed mid-sync | It's marked failed automatically after 2 h. Restart the worker and **Sync now** |
| Containers but no pods/clusters | containers lack `kube_*` tags (plain Docker) | Expected. Pods and clusters come from Kubernetes tags |
| AWS services missing | the AWS integration doesn't collect that namespace, or no metrics in 4 h | Enable the namespace in Datadog's AWS integration |
| Search error “Invalid regular expression” | bad pattern | Fix the pattern. The message names the problem |
| Search error “Search timed out” | very expensive regex | Anchor it (`^`), or use a wildcard or CIDR |
| Expected host not found | not synced yet, or filtered by scope or facets | Clear filters, check *Last Sync*, then **Sync now** |
| Stored keys stopped working after a restore | different `DATA_ENCRYPTION_KEY` | Re-enter the keys in Admin › Datadog Config |
| Everyone was signed out | `SESSION_SECRET` changed, or session expiry | Expected |
| 403 “CSRF validation failed” from scripts | missing `X-CSRF-Token` | See [api.md](api.md#authentication--csrf) |
| “Archive folder /archive is not writable” | host folder in `HISTORY_ARCHIVE_PATH` not owned by UID 10001 | `sudo chown 10001:10001 <folder>`, or unset `HISTORY_ARCHIVE_PATH` to use the volume |
| Light theme flashes dark on load | `theme.js` blocked or cached | Hard-refresh. Check that `/theme.js` loads (CSP allows `'self'`) |

## FAQ

**Does it write anything to Datadog?** No. Every Datadog call is a read (GET, plus POST for the read-only logs and metrics search endpoints).

**How fresh is the data?** As fresh as the last sync (default every 15 minutes when scheduling is on). Monitor status can be refreshed
live from the inspector, and the Metrics and Logs tabs are always live.

**Can it index several Datadog orgs?** The schema is org-scoped, but the UI manages one org. Run one instance per org for now.

**How do I check a long list of IPs or hosts?** Use **Bulk Lookup** (up to 2,000 items per run). Export the CSV, or use
*Copy not found* to report the misses.

**Where are my saved searches stored?** In PostgreSQL (`saved_searches`). They are included in backups.

**Can I use an external PostgreSQL or Redis?** Yes. Set `DATABASE_URL` / `REDIS_URL` in `compose.yaml` and remove the bundled services.
PostgreSQL 14+ with the `pg_trgm` extension is required.
