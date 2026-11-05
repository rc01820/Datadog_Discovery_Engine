"""Change-history roll-off: retention plan, preview, optional archiving to gzip CSV, and purge."""
import csv
import gzip
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import db
from .inventory import EPHEMERAL_TYPES

log = logging.getLogger("datadog-search.history")

ARCHIVE_DIR = Path(os.environ.get("HISTORY_ARCHIVE_DIR", "/archive"))
ARCHIVE_NAME_RE = re.compile(r"^change-history-\d{8}-\d{6}(-[a-z]+)?\.csv\.gz$")
CHUNK = 20000
COLUMNS = ["id", "at", "change", "type", "name", "summary", "source", "resource_key", "resource_id", "job_id", "before", "after"]


def settings() -> dict:
    s = db.all_settings()
    return {
        "history_retention_days": int(s.get("history_retention_days", 365) or 0),
        "ephemeral_history_retention_days": int(s.get("ephemeral_history_retention_days", 14) or 0),
        "history_archive_enabled": bool(s.get("history_archive_enabled", False)),
    }


def plan(cfg: dict | None = None) -> list[tuple[str, str, list]]:
    """Retention rules as (label, SQL condition, params). A value of 0 days means keep forever."""
    cfg = cfg or settings()
    eph = sorted(EPHEMERAL_TYPES)
    rules = []
    if cfg["history_retention_days"] > 0:
        rules.append(("other", "type <> ALL(%s) AND at < now() - make_interval(days => %s)", [eph, cfg["history_retention_days"]]))
    if cfg["ephemeral_history_retention_days"] > 0:
        rules.append(("containers_pods", "type = ANY(%s) AND at < now() - make_interval(days => %s)",
                      [eph, cfg["ephemeral_history_retention_days"]]))
    return rules


def usage() -> dict:
    cfg = settings()
    eph = sorted(EPHEMERAL_TYPES)
    with db.conn() as c:
        row = c.execute(
            """SELECT count(*) AS total,
                      count(*) FILTER (WHERE type = ANY(%s)) AS containers_pods,
                      min(at) AS oldest, max(at) AS newest,
                      pg_total_relation_size('resource_changes') AS bytes
               FROM resource_changes""", (eph,)).fetchone()
        due = {label: c.execute(f"SELECT count(*) AS n FROM resource_changes WHERE {cond}", params).fetchone()["n"]
               for label, cond, params in plan(cfg)}
        by_change = {r["change"]: r["n"] for r in c.execute("SELECT change, count(*) AS n FROM resource_changes GROUP BY 1")}
    return {
        "total": row["total"], "containers_pods": row["containers_pods"], "other": row["total"] - row["containers_pods"],
        "oldest": row["oldest"], "newest": row["newest"], "bytes": row["bytes"], "by_change": by_change,
        "due": {"other": due.get("other", 0), "containers_pods": due.get("containers_pods", 0),
                "total": sum(due.values())},
        "settings": cfg, "last_rolloff": db.get_setting("history_last_rolloff"),
        "archive": {"enabled": cfg["history_archive_enabled"], "dir": str(ARCHIVE_DIR), "writable": archive_writable()},
    }


def archive_writable() -> bool:
    try:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        return os.access(ARCHIVE_DIR, os.W_OK)
    except OSError:
        return False


def _row_out(r: dict) -> list:
    return [r["id"], r["at"].isoformat(), r["change"], r["type"], r["name"], r["summary"], r["source"], r["resource_key"],
            r["resource_id"] or "", r["job_id"] or "",
            json.dumps(r["before"]) if r["before"] is not None else "", json.dumps(r["after"]) if r["after"] is not None else ""]


def purge(trigger: str, username: str = "system") -> dict:
    """Apply the retention plan now. If archiving is on, rows are written to a gzip CSV *before* they are deleted;
    a failure to archive aborts the purge so nothing is lost."""
    cfg = settings()
    rules = plan(cfg)
    result = {"trigger": trigger, "deleted": 0, "by_rule": {}, "archive": None, "at": datetime.now(timezone.utc).isoformat()}
    if not rules:
        db.set_setting("history_last_rolloff", {**result, "note": "keep forever: nothing to roll off"})
        return result
    writer = gz = path = None
    if cfg["history_archive_enabled"]:
        if not archive_writable():
            raise RuntimeError(f"Archive folder {ARCHIVE_DIR} is not writable; nothing was deleted")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path = ARCHIVE_DIR / f"change-history-{stamp}-{trigger}.csv.gz"
        gz = gzip.open(path, "wt", newline="")
        writer = csv.writer(gz)
        writer.writerow(COLUMNS)
    try:
        for label, cond, params in rules:
            n = 0
            while True:
                with db.conn() as c, c.transaction():
                    rows = c.execute(f"""SELECT id, at, change, type, name, summary, source, resource_key, resource_id, job_id, before, after
                                         FROM resource_changes WHERE {cond} ORDER BY id LIMIT {CHUNK}""", params).fetchall()
                    if not rows:
                        break
                    if writer:
                        for r in rows:
                            writer.writerow(_row_out(r))
                        gz.flush()
                    c.execute("DELETE FROM resource_changes WHERE id = ANY(%s)", ([r["id"] for r in rows],))
                    n += len(rows)
            result["by_rule"][label] = n
            result["deleted"] += n
    finally:
        if gz:
            gz.close()
            if result["deleted"] == 0 and path and path.exists():
                path.unlink()  # don't leave empty archives
            elif path:
                result["archive"] = {"file": path.name, "bytes": path.stat().st_size}
    db.set_setting("history_last_rolloff", result)
    if result["deleted"]:
        log.info("history roll-off (%s): deleted %s entries %s%s", trigger, result["deleted"], result["by_rule"],
                 f", archived to {result['archive']['file']}" if result["archive"] else "")
        db.audit(username, "history.rolloff", trigger, result)
    return result


def list_archives() -> list[dict]:
    if not ARCHIVE_DIR.exists():
        return []
    out = []
    for p in sorted(ARCHIVE_DIR.glob("change-history-*.csv.gz"), reverse=True):
        st = p.stat()
        out.append({"file": p.name, "bytes": st.st_size, "created": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()})
    return out


def archive_path(name: str) -> Path | None:
    if not ARCHIVE_NAME_RE.match(name):
        return None
    p = ARCHIVE_DIR / name
    return p if p.is_file() else None
