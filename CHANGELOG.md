# Changelog

## 1.4.0 (2026-11-05)

### Added
- **Topology view**: any resource drawn as a graph of its monitors, same-app resources, shared IPs, hosts, containers/pods/databases on it,
  cluster, interfaces and backing monitors, using the same relationships and evidence as the Related tab.
  - An inspector **Topology** tab and **View in Topology** quick action, plus a full page at `/topology/<id>` (`?hops=2`) with a side inspector.
  - **1 hop**: ring layout by relationship group. **2 hops**: force-directed layout (`d3-force`), capped at 300 nodes.
  - Groups over 12 collapse to a clickable **“+N more”** node. Layer chips, hover evidence, click to inspect, double-click to recenter, zoom and pan.
  - **PNG/SVG export**, shareable URLs, and it follows the dark/light theme.
  - `GET /api/v1/resources/{id}/topology?hops=1|2`.
- **Databases** data source: PostgreSQL (per database), MySQL, SQL Server, MongoDB, Redis and Elasticsearch instances discovered from integration metrics,
  as a new **Database** type (`type:database`, `db_engine:…`), linked to their host. Migration `007_databases.sql` enables it on existing installs.

## 1.3.0 (2026-11-04)

### Added: change-history retention controls
- **Keep forever** option for both history retention periods (stored as `0` days).
- **Purge now**: roll off history immediately using the saved settings, with a confirmation that shows how many resource and container/pod entries will go.
- **Archive before roll-off**: optional gzip CSV (`change-history-<timestamp>-<trigger>.csv.gz`) written before deletion. If the archive folder isn't writable,
  the roll-off is skipped (nothing is lost). Archives are listed and downloadable in the UI. New `history_archive` volume (`/archive`), overridable with `HISTORY_ARCHIVE_PATH`.
- **Change history storage** panel (Admin › Settings): entries (resources vs containers/pods), space used, oldest entry, what's due to roll off,
  saved retention, archive status, last roll-off and the archive list.
- API: `GET /admin/history`, `POST /admin/history/purge`, `GET /admin/history/archives`, `GET /admin/history/archives/{file}`.
- Roll-off runs in 20,000-row batches, and each roll-off and archive download is audited.
- Migration `006_history_archive.sql`.

## 1.2.0 (2026-11-04)

### Changed: storage and write efficiency
- **Syncs skip unchanged records.** Each record carries a content fingerprint (`content_hash`). Unchanged records are no longer rewritten;
  only `last_observed` is batch-updated when it moves by 10 minutes or more, as heap-only updates with no index maintenance (`fillfactor 80`).
  Removals are detected from the set of records seen instead of a per-row sync version.
  The fingerprint ignores the order of tags, IPs, aliases and list attributes, which Datadog returns in varying order.
- **Relationships are diffed** (temp table plus insert/delete of changes) instead of being deleted and re-inserted every sync.
- Tag entities are a regular collector (`tags`) using the same path.
- Measured on the reference instance: a no-change sync went from rewriting every record (about 500 kB of WAL) to **0 rows** (about 25 kB).
- Job counts include `rows_written` and `rows_unchanged`. The worker logs written/touched/unchanged/pruned per source.
- The inspector's “Indexed” is renamed to **Content changed** (the last time the record's content changed).

### Added
- Separate change-history retention: **Keep change history** (default 365 days), **Keep container and pod change history** (default 14 days),
  and **Record changes for containers and pods** (on/off). The audit log and search history keep their own retention setting.
- Capacity-planning section in `docs/operations.md`.
- Migration `005_write_efficiency.sql`.

## 1.1.0 (2026-11-04)

### Added
- **Bulk Lookup** (`/bulk`, sidebar): paste or load (`.txt`/`.csv`) up to 2,000 IPs, CIDR ranges, hostnames/FQDNs, AWS instance IDs, MAC
  addresses or container IDs. Items are auto-classified and matched exactly against names, aliases, Datadog IDs and IPs, with optional short-name
  matching. Results are **Found / Multiple matches / Not found / Previously seen** (from change history) and show which field matched.
  Filter by outcome, copy the misses, open the matches in Search, and export CSV.
- `POST /api/v1/bulk-lookup` (JSON or CSV).
- Home links to Bulk Lookup. Help, README and docs are updated.
- Unit tests for Bulk Lookup parsing and classification.

## 1.0.0 (2026-11-04)

First release of **Datadog Discovery Engine** (project `datadog-search`), built from the Neomon Search design specification and mockup.

### Platform
- Five-container Docker stack: nginx web, FastAPI api, sync worker, PostgreSQL 16, Redis 7, with health checks, resource limits and non-root images.
- Automatic, ordered schema migrations (`001`–`004` in 1.0.0).
- Backup, restore and env-initialisation scripts.

### Search
- Query language: free text, field prefixes, wildcards, exact match, CIDR, regex, AND/OR/NOT/parentheses, `has:`/`missing:`, unknown `key:value` as tags.
- Aliases: AWS instance ID, EC2/RDS DNS, AWS Name tag, container IDs, interface MAC and description. `alias:`/`aws:`/`mac:` fields, plus “alias: …” match hints.
- Facets, type tiles, sorting, pagination, autocomplete, shareable URLs, bulk export, CSV/JSON export with formula-injection protection.
- Search Help page with a live query tester and more than 100 runnable examples.

### Data sources
- Hosts (with VMware and Cloud inference), monitors, NDM devices, **device interfaces**, **containers, pods and clusters**, services, synthetics, dashboards,
  **AWS services** (15 service types via integration metrics) and **Tags** (derived, toggleable).
- Per-source toggles with labels, descriptions, API and per-type counts. Per-source freshness and error categories. Disabled sources are cleaned up at the next sync.
- Relationships: monitor scope, container → host and pod, pod → cluster, node → cluster, interface → device, synthetic → monitor, plus shared app tags and IP collisions.

### Change history
- Every sync is diffed: added, removed, status, tags, IPs, aliases and renames. The first sync of a source is a baseline.
- **What Changed** page, a per-resource **History** tab, “previously seen” on empty searches, and a Home panel.

### Experience
- Dark and **light** themes (toggle, plus Match system), an animated wireframe header, the resource inspector (overview, monitors, related, metrics, logs, history, raw).
- Home dashboard, Reports (six), Saved Searches with templates, Favorites, History, keyboard shortcuts.

### Administration & security
- Users and roles (Administrator / Operator / Viewer), settings, Datadog config (sites, encrypted keys, test, schedule), sync jobs, demo seed and purge with
  **automatic demo removal after the first real sync**, audit log (events and searches), system health.
- Argon2id, HttpOnly SameSite=Strict sessions, CSRF tokens, login throttling, CSP and security headers, statement timeouts.
