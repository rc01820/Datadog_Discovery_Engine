# Change history

Datadog shows the *current* state of your infrastructure. Datadog Discovery Engine also remembers **what changed and when**,
so you can answer questions such as “when did this host disappear?”, “what flipped to Down overnight?” and “who lost
the env tag?”.

## What is recorded

Each sync compares every incoming record with the stored one, matching on the same source, type and Datadog ID:

| Change | Recorded when | Before → after |
|---|---|---|
| **added** | a record appears that wasn't there before (not on a source's first sync, which is the baseline) | – → name, status, IPs, tags, aliases |
| **removed** | a source no longer returns a record (pruned at the end of that source's sync) | last status, IPs, tags, aliases, last observed → – |
| **status** | the raw status text changes (e.g. `Up → Down`, `OK → Alert`, `Running → Exited`) | old status → new status |
| **tags** | the tag set changes | removed tags → added tags |
| **ips** | the IP set changes | removed → added |
| **aliases** | the alias set changes (instance ID, DNS, MAC…) | removed → added |
| **renamed** | the name changes but the ID stays the same | old name → new name |

Each entry also carries a human-readable summary (e.g. `tags: +env:prod −env:staging (+2 more)`), the sync job ID, a stable
`resource_key` (`source|type|external_id`) that survives deletion and re-creation, and a link to the live resource when it still exists.

**Not recorded**, to keep the signal clean:

- Tag entities (they are rebuilt every sync).
- The first sync of each source (the baseline). Otherwise every resource would show as “added”.
- Records deleted because an administrator **disabled a source**: that is a configuration change, not a real removal.
- DEMO timestamp refreshes.

Live monitor refreshes from the inspector (**Refresh live status**) also record a status change, attributed to the user who refreshed.

## Where to see it

### What Changed page (sidebar)

- **Period**: Today (since local midnight), last 24 hours, or 7, 30 or 90 days.
- **Summary tiles** per change kind. Click one to filter, and click more to combine.
- **Type filter** and a **text filter**. The text filter matches names, summaries, resource keys and the *before* values,
  so searching an old IP finds the host that used to have it.
- Changes are grouped by day, with time, kind, resource (linked if it still exists, struck through if removed), summary, current status and age.
- **CSV export** of the filtered list (up to 50,000 rows).
- The URL holds the filters, e.g. `/changes?period=168&change=removed&type=Host`.

### Resource timeline (inspector › History)

Every change for the resource, newest first, ending with “First indexed”. It includes changes recorded before the resource
was removed and re-created (it matches on `resource_key`).

### “When did this disappear?”

If a search returns nothing, the results page looks for **removed** or **renamed** records matching your text over the last
400 days and shows them, for example:

> **Not in the current inventory, but previously seen:** phantom-host-01: REMOVED 2h ago (11/4/2026, 7:22 PM) no longer reported by Datadog (last seen 2026-11-04 21:22 UTC)

with a link to its full change history.

### Bulk Lookup

Items in a bulk lookup that match nothing current are checked against **removed** entries (by name, a former IP or a former alias)
and reported as **Previously seen**, with the removal time. See [user-guide.md › Bulk Lookup](user-guide.md#bulk-lookup).

### Home

The **What changed (24h)** panel shows counts per kind and the six latest changes.

## How detection works

```
for each enabled source:
    tracker = ChangeTracker(track_added = source has synced successfully before)
    for each record from Datadog:
        prev = SELECT name, status, tags, ips, aliases WHERE (org, source, type, external_id)
        if fingerprint unchanged: skip (only refresh last_observed if it moved ≥ 10 min)
        else: UPSERT record
        tracker.diff(prev, record)            → added | renamed | status | tags | ips | aliases
    DELETE … WHERE collector = source AND id NOT IN (seen this sync) RETURNING *
        → removed (with last known state)
```

All writes for one source happen in a single transaction, so a failed source changes nothing and records no history.

## Retention and roll-off

Old history **rolls off** (is deleted) automatically after the period you set in **Admin › Settings › Change history**:

| Setting | Default | Applies to |
|---|---|---|
| Keep change history | 365 days, or **Keep forever** | everything except containers and pods |
| Keep container and pod change history | 14 days, or **Keep forever** | Container and Pod entries |
| Record changes for containers and pods | on | when off, no Container or Pod entries are recorded at all |
| Archive entries to a gzip CSV file before they roll off | off | when on, every entry is copied to an archive file before it is deleted |

Containers and pods are replaced on every deploy (one *removed* and one *added* entry each time), so on a large Kubernetes
estate they would otherwise dominate the history. See [operations.md › Capacity planning](operations.md#capacity-planning).

### When roll-off happens

- **Hourly**, run by the worker using the *saved* settings.
- **On demand** with **Purge now** in the *Change history storage* panel (Admin › Settings). A confirmation dialog shows exactly how many
  resource and container/pod entries will go, and whether they will be archived or deleted permanently.
- With **Keep forever** set for both groups, nothing ever rolls off. The panel shows “keep forever: nothing to roll off”.

Entries are removed in batches of 20,000, so a large first roll-off doesn't hold long locks.

### Change history storage panel

Below the settings form (Admin › Settings):

| Shows | Meaning |
|---|---|
| Entries | total entries, split into resources and containers/pods |
| Space used | size of the `resource_changes` table including its indexes |
| Oldest entry | age and timestamp of the oldest entry still kept |
| Due to roll off | how many entries the saved settings would remove right now (this is what **Purge now** deletes) |
| Saved retention / Archiving / Last roll-off | the active settings, whether archiving is on (and whether the folder is writable), and the time, trigger, count and archive file of the last roll-off |
| Archives | every archive file, with size, creation time and **Download** |

### Archives

When archiving is on, each roll-off writes one file named `change-history-<YYYYMMDD-HHMMSS>-<schedule|manual>.csv.gz` (empty runs leave no file),
with the columns:

`id, at, change, type, name, summary, source, resource_key, resource_id, job_id, before, after` (`before`/`after` are JSON).

- Files are written **before** the rows are deleted. If the archive folder isn't writable, the roll-off is skipped and nothing is deleted
  (the panel shows the problem in red, and the worker logs `change-history roll-off skipped`).
- The folder is the Docker volume `history_archive` by default (mounted at `/archive`), or the host folder in `HISTORY_ARCHIVE_PATH`
  ([configuration.md](configuration.md#environment-variables)).
- Archive files are never deleted by the app. Manage their lifetime yourself, e.g. with a cron job, or by copying them to object storage.
- Downloads are limited to administrators and recorded in the audit log (`history.archive_download`). Each roll-off is recorded as `history.rolloff`.

Re-importing an archive for analysis is a plain CSV load, e.g. in `psql`:

```sql
CREATE TABLE archived_changes (id bigint, at timestamptz, change text, type text, name text, summary text, source text,
  resource_key text, resource_id text, job_id text, before jsonb, after jsonb);
\copy archived_changes FROM PROGRAM 'gunzip -c change-history-20261105-013120-manual.csv.gz' WITH (FORMAT csv, HEADER)
```

## API

```
GET /api/v1/changes?hours=24&change=removed&type=Host&q=web&page=1&page_size=100[&format=csv]
GET /api/v1/changes?since=2026-11-04T00:00:00Z
GET /api/v1/resources/{id}/history
GET  /api/v1/admin/history                     # usage + what is due to roll off
POST /api/v1/admin/history/purge               # roll off now (archives first when enabled)
GET  /api/v1/admin/history/archives            # list archive files
GET  /api/v1/admin/history/archives/{file}     # download one
```

See [api.md](api.md#change-history).

## Demo mode

Demo data includes about 14 sample changes over the last three days (status flips, a tag change, an IP change, a rename,
an alias addition and two removed hosts), so the feature can be explored before Datadog is connected. They are deleted along with the demo data.
