"""Inventory synchronization job (executed by the worker container)."""
import logging
import time
from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from . import db, demo, inventory
from .datadog import FETCHERS, Client, SourceError, connection, link

log = logging.getLogger("datadog-search.sync")


def enqueue(trigger: str, requested_by: str = "") -> int:
    with db.conn() as c:
        org_id = db.default_org_id(c)
        running = c.execute(
            "SELECT id FROM sync_jobs WHERE org_id=%s AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", (org_id,)
        ).fetchone()
        if running:
            return running["id"]
        job_id = c.execute(
            "INSERT INTO sync_jobs (org_id, trigger, requested_by) VALUES (%s,%s,%s) RETURNING id",
            (org_id, trigger, requested_by),
        ).fetchone()["id"]
    db.rds.rpush("ds:jobs", job_id)
    return job_id


def run(job_id: int) -> None:
    with db.conn() as c:
        job = c.execute("SELECT * FROM sync_jobs WHERE id=%s", (job_id,)).fetchone()
        if not job or job["status"] not in ("queued",):
            return
        c.execute("UPDATE sync_jobs SET status='running', started_at=now() WHERE id=%s", (job_id,))
    conn = connection(job["org_id"])
    counts: dict[str, int] = {}
    errors = 0
    if not conn["configured"]:
        _error(job_id, "connection", "permission_denied", "Datadog API and application keys are not configured")
        _finish(job_id, "failed", counts)
        return
    version = int(time.time() * 1000)
    org_id = conn["org_id"]
    with db.conn() as c:
        synced_before = {r["source"] for r in c.execute(
            "SELECT source FROM source_status WHERE org_id=%s AND last_success IS NOT NULL", (org_id,))}
    change_counts: dict[str, int] = {}
    write_stats: dict[str, dict] = {}
    skip = set() if db.get_setting("track_ephemeral_changes", True) else set(inventory.EPHEMERAL_TYPES)
    with Client(conn) as client:
        for source in conn["sources"]:
            if source not in FETCHERS:
                continue
            started = time.time()
            # The first successful sync of a source is the baseline: don't report every record as "added".
            tracker = inventory.ChangeTracker(org_id, job_id, track_added=source in synced_before, skip_types=skip)
            try:
                records = list(getattr(client, FETCHERS[source])())
                with db.conn() as c, c.transaction():
                    stats = inventory.apply_records(c, org_id, "Datadog", source, records, version, tracker)
                    _source_ok(c, org_id, source, stats["records"])
                counts[source] = stats["records"]
                write_stats[source] = stats
                for k, v in tracker.counts.items():
                    change_counts[k] = change_counts.get(k, 0) + v
                log.info("synced %s: %s records (written %s, touched %s, unchanged %s, pruned %s; changes %s) in %.1fs",
                         source, stats["records"], stats["written"], stats["touched"], stats["unchanged"], stats["pruned"],
                         tracker.counts, time.time() - started)
            except SourceError as e:
                errors += 1
                _error(job_id, source, e.category, str(e))
                _source_fail(org_id, source, e.category, str(e))
            except Exception as e:  # noqa: BLE001 - record any adapter failure as a partial error
                log.exception("sync %s failed", source)
                errors += 1
                _error(job_id, source, "error", f"{type(e).__name__}: {e}"[:500])
                _source_fail(org_id, source, "error", str(e)[:500])
    with db.conn() as c, c.transaction():
        if "tags" in conn["sources"]:
            tag_recs = inventory.tag_records(c, org_id, "Datadog", lambda t: link(conn["site"], "Tag", t))
            stats = inventory.apply_records(c, org_id, "Datadog", "tags", tag_recs, version, None)
            counts["tags"] = stats["records"]
            write_stats["tags"] = stats
            _source_ok(c, org_id, "tags", counts["tags"])
        else:
            c.execute("DELETE FROM resources WHERE org_id=%s AND source='Datadog' AND type='Tag'", (org_id,))
        # A disabled source's records are dropped (configuration change, so not recorded as "removed" in history).
        disabled = [k for k in FETCHERS if k not in conn["sources"]]
        if disabled:
            n = c.execute("DELETE FROM resources WHERE org_id=%s AND source='Datadog' AND collector = ANY(%s)",
                          (org_id, disabled)).rowcount
            if n:
                log.info("removed %s records from disabled sources %s", n, disabled)
        inventory.rebuild_relationships(c, org_id)
    real = sum(v for k, v in counts.items() if k != "tags")
    if real and db.get_setting("auto_purge_demo", True):
        removed = demo.purge()
        if removed:
            log.info("real Datadog data synced; removed %s DEMO records", removed)
            db.audit("system", "demo.auto_purge", f"job {job_id}", {"records": removed})
    db.bump_data_version()
    status = "success" if not errors else ("partial" if real else "failed")
    counts["changes"] = sum(change_counts.values())
    counts["rows_written"] = sum(s["written"] for s in write_stats.values())
    counts["rows_unchanged"] = sum(s["unchanged"] + s["touched"] for s in write_stats.values())
    _finish(job_id, status, counts)
    db.audit("system", "sync.finished", f"job {job_id}", {"status": status, "counts": counts, "changes": change_counts, "errors": errors})


def _finish(job_id, status, counts):
    with db.conn() as c:
        c.execute("UPDATE sync_jobs SET status=%s, finished_at=now(), counts=%s WHERE id=%s", (status, Jsonb(counts), job_id))
    db.rds.set("ds:last_sync", datetime.now(timezone.utc).isoformat())


def _error(job_id, source, category, message):
    with db.conn() as c:
        c.execute("INSERT INTO sync_errors (job_id, source, category, message) VALUES (%s,%s,%s,%s)",
                  (job_id, source, category, message[:1000]))


def _source_ok(c, org_id, source, n):
    c.execute(
        """INSERT INTO source_status (org_id, source, last_success, last_attempt, last_error, category, record_count)
           VALUES (%s,%s,now(),now(),'','',%s) ON CONFLICT (org_id, source) DO UPDATE SET
           last_success=now(), last_attempt=now(), last_error='', category='', record_count=EXCLUDED.record_count""",
        (org_id, source, n),
    )


def _source_fail(org_id, source, category, message):
    with db.conn() as c:
        c.execute(
            """INSERT INTO source_status (org_id, source, last_attempt, last_error, category) VALUES (%s,%s,now(),%s,%s)
               ON CONFLICT (org_id, source) DO UPDATE SET last_attempt=now(), last_error=EXCLUDED.last_error, category=EXCLUDED.category""",
            (org_id, source, message[:500], category),
        )
