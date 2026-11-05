# REST API

All endpoints are under `/api/v1` and served through nginx on the app's port. Everything except sign-in and the health
checks needs a session. The OpenAPI schema is at `/api/openapi.json`.

- [Authentication & CSRF](#authentication--csrf)
- [Errors](#errors)
- [Auth](#auth) · [Search](#search) · [Bulk lookup](#bulk-lookup) · [Resources](#resources) · [Change history](#change-history) · [Reports](#reports)
- [Saved searches, favorites, history](#saved-searches-favorites-history) · [Status](#status) · [Admin](#admin) · [Health](#health)

## Authentication & CSRF

1. `POST /api/v1/auth/login` with `{"username","password"}` returns `{"user","csrf"}` and sets two cookies:
   `ds_session` (HttpOnly, SameSite=Strict) and `ds_csrf`.
2. Send the cookies with every request.
3. Every **non-GET** request must include the header `X-CSRF-Token: <csrf>`.

```bash
BASE=http://localhost:8080/api/v1
CSRF=$(curl -s -c jar -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<password>"}' $BASE/auth/login | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf"])')

curl -s -b jar "$BASE/search?q=type:monitor%20status:alert&page_size=5"
curl -s -b jar -X POST -H "X-CSRF-Token: $CSRF" $BASE/admin/sync-jobs
```

## Errors

Errors return the appropriate HTTP status and `{"detail": "<message>"}`: 400 (bad query, validation), 401 (not signed in),
403 (missing permission or CSRF), 404, 409 (conflict), 422 (invalid parameter), 429 (sign-in throttled), 502 (Datadog live lookup failed).

## Auth

| Method & path | Body / params | Returns |
|---|---|---|
| `POST /auth/login` | `username`, `password` | `{user, csrf}` + cookies |
| `POST /auth/logout` | – | `{ok}` |
| `GET /auth/me` | – | user (`id, username, display_name, email, role, roles, permissions, last_login`) |
| `POST /auth/password` | `current_password`, `new_password` | `{ok}`. Signs out your other sessions |

## Search

### `GET /search` (permission `search`)

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | `""` | query language, max 500 characters ([search-syntax.md](search-syntax.md)) |
| `scope` | string | `All` | one resource type |
| `types`, `status`, `env`, `tags` | repeated | – | filters (`status` takes groups `ok`, `alert`, `warn`, `muted`, `unknown`) |
| `sort` | `name`, `type`, `ip`, `status`, `last_seen` | `name` | |
| `dir` | `asc` or `desc` | `asc` | |
| `page`, `page_size` | int | 1, 10 | `page_size` ≤ 200 |
| `record` | bool | false | `true` records the search in the user's history and the audit log |

Response:

```json
{
  "results": [{ "id": 324, "type": "Host", "name": "i-0831170512d0e4fdb", "status": "Up", "status_group": "ok",
                "ips": ["172.31.28.227"], "aliases": ["ip-172-31-28-227.ec2.internal", "xeomon"], "tags": ["env:prod"],
                "matched_alias": "xeomon", "env": "prod", "os": "GNU/Linux", "source": "Datadog",
                "external_id": "5277…", "deep_link": "https://app.datadoghq.com/infrastructure?host=…",
                "last_observed": "…", "last_indexed": "…", "stale": false }],
  "total": 1, "page": 1, "page_size": 10, "pages": 1,
  "type_counts": { "Host": 1, "Monitor": 0, "...": 0 },
  "facets": { "status": { "ok": 1, "alert": 0, "warn": 0, "muted": 0, "unknown": 0 },
              "env": [{ "value": "prod", "count": 1 }], "tags": [{ "value": "env:prod", "count": 1 }] },
  "query": { "raw": "xeomon", "normalized": "xeomon", "terms": 1 },
  "took_ms": 12.4, "cached": false
}
```

### Other search endpoints

| Method & path | Permission | Notes |
|---|---|---|
| `GET /facets` | search | global counts per type and status group |
| `GET /suggest?prefix=` | search | autocomplete: `{word, suggestions:[{value,label,hint,kind}]}` |
| `GET /export` | export | same params as `/search` plus `ids` (repeated) and `format=csv|json`. Up to 50,000 rows. Audited |

## Bulk lookup

### `POST /bulk-lookup` (permission `search`; `format=csv` also needs `export`)

| Body field | Type | Default | Notes |
|---|---|---|---|
| `text` | string | – | raw pasted text, up to 200,000 characters. Split on whitespace, `,` `;` `|`; `#` lines ignored; deduplicated case-insensitively; max **2,000** items |
| `short_names` | bool | `true` | if an exact name/alias match fails, compare the part before the first `.` |
| `include_tags` | bool | `false` | include Tag entities in matches |
| `format` | `json` or `csv` | `json` | `csv` returns a download (audited as `bulk_lookup.export`) |

Response (`json`):

```json
{
  "items": 3, "took_ms": 21.7,
  "summary": { "found": 1, "multiple": 1, "not_found": 0, "removed": 1 },
  "results": [
    { "input": "xeomon", "kind": "hostname", "result": "found", "truncated": false, "previously": null,
      "matches": [{ "id": 324, "type": "Host", "name": "i-0831170512d0e4fdb", "status": "Up", "status_group": "ok",
                    "ips": ["172.31.28.227"], "source": "Datadog", "deep_link": "https://…", "matched_on": "alias" }] },
    { "input": "172.17.0.1", "kind": "ip", "result": "multiple", "matches": [ … 3 … ], "truncated": false, "previously": null },
    { "input": "old-web-03", "kind": "hostname", "result": "removed", "matches": [],
      "previously": { "at": "2026-11-03T22:10:00Z", "type": "Host", "name": "old-web-03", "summary": "no longer reported by Datadog (…)" } }
  ]
}
```

`kind` is one of `ip`, `cidr`, `instance_id`, `mac`, `container_id`, `hostname`. `result` is one of `found`, `multiple`, `not_found`, `removed`.
`matched_on` is one of `name`, `alias`, `id`, `ip`, `short name`. At most 20 matches are returned per item (`truncated: true` when there are more).

```bash
curl -s -b jar -X POST -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"text":"10.10.50.21\ni-0831170512d0e4fdb\nweb01","format":"csv"}' $BASE/bulk-lookup -o bulk.csv
```

## Resources

| Method & path | Permission | Returns |
|---|---|---|
| `GET /resources/{id}` | inspect | full record + `attributes`, monitor fields, `favorite`, `freshness`, `links`, `scope_monitor_count` |
| `GET /resources/{id}/topology?hops=1\|2` | inspect | graph: `{center, hops, nodes:[{id, type, name, status, status_group, ip, source, deep_link, stale, hop}], edges:[{source, target, relation, evidence}], truncated, center_detail}`. Two hops expand up to 60 first-hop neighbours (30 each, structural relations), capped at 300 nodes |
| `GET /resources/{id}/related` | inspect | `{related:[{relation, evidence, …resource}]}`. Relations: `monitor`, `scoped_to`, `runs_on`, `runs_in`, `member_of`, `interface_of`, `backed_by`, `workloads`, `containers`, `members`, `interfaces`, `synthetic`, `application`, `same_ip` |
| `POST /resources/{id}/refresh` | inspect | live monitor status: `{refreshed, status, muted?, reason?}` |
| `GET /resources/{id}/metrics` | inspect | `{mode: live|demo|error|n/a, series:[{name, points:[[ms, value]]}]}` |
| `GET /resources/{id}/logs` | inspect | `{mode, query, logs:[{timestamp, status, service, host, message}]}` |
| `GET /resources/{id}/history` | inspect | `{first_indexed, changes:[{id, at, change, summary, before, after}]}` |

## Change history

### `GET /changes` (permission `search`)

| Param | Notes |
|---|---|
| `since` | ISO-8601 timestamp (takes precedence over `hours`) |
| `hours` | look-back window, default 24, max 9600 |
| `change` | repeated: `added`, `removed`, `status`, `tags`, `ips`, `aliases`, `renamed` |
| `type` | repeated resource types |
| `q` | text matched against name, summary, resource key and *before* values |
| `page`, `page_size` | default 1, 100 (max 1000) |
| `format` | `csv` for a download (up to 50,000 rows) |

Response: `{since, summary:{added:…}, by_type:{Host:…}, rows:[{id, at, resource_id, resource_key, source, type, name, change, summary, before, after, job_id, current_status, current_status_group}], total, page, page_size}`.

## Reports

| Method & path | Notes |
|---|---|
| `GET /reports` | `[{key, title, description, count}]` |
| `GET /reports/{key}` | `{key, title, description, query, columns[], rows[]}`. Keys: `alerting`, `duplicate-ips`, `missing-tags`, `stale`, `unmonitored`, `agent-versions` |

## Tag Enforcer integration

- `GET /resources/{id}` includes `tag_policy`: `{available, evaluated, compliant, error_count, warning_count, remediable, teams, issues, findings, blind_spots, link, te_scan_id, imported_at}`.
  `available` is false when the integration is off; `evaluated` is false when Tag Enforcer has no verdict for the resource.
- `GET /resources/{id}/topology` nodes carry `tag_compliant` and `blind_spots` when evaluated.
- `GET /reports/blind-spots`: one row per (resource, monitor).
- `POST /admin/tag-enforcer/import` (permission `admin.integrations`): import now. Returns `{status, te_scan_id, received, matched, unmatched, blind_spots}`; `502` with the reason if Tag Enforcer can't be read.
- `GET /admin/health` includes `tag_enforcer`.

```bash
curl -s -b jar -X POST -H "X-CSRF-Token: $CSRF" $BASE/admin/tag-enforcer/import
```

## Saved searches, favorites, history

| Method & path | Body | Notes |
|---|---|---|
| `GET /saved-searches` | – | your own + shared searches, each with `mine` and `favorite` |
| `POST /saved-searches` | `name, query, scope?, description?, shared?` | `shared` needs `saved.shared`. The query is validated |
| `PATCH /saved-searches/{id}` | any of the fields above | owner, or `saved.shared` for shared searches |
| `DELETE /saved-searches/{id}` | – | |
| `POST /saved-searches/{id}/run` | – | increments the run count |
| `GET /favorites` | – | `{resources:[…], queries:[…]}` |
| `PUT /favorites` | `kind: resource|query, ref, label?` | |
| `DELETE /favorites?kind=&ref=` | – | |
| `GET /history` | – | your recent distinct searches |
| `DELETE /history` | – | hides them from your view (the audit log keeps them) |

## Status

`GET /status` (any signed-in user): `{mode: connected|demo|not_configured, site, site_label, org, last_sync, last_sync_status, resources:{DEMO:n, Datadog:n}, worker, version}`.

## Admin

| Method & path | Permission | Notes |
|---|---|---|
| `GET /admin/users` | admin.users | |
| `POST /admin/users` | admin.users | `username, password, role, display_name?, email?` |
| `PATCH /admin/users/{id}` | admin.users | `role?, enabled?, display_name?, email?, password?` |
| `DELETE /admin/users/{id}` | admin.users | |
| `POST /admin/users/{id}/revoke-sessions` | admin.users | |
| `GET /admin/roles` | admin.users | roles + `viewer_can_export` |
| `GET /admin/settings` · `PATCH /admin/settings` | admin.settings | `viewer_can_export, auto_purge_demo, session_hours, required_tags[], stale_after_hours, audit_retention_days, history_retention_days, ephemeral_history_retention_days, track_ephemeral_changes, history_archive_enabled, default_page_size`. Retention values of `0` mean keep forever |
| `GET /admin/integrations` | admin.integrations | connection (keys masked), `catalog`, `sources`, `source_status`, `type_counts` |
| `PATCH /admin/integrations` | admin.integrations | `org_name?, site?, api_key?, app_key?, enabled?, sync_interval_minutes?, sources?[]` |
| `POST /admin/integrations/test` | admin.integrations | `{api_key: bool, app_key: bool, errors[]}` |
| `POST /admin/sync-jobs` · `GET /admin/sync-jobs` | admin.integrations | queue a sync / last 25 jobs with errors |
| `POST /admin/demo` | admin.integrations | `{action: seed|purge}` |
| `GET /admin/audit` | admin.audit | `kind=events|searches, q, page, page_size, format=csv` |
| `GET /admin/health` | admin.settings | database, Redis, worker, Datadog |
| `GET /admin/history` | admin.settings | change-history usage: `total, containers_pods, other, oldest, newest, bytes, by_change, due{other, containers_pods, total}, settings, last_rolloff, archive{enabled, dir, writable}` |
| `POST /admin/history/purge` | admin.settings | roll off now using the saved settings: `{trigger, deleted, by_rule, archive{file, bytes}|null, at}`. 409 if archiving is on and the folder isn't writable (nothing deleted) |
| `GET /admin/history/archives` | admin.settings | `{dir, archives:[{file, bytes, created}]}` |
| `GET /admin/history/archives/{file}` | admin.settings | download a `.csv.gz` (strict name validation; audited) |

Example: enable only hosts and monitors, then sync:

```bash
curl -s -b jar -X PATCH -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"sources":["hosts","monitors","tags"]}' $BASE/admin/integrations
curl -s -b jar -X POST -H "X-CSRF-Token: $CSRF" $BASE/admin/sync-jobs
```

## Health

| Path | Auth | Returns |
|---|---|---|
| `GET /healthz` | none | `{ok: true}` when the api process is up |
| `GET /readyz` | none | `{ok: true}` when PostgreSQL and Redis are reachable, otherwise 503 |
