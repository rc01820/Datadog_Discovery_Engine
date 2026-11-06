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

## Setup

1. In Tag Enforcer, set `TE_API_TOKEN` (any long random string). Optionally set `TE_DISCOVERY_URL` to this app's browser URL
   so Tag Enforcer's resource pages get **Open in Discovery** links.
2. In Discovery's `.env`:

   ```bash
   TAG_ENFORCER_URL=http://tag-enforcer:8080          # how the api/worker containers reach Tag Enforcer
   TAG_ENFORCER_TOKEN=<Tag Enforcer's TE_API_TOKEN>
   TAG_ENFORCER_PUBLIC_URL=https://tag-enforcer.internal   # what browsers use; defaults to TAG_ENFORCER_URL
   ```

   If both apps run under Docker Compose on one machine, either put them on a shared Docker network and use the
   service name, or use `http://host.docker.internal:<port>`. Both apps default to port 8080, so change one of them
   (`HTTP_PORT` here).
3. `docker compose up -d --build`, then **Admin › System Health › Import now**.

The token gives operator rights in Tag Enforcer, but Discovery only calls one read-only endpoint with it. `TAG_ENFORCER_TOKEN_FILE`
works like the other `_FILE` secrets.

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
