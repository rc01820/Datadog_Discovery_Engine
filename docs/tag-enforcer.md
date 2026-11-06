# Tag Enforcer integration

[Tag Enforcer](https://github.com/rc01820/Datadog_Tag_Enforcer) decides whether each resource is tagged the way your tag policy says.
Discovery knows how each resource connects to monitors, hosts and clusters, and how it has changed. With the integration on,
Discovery imports Tag Enforcer's verdicts and shows them alongside everything else it knows. The two together find
**monitor blind spots**: monitors that are not watching a resource only because one of its tags is spelled differently.

Each app keeps its own Datadog connection and database. Discovery reads; it never writes to Tag Enforcer.

```
 Datadog API ──► Tag Enforcer (scans, policy, fixes)
      │                │  GET /api/compliance/resources   (X-TE-Token)
      │                ▼
      └──────► Discovery worker ── after each sync, every 15 min, or "Import now"
                       │            matches resources, computes blind spots
                       ▼            → tag_compliance table
               search · inspector · reports · topology
```

## Connecting the two apps

The integration is optional and off by default. Each side needs a few settings; nothing is configured in either UI.

### The settings

| App | Setting | Value | Purpose |
|---|---|---|---|
| Tag Enforcer | `TE_API_TOKEN` | a long random string | Discovery authenticates with it (`X-TE-Token`). Already used for CI |
| Tag Enforcer | `TE_DISCOVERY_URL` | Discovery's browser URL, e.g. `http://localhost:8080` | optional: **Open in Discovery** links on Tag Enforcer's pages |
| Tag Enforcer | `TE_HTTP_PORT` | e.g. `8087` | host port for Tag Enforcer's UI. Both apps default to 8080 |
| Discovery | `TAG_ENFORCER_URL` | Tag Enforcer's address **as the api/worker containers see it** | turns the import on (with the token) |
| Discovery | `TAG_ENFORCER_TOKEN` | the same value as `TE_API_TOKEN` | `TAG_ENFORCER_TOKEN_FILE` also works |
| Discovery | `TAG_ENFORCER_PUBLIC_URL` | Tag Enforcer's **browser** URL, e.g. `http://localhost:8087` | optional: **Open in Tag Enforcer** links. Defaults to `TAG_ENFORCER_URL` |

`TAG_ENFORCER_URL` and `TAG_ENFORCER_PUBLIC_URL` differ whenever the containers and your browser reach Tag Enforcer by different
names, which is the case in every Docker setup below. Both apps should point at the **same Datadog site**, or nothing will match.

The token gives operator rights in Tag Enforcer, but Discovery only ever calls one read-only endpoint with it.

### Same machine, two Compose projects (the usual setup)

Each app runs from its own folder with its own `docker compose`. Discovery's api and worker reach Tag Enforcer through the
host via `host.docker.internal` (mapped in `compose.yaml`, so this works on Linux as well as Docker Desktop).

1. **Tag Enforcer**, in `Datadog_Tag_Enforcer/.env`:

   ```bash
   TE_HTTP_PORT=8087
   TE_API_TOKEN=<python -c "import secrets;print(secrets.token_urlsafe(32))">
   TE_PUBLIC_URL=http://localhost:8087
   TE_DISCOVERY_URL=http://localhost:8080
   ```

   ```bash
   docker compose up -d --build
   ```

2. **Discovery**, in `datadog-search/.env`:

   ```bash
   TAG_ENFORCER_URL=http://host.docker.internal:8087
   TAG_ENFORCER_TOKEN=<the TE_API_TOKEN value from step 1>
   TAG_ENFORCER_PUBLIC_URL=http://localhost:8087
   ```

   ```bash
   docker compose up -d        # recreates api and worker with the new settings
   ```

3. Let Tag Enforcer finish a scan (it needs Datadog keys for that), then open **Admin › System Health** in Discovery and click
   **Import now**. The Tag Enforcer card shows how many resources matched.

### Shared Docker network

To keep the traffic off the host, attach both projects to one network and use Tag Enforcer's container name:

```bash
docker network create datadog-tools
```

```yaml
# datadog-search/compose.override.yaml
services:
  api:    {networks: [default, datadog-tools]}
  worker: {networks: [default, datadog-tools]}
networks:
  datadog-tools: {external: true}
```

```yaml
# Datadog_Tag_Enforcer/compose.override.yaml
services:
  tag-enforcer: {networks: [default, datadog-tools]}
networks:
  datadog-tools: {external: true}
```

Then set `TAG_ENFORCER_URL=http://tag-enforcer:8080` (the container port, not the published one) and keep
`TAG_ENFORCER_PUBLIC_URL` as the browser URL.

### Separate hosts or Kubernetes

Set `TAG_ENFORCER_URL` to any address Discovery's worker can reach, such as `https://tag-enforcer.internal` or
`http://tag-enforcer.observability.svc:80` in-cluster. Tag Enforcer's `deploy/kubernetes.yaml` keeps `TE_API_TOKEN` in its
Secret; give Discovery the same value. Allow the worker and api egress to that address.

### Check the connection

From Discovery's worker container, Tag Enforcer should answer with its latest scan:

```bash
docker compose exec -T worker python -c "
import httpx; from app.config import settings as s
r = httpx.get(s.tag_enforcer_url + '/api/compliance/resources', params={'limit': 1},
              headers={'X-TE-Token': s.tag_enforcer_token}, timeout=10)
print(r.status_code, r.json().get('scan'))"
```

`200` with a scan means everything is wired. `200` with `None` means Tag Enforcer hasn't completed a scan yet.

### Turning it off

Remove `TAG_ENFORCER_URL` (or the token) and run `docker compose up -d`. Imports stop, the Tag policy tab and the
System Health card's import button disappear, and *Missing required tags* goes back to the key list in Admin › Settings.
The last imported verdicts stay in the database, so `compliant:`/`blindspot:` searches and the *Monitor blind spots* report
keep answering from them. To clear them as well:

```bash
docker compose exec -T db psql -U search -d search -c "TRUNCATE tag_compliance"
```

## Troubleshooting the connection

| System Health says | Cause | Fix |
|---|---|---|
| *Tag Enforcer refused the token (401)* | `TAG_ENFORCER_TOKEN` doesn't match `TE_API_TOKEN` | Copy the value again, then `docker compose up -d` here |
| *ConnectError … Connection refused* / *Name or service not known* | wrong `TAG_ENFORCER_URL`, wrong port, or Tag Enforcer isn't running | Use the address the containers see (`host.docker.internal:<TE_HTTP_PORT>`, not `localhost`). Run the check above |
| *Tag Enforcer has no completed scan yet* | Tag Enforcer has no Datadog keys, or hasn't scanned | Add `DD_API_KEY`/`DD_APP_KEY` there, run a scan, then **Import now** |
| Import succeeds but *evaluated resources* is 0 | the apps scan different Datadog sites or orgs, or Discovery holds only DEMO data | Point both at the same site and org, and run a real sync here |
| Many *unmatched* hosts | hosts renamed since one of the scans, or Tag Enforcer scans types Discovery doesn't collect | Sync both. `slo` and `log_pipeline` are always unmatched |
| *Open in Tag Enforcer* links go to an unreachable address | `TAG_ENFORCER_PUBLIC_URL` unset, so links use the container address | Set it to the URL you open in a browser |
| Tag Enforcer's *Open in Discovery* links missing | `TE_DISCOVERY_URL` unset on Tag Enforcer | Set it and recreate Tag Enforcer's container |

## What you get

| Where | What |
|---|---|
| **Search** | `compliant:no`, `compliant:yes`, `tagissue:missing_required`, `tagissue:missing_required:service`, `tagissue:forbidden`, `fixable:yes`, `blindspot:yes`, `has:tagpolicy` / `missing:tagpolicy`. They combine with everything else: `type:host env:prod compliant:no` |
| **Inspector › Tag policy** | The verdict, owning team, each finding with the policy's suggested fix, an *auto-fixable* badge, and a link to the resource in Tag Enforcer. **Monitors not watching this resource** lists the blind spots; click one to open the monitor. Clicking a finding searches for every resource with the same problem. A red dot on the tab means the resource fails the policy |
| **Overview** | A *Tag policy* row: compliant, or the error/warning count and number of blind spots |
| **Topology** | Resources that fail the policy are outlined in orange. A solid outline means at least one monitor misses the resource because of it; a dashed outline means the resource fails the policy but no monitor is affected |
| **Reports › Monitor blind spots** | One row per (resource, monitor): the tag it has, the tag the policy and monitor expect, and the monitor |
| **Reports › Missing required tags** | Uses Tag Enforcer's policy (per-type rules, every type it scans) instead of the key list in Admin › Settings, which stays as the fallback when the integration is off |
| **Admin › System Health** | Last import, Tag Enforcer scan number, resources evaluated and failing, unmatched counts by type, blind spots, and **Import now** |

## How resources are matched

| Tag Enforcer type | Discovery type | Matched on |
|---|---|---|
| `host` | Host, VMware, Cloud | host name (case-insensitive), then aliases. Discovery keys hosts on Datadog's numeric host ID, Tag Enforcer on the name |
| `monitor` | Monitor | monitor ID |
| `synthetic` | Synthetic | public ID |
| `dashboard` | Dashboard | dashboard ID |
| `apm_service` | Service | service name |
| `slo`, `log_pipeline` | — | not indexed by Discovery; counted as unmatched |

DEMO records are never matched. A resource with no row (`missing:tagpolicy`) is *not evaluated*: Tag Enforcer doesn't scan
its type (devices, containers, pods, AWS…), or it appeared after Tag Enforcer's latest scan.

## How blind spots are found

For each finding where the policy already knows the right spelling (`alias_remap`, `not_normalized`, `fragmentation`),
Discovery takes the suggested tag (say `env:prod`) and checks every monitor's query scopes (`{...}`). A monitor is a blind spot
only when **both** are true:

- it does **not** cover the resource with its current tags, and
- it **would** cover the resource with the tag fixed (every other required tag present, no excluded `!tag` present).

So fixing the tag is exactly what's needed. Scopes using `OR`, `IN` or parentheses are skipped rather than guessed, and
log/event monitors (no `{...}` scope) are not considered. Tag comparison is exact, because Datadog treats
`env:Production` and `env:prod` as different tags.

## When imports run

- After every Datadog sync (resources may have appeared or changed).
- Every 15 minutes in the worker, so new Tag Enforcer scans arrive even when no sync runs.
- On demand: **Import now** in System Health, or `POST /api/v1/admin/tag-enforcer/import` (permission `admin.integrations`).

Each import replaces all verdicts in one transaction. If an import fails (Tag Enforcer down, wrong token), the previous
verdicts stay, the failure shows in System Health, and syncs are unaffected. Imports are serialized with a Redis lock and audited
as `tag_enforcer.import`.

## Data

Migration `008_tag_enforcer.sql` adds `tag_compliance` (one row per evaluated resource: verdict, counts, teams, `issues` as
`category:key` tokens, findings and blind spots as JSONB, Tag Enforcer link path) and `tag_enforcer_imports` (one row per
import attempt). Both are dropped with the resources they belong to.
