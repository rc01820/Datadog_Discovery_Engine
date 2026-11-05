import csv
import hashlib
import io
import json
import math
import time
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from .. import datadog, db, query, security
from ..inventory import TYPES

router = APIRouter(prefix="/api/v1", tags=["search"])

SUMMARY_COLS = """r.id, r.type, r.name, r.status, r.status_group, r.ips, r.tags, r.aliases, r.env, r.os, r.vendor, r.model,
    r.source, r.external_id, r.deep_link, r.agent_version, r.last_observed, r.last_indexed"""
SORTS = {"name": "lower(r.name)", "type": "r.type", "ip": "r.ips[1]", "last_seen": "r.last_observed",
         "status": "CASE r.status_group WHEN 'alert' THEN 0 WHEN 'warn' THEN 1 WHEN 'unknown' THEN 2 WHEN 'muted' THEN 3 ELSE 4 END"}
STATUS_GROUPS = ["ok", "alert", "warn", "muted", "unknown"]
MAX_EXPORT = 50000


def _stale_cutoff() -> datetime:
    hours = float(db.get_setting("stale_after_hours", 24) or 24)
    return datetime.now(timezone.utc) - timedelta(hours=hours)


def summarize(row: dict, cutoff: datetime, matched_alias: str | None = None) -> dict:
    row = dict(row)
    row["matched_alias"] = matched_alias
    seen = row.get("last_observed")
    row["stale"] = bool(seen and seen < cutoff and row["type"] not in ("Tag", "Dashboard", "Service"))
    return row


def _compile(q: str) -> tuple[str, list, object]:
    try:
        node = query.parse(q)
    except query.QueryError as e:
        raise HTTPException(400, str(e)) from None
    params: list = []
    return query.compile_sql(node, params), params, node


def _filters(scope: str, types: list[str], status: list[str], env: list[str], tags: list[str]):
    """Return (type_clause, other_clause, params_type, params_other)."""
    tclause, tparams = [], []
    if scope and scope != "All":
        if scope not in TYPES:
            raise HTTPException(400, "Unknown scope")
        tclause.append("r.type = %s"); tparams.append(scope)
    if types:
        tclause.append("r.type = ANY(%s)"); tparams.append(types)
    oclause, oparams = [], []
    if status:
        oclause.append("r.status_group = ANY(%s)"); oparams.append(status)
    if env:
        oclause.append("r.env = ANY(%s)"); oparams.append(env)
    if tags:
        oclause.append("r.tags @> %s"); oparams.append(tags)
    return (" AND ".join(tclause) or "TRUE"), tparams, (" AND ".join(oclause) or "TRUE"), oparams


def _run(c, sql: str, params: list):
    try:
        return c.execute(sql, params).fetchall()
    except psycopg.errors.InvalidRegularExpression as e:
        raise HTTPException(400, f"Invalid regular expression: {e.diag.message_primary}") from None
    except psycopg.errors.QueryCanceled:
        raise HTTPException(400, "Search timed out; narrow the expression or simplify the regular expression") from None
    except psycopg.errors.InvalidTextRepresentation as e:
        raise HTTPException(400, f"Invalid value: {e.diag.message_primary}") from None


