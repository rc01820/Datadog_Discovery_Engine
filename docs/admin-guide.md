# Administrator guide

Administration lives under **Admin** in the sidebar, which only the Administrator role can see.

- [Users](#users)
- [Roles & permissions](#roles--permissions)
- [Settings](#settings)
- [Datadog configuration](#datadog-configuration)
- [Data sources & freshness](#data-sources--freshness)
- [Sync jobs](#sync-jobs)
- [Demo data](#demo-data)
- [Audit log](#audit-log)
- [System health](#system-health)
- [Day-2 checklist](#day-2-checklist)

## Users

**Admin › Users** lists every account: username, email, display name, role, status, active sessions, last sign-in and creation date.

| Action | How | Notes |
|---|---|---|
| Add a user | **Add user** | Username 3–64 characters (`A-Z a-z 0-9 _ . @ -`), role and an initial password (12+ characters) |
| Change role | role dropdown in the row | Takes effect on the user's next request |
| Edit name / email | ✎ | |
| Reset password | 🔑 | Signs the user out everywhere |
| Sign out everywhere | ⇥ | Revokes all of the user's sessions |
| Disable / Enable | button | A disabled user can't sign in, and their sessions are revoked |
| Delete | 🗑 | Permanent. Their saved searches and favorites are deleted, and audit entries keep the username |

Safety rules: you can't demote, disable or delete yourself, and the last enabled administrator can't be demoted, disabled or deleted.
Every action is recorded in the audit log.

## Roles & permissions

**Admin › Roles** shows the permission matrix:

| Permission | Viewer | Operator | Administrator |
|---|---|---|---|
| `search`: search permitted resources | ✓ | ✓ | ✓ |
| `inspect`: details, related, metrics, logs, deep links | ✓ | ✓ | ✓ |
| `saved.personal`: personal saved searches | ✓ | ✓ | ✓ |
| `export`: CSV/JSON export | configurable | ✓ | ✓ |
| `saved.shared`: create and edit shared searches | – | ✓ | ✓ |
| `admin.users`: users and roles | – | – | ✓ |
| `admin.integrations`: Datadog config, sync, demo data | – | – | ✓ |
| `admin.settings`: settings and system health | – | – | ✓ |
| `admin.audit`: audit log | – | – | ✓ |

The **Configurable** checkbox gives Viewers the export permission. Permissions are enforced by the API on every request, not just hidden in the UI.

> All users see the whole indexed inventory. The app uses one Datadog key, so it can't reproduce each person's own Datadog
> permissions. Only give accounts to people who may see everything that key can read.

## Settings

**Admin › Settings**. Every field is described in [configuration.md › In-app settings](configuration.md#in-app-settings-admin--settings).
Changes take effect immediately and are audited.

### Change history retention

The **Change history** section sets how long history is kept: one period for resources and a shorter one for containers and pods,
each with **Keep forever**. It also has optional **archiving** to gzip CSV before roll-off.
The **Change history storage** panel below the form shows entries, space used, oldest entry, what's due to roll off, the last roll-off and the
archive files (with download). **Purge now** applies the saved settings immediately, after a confirmation that shows the counts.
Details: [change-history.md › Retention and roll-off](change-history.md#retention-and-roll-off).

## Datadog configuration

**Admin › Datadog Config** › **Connection**:

1. **Organization label**: shown in the header.
2. **Datadog site**: must match your org (US1 `datadoghq.com`, US3, US5, EU1, AP1, AP2, US1-FED `ddog-gov.com`).
3. **API key** and **Application key**: paste them and click **Save configuration**. They are stored encrypted (Fernet, derived from
   `DATA_ENCRYPTION_KEY`) and shown masked. Leave the fields blank to keep the current keys. If the keys come from the environment
   (`DATADOG_API_KEY`/`DATADOG_APP_KEY`), these fields are replaced by a note.
4. **Scheduled sync enabled** and **Sync interval** (5–1440 minutes).
5. **Test connection** validates both keys and lists any errors.
6. **Sync now** queues an immediate sync. If one is already queued or running, its job number is returned instead.

The **Sync status** card shows whether scheduling is on, the last sync result, how many sources are enabled and how many records were indexed.

### Rotating keys

Create new keys in Datadog, paste them, **Save**, **Test connection**, **Sync now**, then revoke the old keys in Datadog.

## Data sources & freshness

One row per source: **Hosts, Monitors, Network devices, Device interfaces, Containers/pods/clusters, Services, Synthetic tests,
Dashboards, AWS services, Databases, Tags**. Each row shows:

- **On** toggle: saved immediately, applied at the next sync. Disabling a source deletes its records at the next sync.
- The source label, a description, and the **Datadog API** it calls.
- **Resource types (indexed)**: current record count per type, e.g. *Containers 28 · Pods 0 · Clusters 0*.
- **Records** collected by the last successful run, **Last success**, **Last attempt**.
- **State**: OK, *disabled*, *not synced yet*, or an error category (Permission denied, Not available for org/site, Source unavailable,
  Rate limited, Error), with the message.

What each source collects, and the permissions it needs: [datadog-sources.md](datadog-sources.md).

**Tips**

- *Device interfaces* makes one API call per device. On large NDM estates, consider a longer sync interval.
- *AWS services* only finds services whose namespaces your AWS integration collects.
- If you don't need Tag entities, turning off *Tags* reduces index size. Tags on resources stay searchable.

## Sync jobs

The last 25 jobs: number, trigger (manual or schedule, and by whom), status (queued, running, success, partial, failed), queued time,
duration, records per source, the number of changes detected, and any errors per source.
The table refreshes every 3 seconds while a job is running.

How the worker schedules jobs: every 30 seconds it checks whether *interval* minutes have passed since the last queued job. Jobs
are queued in Redis (`ds:jobs`) and run one at a time. Jobs left `running` by a crashed worker are marked failed after 2 hours.
Queued jobs are re-queued when the worker restarts.

## Demo data

- On first start (with `DEMO_DATA=true`) the app seeds about 200 synthetic records: hosts, VMware, cloud and AWS services, devices, interfaces,
  monitors, synthetics, services, dashboards, Kubernetes clusters, pods and containers, tags, and roughly 14 history entries. They carry a `DEMO` badge.
- **Seed demo data** re-creates them, and **Remove demo data** deletes them, including their history.
- With **Remove DEMO data automatically once real Datadog data has synced** on (the default, in Admin › Settings), demo data is deleted
  after the first sync that collects real records, and it is not re-seeded on restart.
- DEMO hosts' “Last Seen” is refreshed every minute by the worker, so the stale examples stay stale and the live ones stay live.

## Audit log

**Admin › Audit Log** has two views:

- **Admin & auth events**: sign-ins (successful and failed), sign-outs, password changes, user changes, setting and integration changes,
  sync requests and results, exports, demo seed and purge, and startup. Each entry has time, user, action, target, JSON detail and client IP.
  Secrets are never logged: key changes appear as `"updated"` and password resets as `"reset"`.
- **Search queries**: every executed search with user, query, scope, result count and latency. Bulk lookups appear with scope `Bulk`
  and the query `[bulk lookup: N items] …`.

There's a filter box, 50 entries per page, and **CSV** export (up to 10,000 rows). Retention follows **Settings › Audit log and search history retention**.
Change history has its own retention settings (see [change-history.md › Retention](change-history.md#retention-and-roll-off)).

## System health

**Admin › System Health** refreshes every 10 seconds:

| Card | Shows |
|---|---|
| PostgreSQL | version, database size, resource, user and active-session counts |
| Redis | version, sync queue depth |
| Sync worker | heartbeat (sent every 5 s, expires after 60 s), next scheduled sync |
| Datadog connection | configured, enabled, site |
| Tag Enforcer | shown when the [integration](tag-enforcer.md) is configured: address, last import attempt and result, Tag Enforcer scan imported, resources evaluated and failing the policy, unmatched counts by type, resources with blind spots, and **Import now** |

For external monitoring use `GET /healthz` (process up) and `GET /readyz` (database and Redis reachable).
See [operations.md](operations.md#monitoring-the-app).

## Day-2 checklist

- [ ] Change the bootstrap admin password, and create named accounts for everyone.
- [ ] Put TLS in front and set `COOKIE_SECURE=true`.
- [ ] Use a read-only Datadog service account key, and enable Scheduled sync.
- [ ] Review **Data sources & freshness** for any source that isn't OK.
- [ ] Set **Required tag keys** to match your tagging standard.
- [ ] On large Kubernetes estates, keep **container and pod change history** short (default 14 days) or turn it off ([operations.md › Capacity planning](operations.md#capacity-planning)).
- [ ] Schedule `./scripts/backup.sh` (e.g. a nightly cron job), and test a restore.
- [ ] Watch `/readyz` and the worker heartbeat from your monitoring (Datadog itself works).
- [ ] Optional: connect [Tag Enforcer](tag-enforcer.md#connecting-the-two-apps) for tag-policy verdicts and monitor blind spots,
      and check its card on System Health after the first import.
