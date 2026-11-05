"""Change history: what changed between syncs, and a per-resource timeline."""
import csv
import io
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .. import db, query, security
from ..inventory import resource_key

router = APIRouter(prefix="/api/v1", tags=["changes"])
CHANGES = ["added", "removed", "status", "tags", "ips", "aliases", "renamed"]


def _since(since: str | None, hours: float | None) -> datetime:
    if since:
        try:
            dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            raise HTTPException(400, "since must be an ISO-8601 timestamp") from None
    return datetime.now(timezone.utc) - timedelta(hours=hours or 24)


@router.get("/changes")
def changes(
    since: str | None = None, hours: float | None = Query(None, gt=0, le=24 * 400),
    change: list[str] = Query(default=[]), type: list[str] = Query(default=[]),
    q: str = Query("", max_length=200), page: int = Query(1, ge=1), page_size: int = Query(100, ge=1, le=1000),
    format: str = "json", user: dict = Depends(security.require("search")),
):
    start = _since(since, hours)
    where = ["c.at >= %s"]
    params: list = [start]
    if change:
        where.append("c.change = ANY(%s)"); params.append(change)
    if type:
        where.append("c.type = ANY(%s)"); params.append(type)
    if q.strip():
        like = "%" + query.like_escape(q.strip().lower()) + "%"
        where.append("""(lower(c.name) LIKE %s ESCAPE '\\' OR lower(c.summary) LIKE %s ESCAPE '\\'
                         OR lower(c.resource_key) LIKE %s ESCAPE '\\' OR lower(COALESCE(c.before::text,'')) LIKE %s ESCAPE '\\')""")
        params += [like, like, like, like]
    w = " AND ".join(where)
    with db.conn() as c:
        summary = {r["change"]: r["n"] for r in c.execute(
            f"SELECT change, count(*) AS n FROM resource_changes c WHERE {w} GROUP BY change", params)}
        by_type = {r["type"]: r["n"] for r in c.execute(
            f"SELECT type, count(*) AS n FROM resource_changes c WHERE {w} GROUP BY type ORDER BY 2 DESC", params)}
        limit = 50000 if format == "csv" else page_size
        rows = c.execute(
            f"""SELECT c.id, c.at, c.resource_id, c.resource_key, c.source, c.type, c.name, c.change, c.summary, c.before, c.after,
                       c.job_id, r.status AS current_status, r.status_group AS current_status_group, count(*) OVER() AS total
                FROM resource_changes c LEFT JOIN resources r ON r.id = c.resource_id
                WHERE {w} ORDER BY c.at DESC, c.id DESC LIMIT %s OFFSET %s""",
            [*params, limit, 0 if format == "csv" else (page - 1) * page_size]).fetchall()
    total = rows[0]["total"] if rows else 0
    for r in rows:
        r.pop("total", None)
    if format == "csv":
        buf = io.StringIO()
        w_ = csv.writer(buf)
        w_.writerow(["at", "change", "type", "name", "summary", "source", "resource_key"])
        for r in rows:
            w_.writerow([r["at"].isoformat(), r["change"], r["type"], r["name"], r["summary"], r["source"], r["resource_key"]])
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="datadog-changes.csv"'})
    return {"since": start, "summary": {k: summary.get(k, 0) for k in CHANGES}, "by_type": by_type,
            "rows": rows, "total": total, "page": page, "page_size": page_size}


@router.get("/resources/{rid}/history")
def resource_history(rid: int, user: dict = Depends(security.require("inspect"))):
    with db.conn() as c:
        r = c.execute("SELECT source, type, external_id, first_indexed FROM resources WHERE id=%s", (rid,)).fetchone()
        if not r:
            raise HTTPException(404, "Resource not found")
        key = resource_key(r["source"], r["type"], r["external_id"])
        rows = c.execute(
            """SELECT id, at, change, summary, before, after FROM resource_changes
               WHERE resource_id=%s OR resource_key=%s ORDER BY at DESC, id DESC LIMIT 500""", (rid, key)).fetchall()
    return {"first_indexed": r["first_indexed"], "changes": rows}