@router.get("/search")
def search(
    q: str = "", scope: str = "All", types: list[str] = Query(default=[]), status: list[str] = Query(default=[]),
    env: list[str] = Query(default=[]), tags: list[str] = Query(default=[]), sort: str = "name", dir: str = "asc",
    page: int = Query(1, ge=1, le=10000), page_size: int = Query(10, ge=1, le=200), record: bool = False,
    user: dict = Depends(security.require("search")),
):
    started = time.perf_counter()
    where_q, pq, node = _compile(q)
    tclause, tparams, oclause, oparams = _filters(scope, types, status, env, tags)
    order = SORTS.get(sort, SORTS["name"]) + (" DESC" if dir == "desc" else " ASC") + " NULLS LAST, r.id"
    cache_key = "ds:search:" + hashlib.sha256(json.dumps(
        [db.data_version(), q, scope, types, status, env, tags, sort, dir, page, page_size]).encode()).hexdigest()
    cached = None
    try:
        cached = db.rds.get(cache_key)
    except Exception:  # noqa: BLE001 - cache is optional
        pass
    if cached:
        out = json.loads(cached)
        out["cached"] = True
    else:
        with db.conn() as c, c.transaction():
            c.execute("SET LOCAL statement_timeout = '5s'")
            org = db.default_org_id(c)
            base = f"r.org_id = %s AND ({where_q})"
            bp = [org, *pq]
            rows = _run(c, f"""SELECT {SUMMARY_COLS}, count(*) OVER() AS total FROM resources r
                     WHERE {base} AND {tclause} AND {oclause} ORDER BY {order} LIMIT %s OFFSET %s""",
                        [*bp, *tparams, *oparams, page_size, (page - 1) * page_size])
            total = rows[0]["total"] if rows else 0
            if not rows and page > 1:
                total = _run(c, f"SELECT count(*) AS n FROM resources r WHERE {base} AND {tclause} AND {oclause}",
                             [*bp, *tparams, *oparams])[0]["n"]
            type_counts = {r["type"]: r["n"] for r in _run(
                c, f"SELECT r.type, count(*) AS n FROM resources r WHERE {base} AND {oclause} GROUP BY r.type", [*bp, *oparams])}
            st = {r["k"]: r["n"] for r in _run(
                c, f"SELECT r.status_group AS k, count(*) AS n FROM resources r WHERE {base} AND {tclause} GROUP BY 1", [*bp, *tparams])}
            envs = _run(c, f"""SELECT r.env AS k, count(*) AS n FROM resources r WHERE {base} AND {tclause} AND r.env <> ''
                        GROUP BY 1 ORDER BY 2 DESC LIMIT 20""", [*bp, *tparams])
            tag_f = _run(c, f"""SELECT t AS k, count(*) AS n FROM resources r, unnest(r.tags) t
                         WHERE {base} AND {tclause} AND r.type <> 'Tag' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 200""", [*bp, *tparams])
        cutoff = _stale_cutoff()
        out = {
            "results": [summarize({k: v for k, v in r.items() if k != "total"}, cutoff,
                                  matched_alias=query.matching_alias(node, r["aliases"])) for r in rows],
            "total": total, "page": page, "page_size": page_size, "pages": max(1, math.ceil(total / page_size)),
            "type_counts": {t: type_counts.get(t, 0) for t in TYPES},
            "facets": {"status": {s: st.get(s, 0) for s in STATUS_GROUPS},
                       "env": [{"value": r["k"], "count": r["n"]} for r in envs],
                       "tags": [{"value": r["k"], "count": r["n"]} for r in tag_f]},
            "query": {"raw": q, "normalized": str(node) if node else "", "terms": len(query.terms_of(node))},
            "cached": False,
        }
        try:
            db.rds.setex(cache_key, 30, json.dumps(out, default=str))
        except Exception:  # noqa: BLE001
            pass
    out["took_ms"] = round((time.perf_counter() - started) * 1000, 1)
    if record and q.strip():
        with db.conn() as c:
            c.execute("INSERT INTO search_audit (user_id, username, query, scope, result_count, took_ms) VALUES (%s,%s,%s,%s,%s,%s)",
                      (user["id"], user["username"], q[:500], scope, out["total"], int(out["took_ms"])))
    return out


@router.get("/facets")
def facets(user: dict = Depends(security.require("search"))):
    with db.conn() as c:
        types = {r["type"]: r["n"] for r in c.execute("SELECT type, count(*) AS n FROM resources GROUP BY type")}
        st = {r["status_group"]: r["n"] for r in c.execute("SELECT status_group, count(*) AS n FROM resources GROUP BY 1")}
    return {"types": {t: types.get(t, 0) for t in TYPES}, "status": {s: st.get(s, 0) for s in STATUS_GROUPS}}


FIELD_HELP = [
    ("name:", "Resource name (supports * ? wildcards)"), ("ip:", "IP address, wildcard or CIDR e.g. 10.10.50.0/24"),
    ("tag:", "Tag key or key:value"), ("type:", "host, device, monitor, tag, service, synthetic, dashboard, vmware, cloud"),
    ("status:", "ok, alert, warn, muted, unknown"), ("env:", "Environment"), ("vendor:", "Device vendor"),
    ("os:", "Operating system"),
    ("alias:", "Host alias: AWS instance ID, EC2/RDS DNS name or Name tag (e.g. alias:i-0abc*)"), ("regex:", "Regular expression, e.g. regex:name:^eoc-.*"),
    ("has:", "Field or tag key is present, e.g. has:ip"), ("missing:", "Field or tag key is absent, e.g. missing:env"),
]


