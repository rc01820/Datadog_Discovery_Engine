"""Bulk lookup: resolve a pasted list of IPs, hostnames, instance IDs, MACs or container IDs in one go."""
import csv
import io
import ipaddress
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import db, security

router = APIRouter(prefix="/api/v1", tags=["bulk"])

MAX_ITEMS = 2000
MAX_MATCHES = 20
SPLIT_RE = re.compile(r"[\s,;|]+")
INSTANCE_RE = re.compile(r"^i-[0-9a-f]{8,17}$", re.I)
MAC_RE = re.compile(r"^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$", re.I)
CONTAINER_RE = re.compile(r"^[0-9a-f]{12}$|^[0-9a-f]{64}$", re.I)

COLS = "r.id, r.type, r.name, r.status, r.status_group, r.ips, r.aliases, r.external_id, r.source, r.deep_link"


class BulkIn(BaseModel):
    text: str = Field(max_length=200_000)
    short_names: bool = True          # also match "web01" <-> "web01.corp.example.com"
    include_tags: bool = False        # Tag entities are excluded unless asked for
    format: str = Field("json", pattern="^(json|csv)$")


def parse_items(text: str) -> list[str]:
    seen, out = set(), []
    for raw in SPLIT_RE.split(text or ""):
        item = raw.strip().strip("\"'`[]()<>").rstrip(".")
        if not item or item.startswith("#"):
            continue
        key = item.lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def classify(item: str) -> str:
    try:
        ipaddress.ip_address(item)
        return "ip"
    except ValueError:
        pass
    if "/" in item:
        try:
            ipaddress.ip_network(item, strict=False)
            return "cidr"
        except ValueError:
            pass
    if INSTANCE_RE.match(item):
        return "instance_id"
    if MAC_RE.match(item):
        return "mac"
    if CONTAINER_RE.match(item):
        return "container_id"
    return "hostname"


def _matched_on(row: dict, item: str, kind: str) -> str:
    low = item.lower()
    if kind in ("ip", "cidr"):
        return "ip"
    if row["name"].lower() == low:
        return "name"
    if any(a.lower() == low for a in row["aliases"] or []):
        return "alias"
    if (row["external_id"] or "").lower() == low:
        return "id"
    return "short name"


def lookup(c, org_id: int, item: str, short_names: bool, include_tags: bool) -> dict:
    kind = classify(item)
    low = item.lower()
    type_filter = "" if include_tags else "AND r.type <> 'Tag'"
    if kind == "ip":
        rows = c.execute(f"SELECT {COLS} FROM resources r WHERE r.org_id=%s AND %s = ANY(r.ips) {type_filter} ORDER BY r.type, r.name LIMIT %s",
                         (org_id, str(ipaddress.ip_address(item)), MAX_MATCHES + 1)).fetchall()
    elif kind == "cidr":
        net = str(ipaddress.ip_network(item, strict=False))
        rows = c.execute(f"""SELECT {COLS} FROM resources r WHERE r.org_id=%s {type_filter}
                             AND EXISTS (SELECT 1 FROM unnest(r.ips) x(v) WHERE x.v::inet <<= %s::inet)
                             ORDER BY r.type, r.name LIMIT %s""", (org_id, net, MAX_MATCHES + 1)).fetchall()
    else:
        rows = c.execute(f"""SELECT {COLS} FROM resources r WHERE r.org_id=%s {type_filter}
                             AND (lower(r.name) = %s OR lower(r.external_id) = %s
                                  OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE lower(a) = %s))
                             ORDER BY r.type, r.name LIMIT %s""", (org_id, low, low, low, MAX_MATCHES + 1)).fetchall()
        if not rows and short_names and kind == "hostname":
            short = low.split(".", 1)[0]
            if short:
                rows = c.execute(f"""SELECT {COLS} FROM resources r WHERE r.org_id=%s {type_filter}
                                     AND (split_part(lower(r.name), '.', 1) = %s
                                          OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE split_part(lower(a), '.', 1) = %s))
                                     ORDER BY r.type, r.name LIMIT %s""", (org_id, short, short, MAX_MATCHES + 1)).fetchall()
    truncated = len(rows) > MAX_MATCHES
    rows = rows[:MAX_MATCHES]
    matches = [{**{k: r[k] for k in ("id", "type", "name", "status", "status_group", "ips", "source", "deep_link")},
                "matched_on": _matched_on(r, item, kind)} for r in rows]
    previously = None
    if not matches and kind != "cidr":
        prev = c.execute(
            """SELECT at, type, name, summary FROM resource_changes WHERE org_id=%s AND change='removed'
                 AND (lower(name) = %s OR before->'ips' ? %s OR EXISTS (
                      SELECT 1 FROM jsonb_array_elements_text(COALESCE(before->'aliases','[]'::jsonb)) a WHERE lower(a) = %s))
               ORDER BY at DESC LIMIT 1""", (org_id, low, item, low)).fetchone()
        if prev:
            previously = prev
    if matches:
        result = "found" if len(matches) == 1 else "multiple"
    else:
        result = "removed" if previously else "not_found"
    return {"input": item, "kind": kind, "result": result, "matches": matches, "truncated": truncated, "previously": previously}


@router.post("/bulk-lookup")
def bulk_lookup(body: BulkIn, user: dict = Depends(security.require("search"))):
    if body.format == "csv" and "export" not in user["permissions"]:
        raise HTTPException(403, "Permission 'export' required")
    items = parse_items(body.text)
    if not items:
        raise HTTPException(400, "Paste at least one IP, hostname or ID")
    if len(items) > MAX_ITEMS:
        raise HTTPException(400, f"Too many items ({len(items)}); the maximum is {MAX_ITEMS} per lookup")
    started = time.perf_counter()
    with db.conn() as c, c.transaction():
        c.execute("SET LOCAL statement_timeout = '30s'")
        org_id = db.default_org_id(c)
        results = [lookup(c, org_id, it, body.short_names, body.include_tags) for it in items]
    took = round((time.perf_counter() - started) * 1000, 1)
    summary = {k: sum(1 for r in results if r["result"] == k) for k in ("found", "multiple", "not_found", "removed")}
    with db.conn() as c:
        c.execute("INSERT INTO search_audit (user_id, username, query, scope, result_count, took_ms) VALUES (%s,%s,%s,%s,%s,%s)",
                  (user["id"], user["username"], f"[bulk lookup: {len(items)} items] " + " ".join(items[:20])[:400], "Bulk",
                   summary["found"] + summary["multiple"], int(took)))
    if body.format == "csv":
        db.audit(user["username"], "bulk_lookup.export", f"{len(items)} items", summary, user["ip"])
        return Response(to_csv(results), media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="bulk-lookup.csv"'})
    return {"items": len(items), "summary": summary, "took_ms": took, "results": results}


def _safe(v) -> str:
    s = str(v if v is not None else "")
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


def to_csv(results: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["input", "kind", "result", "match_count", "name", "type", "status", "ips", "matched_on", "source", "deep_link",
                "previously_removed_at", "previously_summary"])
    for r in results:
        prev = r["previously"] or {}
        if not r["matches"]:
            w.writerow([_safe(x) for x in (r["input"], r["kind"], r["result"], 0, "", "", "", "", "", "", "",
                                            prev.get("at", ""), prev.get("summary", ""))])
        for m in r["matches"]:
            w.writerow([_safe(x) for x in (r["input"], r["kind"], r["result"], len(r["matches"]), m["name"], m["type"], m["status"],
                                            ";".join(m["ips"]), m["matched_on"], m["source"], m["deep_link"], "", "")])
    return buf.getvalue()
