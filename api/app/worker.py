"""Background worker: executes queued sync jobs, schedules periodic syncs and enforces retention."""
import logging
import signal
import time
from datetime import datetime, timedelta, timezone

import redis

from . import db, history, sync, tagenforcer
from .datadog import connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("datadog-search.worker")
running = True


def _stop(*_):
    global running
    running = False


def schedule_due() -> None:
    conn = connection()
    if not (conn["configured"] and conn["enabled"]):
        db.rds.delete("ds:next_scheduled_sync")
        return
    interval = timedelta(minutes=conn["sync_interval_minutes"])
    with db.conn() as c:
        last = c.execute("SELECT max(queued_at) AS t FROM sync_jobs WHERE org_id=%s", (conn["org_id"],)).fetchone()["t"]
    nxt = (last + interval) if last else datetime.now(timezone.utc)
    db.rds.set("ds:next_scheduled_sync", nxt.isoformat())
    if datetime.now(timezone.utc) >= nxt:
        job = sync.enqueue("schedule", "scheduler")
        log.info("scheduled sync job %s", job)


def retention() -> None:
    days = int(db.get_setting("audit_retention_days", 365) or 365)
    with db.conn() as c:
        a = c.execute("DELETE FROM audit_events WHERE at < now() - make_interval(days => %s)", (days,)).rowcount
        s = c.execute("DELETE FROM search_audit WHERE at < now() - make_interval(days => %s)", (days,)).rowcount
        j = c.execute("DELETE FROM sync_jobs WHERE queued_at < now() - interval '30 days'").rowcount
        c.execute("DELETE FROM sessions WHERE expires_at < now()")
        # Recover jobs orphaned by a worker restart.
        c.execute("UPDATE sync_jobs SET status='failed', finished_at=now() WHERE status='running' AND started_at < now() - interval '2 hours'")
    if a or s or j:
        log.info("retention removed %s audit events, %s search records, %s sync jobs", a, s, j)
    try:
        history.purge("schedule")
    except RuntimeError as e:
        log.warning("change-history roll-off skipped: %s", e)


def refresh_demo_timestamps() -> None:
    """Keep DEMO records looking live: last_observed = now - their fixed offset (others stay recent)."""
    with db.conn() as c:
        c.execute("""UPDATE resources SET last_observed = now() - make_interval(mins => COALESCE((attributes->>'demo_offset_min')::int, 0))
                     WHERE source='DEMO' AND type <> 'Tag'""")


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    db.open_pool()
    db.wait_for_schema()
    # Re-queue jobs that were queued but never picked up (e.g. Redis restarted).
    with db.conn() as c:
        for j in c.execute("SELECT id FROM sync_jobs WHERE status='queued' ORDER BY id").fetchall():
            db.rds.rpush("ds:jobs", j["id"])
    log.info("worker started")
    last_schedule = last_retention = last_demo = last_te = 0.0
    while running:
        try:
            db.rds.set("ds:worker_heartbeat", datetime.now(timezone.utc).isoformat(), ex=60)
            now = time.time()
            if now - last_schedule > 30:
                schedule_due(); last_schedule = now
            if now - last_demo > 60:
                refresh_demo_timestamps(); last_demo = now
            if now - last_retention > 3600:
                retention(); last_retention = now
            # Tag Enforcer scans on its own schedule; pick up new scans even when no Datadog sync runs.
            if tagenforcer.configured() and now - last_te > 900:
                last_te = now
                tagenforcer.run_import("schedule")
            item = db.rds.blpop(["ds:jobs"], timeout=5)
            if item:
                job_id = int(item[1])
                log.info("running sync job %s", job_id)
                sync.run(job_id)
        except redis.RedisError as e:
            log.warning("redis unavailable: %s", e)
            time.sleep(5)
        except Exception:  # noqa: BLE001 - keep the worker alive
            log.exception("worker loop error")
            time.sleep(5)
    log.info("worker stopped")


if __name__ == "__main__":
    main()