@router.get("/suggest")
def suggest(prefix: str = Query("", max_length=200), user: dict = Depends(security.require("search"))):
    word = prefix.split()[-1] if prefix and not prefix.endswith(" ") else ""
    neg = word.startswith("-")
    word = word.lstrip("-")
    out: list[dict] = []
    if word.upper() in ("AND", "OR", "NOT"):
        return {"word": word, "suggestions": []}
    low = word.lower()
    field, _, val = low.partition(":") if ":" in low else ("", "", low)
    like = query.like_escape(val) + "%"
    with db.conn() as c:
        if not field:
            out += [{"value": f, "label": f, "hint": h, "kind": "field"} for f, h in FIELD_HELP if f.startswith(low) and low]
            if low:
                for r in c.execute("SELECT DISTINCT name, type FROM resources WHERE lower(name) LIKE %s ESCAPE '\\' AND type <> 'Tag' ORDER BY name LIMIT 6",
                                   (query.like_escape(low) + "%",)):
                    out.append({"value": r["name"], "label": r["name"], "hint": r["type"], "kind": "name"})
                for r in c.execute("SELECT name FROM resources WHERE type='Tag' AND lower(name) LIKE %s ESCAPE '\\' ORDER BY name LIMIT 6",
                                   (query.like_escape(low) + "%",)):
                    out.append({"value": r["name"], "label": r["name"], "hint": "tag", "kind": "tag"})
                out += _alias_suggestions(c, query.like_escape(low) + "%", 6)
        elif field == "tag":
            for r in c.execute("SELECT name FROM resources WHERE type='Tag' AND lower(name) LIKE %s ESCAPE '\\' ORDER BY name LIMIT 10", (like,)):
                out.append({"value": "tag:" + r["name"], "label": r["name"], "hint": "tag", "kind": "tag"})
        elif field in ("alias", "aliases", "aws"):
            out += _alias_suggestions(c, like, 10)
        elif field == "type":
            out += [{"value": f"type:{t.lower()}", "label": t, "hint": "type", "kind": "value"} for t in TYPES if t.lower().startswith(val)]
        elif field == "status":
            out += [{"value": f"status:{s}", "label": s, "hint": "status", "kind": "value"} for s in STATUS_GROUPS if s.startswith(val)]
        elif field in ("name", "env", "vendor", "os"):
            col = {"name": "name", "env": "env", "vendor": "vendor", "os": "os"}[field]
            for r in c.execute(f"SELECT DISTINCT {col} AS v FROM resources WHERE {col} <> '' AND lower({col}) LIKE %s ESCAPE '\\' AND type <> 'Tag' ORDER BY 1 LIMIT 10", (like,)):
                v = r["v"]
                out.append({"value": f'{field}:"{v}"' if " " in v else f"{field}:{v}", "label": v, "hint": field, "kind": "value"})
        elif field in ("has", "missing"):
            opts = ["ip", "alias", "os", "env", "vendor", "agent", "tags", "app", "costcenter", "team"]
            out += [{"value": f"{field}:{o}", "label": o, "hint": field, "kind": "value"} for o in opts if o.startswith(val)]
    if neg:
        for s in out:
            s["value"] = "-" + s["value"]
    return {"word": ("-" if neg else "") + word, "suggestions": out[:12]}


def _alias_suggestions(c, like: str, limit: int) -> list[dict]:
    rows = c.execute(
        """SELECT DISTINCT ON (lower(a)) a, r.name FROM resources r, unnest(r.aliases) a
           WHERE lower(a) LIKE %s ESCAPE '\\' ORDER BY lower(a) LIMIT %s""", (like, limit)).fetchall()
    return [{"value": f"alias:{r['a']}", "label": r["a"], "hint": f"alias of {r['name']}", "kind": "alias"} for r in rows]


@router.get("/export")
def export(
    q: str = "", scope: str = "All", types: list[str] = Query(default=[]), status: list[str] = Query(default=[]),
    env: list[str] = Query(default=[]), tags: list[str] = Query(default=[]), ids: list[int] = Query(default=[]),
    format: str = "csv", user: dict = Depends(security.require("export")),
):
    if format not in ("csv", "json"):
        raise HTTPException(400, "format must be csv or json")
    where_q, pq, _ = _compile(q)
    tclause, tparams, oclause, oparams = _filters(scope, types, status, env, tags)
    extra, ep = ("r.id = ANY(%s)", [ids]) if ids else ("TRUE", [])
    with db.conn() as c, c.transaction():
        c.execute("SET LOCAL statement_timeout = '15s'")
        org = db.default_org_id(c)
        rows = _run(c, f"""SELECT {SUMMARY_COLS} FROM resources r WHERE r.org_id=%s AND ({where_q}) AND {tclause} AND {oclause}
                    AND {extra} ORDER BY r.type, lower(r.name) LIMIT {MAX_EXPORT}""", [org, *pq, *tparams, *oparams, *ep])
    db.audit(user["username"], "search.export", q[:200], {"format": format, "rows": len(rows), "selected": len(ids)}, user["ip"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    if format == "json":
        return Response(json.dumps(rows, default=str, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="datadog-search-{stamp}.json"'})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["name", "type", "status", "ips", "aliases", "env", "os", "vendor", "tags", "source", "external_id", "last_observed", "deep_link"])
    for r in rows:
        w.writerow([_csv_safe(v) for v in (r["name"], r["type"], r["status"], ";".join(r["ips"]), ";".join(r["aliases"]), r["env"], r["os"], r["vendor"],
                                           ";".join(r["tags"]), r["source"], r["external_id"], r["last_observed"] or "", r["deep_link"])])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="datadog-search-{stamp}.csv"'})


def _csv_safe(v) -> str:
    """Neutralize spreadsheet formula injection."""
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s
