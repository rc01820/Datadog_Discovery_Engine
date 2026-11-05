# Development

## Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, psycopg 3 (pool), redis-py, httpx, argon2-cffi, cryptography |
| Database | PostgreSQL 16 + `pg_trgm` |
| Cache / queue | Redis 7 |
| Frontend | React 19, TypeScript (strict), Vite, react-router 7, lucide-react, d3-force (topology layout). No CSS framework |
| Packaging | Docker multi-stage builds, Docker Compose |

## Running locally

The simplest loop is the full stack, rebuilding the service you changed:

```bash
docker compose up -d --build api worker   # backend change
docker compose up -d --build web          # frontend change
```

### Frontend with hot reload

Run the stack (for the API on :8080), then start Vite. It proxies `/api` to `localhost:8080`:

```bash
cd web
npm install
npm run dev            # http://localhost:5173
```

Type-check and build:

```bash
npx tsc -b
npm run build
```

### Backend tests

```bash
docker compose exec api python -m pytest -q tests
# or locally:
python -m venv .venv && .venv/bin/pip install -r api/requirements.txt
cd api && ../.venv/bin/python -m pytest -q tests
```

`tests/test_bulk.py` covers Bulk Lookup input parsing and item classification.
`tests/test_query.py` covers the tokenizer, parser, field and match resolution, SQL compilation, aliases, MAC handling and the new types.

## Code map

| File | Responsibility |
|---|---|
| `api/app/main.py` | FastAPI app, lifespan bootstrap (pool, migrations, first admin, demo seed), security headers, health checks, router registration |
| `api/app/config.py` | environment and `*_FILE` secrets |
| `api/app/db.py` | connection pool, migrations, settings helpers, Redis, audit helper, data version |
| `api/app/security.py` | password hashing, sessions, CSRF, throttling, permission dependency, key encryption |
| `api/app/query.py` | query language (tokenizer, parser, AST, SQL compiler, alias matcher) |
| `api/app/inventory.py` | `apply_records` (fingerprint skip, narrow last-seen updates, seen-set prune), upsert, change tracker, tag records, relationship diff, status normalisation |
| `api/app/datadog.py` | sites, deep links, HTTP client with retry and error categories, collectors, `SOURCE_CATALOG`, `AWS_METRICS` |
| `api/app/sync.py` | job queueing, the sync run, per-source freshness, demo auto-purge |
| `api/app/worker.py` | scheduler loop, retention, heartbeat |
| `api/app/history.py` | change-history retention plan, usage, archive-then-delete roll-off, archive listing |
| `api/app/demo.py` | demo inventory and history |
| `api/app/routes/*.py` | HTTP endpoints by area (`bulk.py`: Bulk Lookup parsing, classification, matching, CSV) |
| `web/src/api.ts` | typed fetch wrapper (CSRF header, 401 handling), shared types |
| `web/src/context.tsx` | user, status, permissions, toasts, theme |
| `web/src/util.tsx` | type metadata (icons, colours), status pills, time formatting |
| `web/src/pages/*` | screens (`BulkLookup.tsx`: paste/file input, results table, filters, CSV download).  `helpRecipes.ts` holds the Help examples |
| `web/src/components/*` | layout, search bar, inspector, **TopologyGraph** (ring/force layouts, collapse, pan/zoom, PNG/SVG export), mesh animation, modal, sparkline |

## How to add a Datadog data source

1. **Collector**: add a method to `Client` in `api/app/datadog.py` that yields normalised dicts:
   ```python
   def widgets(self):
       for w in self.get("/api/v2/widgets").get("data", []):
           yield {"type": "Widget", "external_id": w["id"], "name": w["attributes"]["name"],
                  "status": "OK", "tags": w["attributes"].get("tags", []), "ips": [], "aliases": [],
                  "deep_link": link(self.site, "Widget", w["id"]), "attributes": {...}}
   ```
   Use `self.get()` / `self.request()` to get retries and error categories.
2. **Register** it in `FETCHERS`, `DEFAULT_SOURCES` and `SOURCE_CATALOG` (label, description, types, API).
3. **New resource type?** Add it to `TYPES` in `inventory.py`, to `TYPE_ALIASES` in `query.py`, to `TYPES`/`TYPE_META` in `web/src/util.tsx`
   (icon and colour), and optionally a deep link in `link()`.
4. **Relationships**: extend `rebuild_relationships()`, using `_link_by_attr()` for attribute → `external_id` joins, and add labels to
   `OUTGOING`/`INCOMING` in `routes/resources.py` and `RELATION_LABEL` in `Inspector.tsx`.
5. **Existing installs**: add a migration that appends the key to `datadog_connections.sources` if it should be on by default.
6. **Demo data** (optional): add records in `demo.py`.
7. **Docs**: [datadog-sources.md](datadog-sources.md), the Help page and the README.

## How to add a query field

1. Add the name to `FIELDS` (and any synonyms to `FIELD_SYNONYMS`) in `query.py`.
2. Map it to a column in `COLUMN`, or add a branch in `compile_term()`.
3. Add it to `FIELD_HELP` in `routes/search.py` (autocomplete), and to the Help page and [search-syntax.md](search-syntax.md).
4. Add tests to `tests/test_query.py`.

## Database migrations

Create `api/app/migrations/NNN_description.sql` with the next number. It runs once, in a transaction, at api start-up.
Never edit an applied migration. Write a new one instead.

## Conventions

- All SQL is parameterised. Dynamic fragments come only from fixed dictionaries.
- Every state-changing endpoint depends on `security.require(<permission>)` (which also enforces CSRF) and writes `db.audit(...)`.
- Keep collectors side-effect free (they only yield records). Persistence happens in `sync.run` through `inventory.apply_records`.
- Anything a collector puts in a record (except `last_observed`) is part of the content fingerprint. Don't put per-call values
  (request times, counters) in `attributes`, or every sync will rewrite the record. Lists of plain values are compared order-insensitively.
- Frontend state that belongs in the URL (search, filters, period) lives in `useSearchParams`.
- Styles use CSS variables. Add any new colour to both the dark `:root` block and the light `[data-theme="light"]` block.
