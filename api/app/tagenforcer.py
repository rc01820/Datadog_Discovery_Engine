"""Tag Enforcer integration: import tag-policy verdicts into Discovery.

Tag Enforcer stays the authority on whether a resource is tagged correctly;
Discovery reads its `GET /api/compliance/resources` and stores one verdict per
matching resource in `tag_compliance`. That makes the verdict searchable
(`compliant:no`, `tagissue:missing_required:service`, `blindspot:yes`),
visible in the inspector, and joinable with monitor scope to find blind spots.

The import runs after every Datadog sync, on a timer in the worker, and on
demand from System Health. A failed import never affects a sync: the previous
verdicts stay in place and the failure is recorded in tag_enforcer_imports.
"""
from __future__ import annotations

import logging
import time

import httpx
from psycopg.types.json import Jsonb

from . import db
from .config import settings
from .tagpolicy import TE_TO_DISCOVERY, blind_spots, issues_from, match_ids, monitor_scopes

log = logging.getLogger("datadog-search.tagenforcer")

PAGE = 2000
MAX_RESOURCES = 1_000_000
LOCK = "ds:te_import_lock"
DISCOVERY_TYPES = sorted({t for ts in TE_TO_DISCOVERY.values() for t in ts})


def configured() -> bool:
    return bool(settings.tag_enforcer_url and settings.tag_enforcer_token)


def link(path: str) -> str:
    base = settings.tag_enforcer_public_url
    return f"{base}{path}" if base and path else ""


def fetch(client: httpx.Client) -> tuple[dict | None, list[dict]]:
    """Every resource in Tag Enforcer's latest scan, following next_offset."""
    resources: list[dict] = []
    scan = None
    offset: int | None = 0
    while offset is not None:
        resp = client.get("/api/compliance/resources", params={"offset": offset, "limit": PAGE})
        if resp.status_code in (401, 403):
            raise RuntimeError(f"Tag Enforcer refused the token ({resp.status_code}). Check TAG_ENFORCER_TOKEN "
                               "matches TE_API_TOKEN on the Tag Enforcer side.")
        resp.raise_for_status()
        body = resp.json()
        scan = body.get("scan")
        resources.extend(body.get("resources") or [])
        offset = body.get("next_offset")
        if len(resources) > MAX_RESOURCES:
            raise RuntimeError("Tag Enforcer returned more resources than the import will hold")
    return scan, resources


def _client() -> httpx.Client:
    return httpx.Client(base_url=settings.tag_enforcer_url, timeout=30,
                        headers={"X-TE-Token": settings.tag_enforcer_token,
                                 "User-Agent": "datadog-discovery-engine"})


def run_import(trigger: str = "manual", requested_by: str = "system", fetcher=None) -> dict:
    """Fetch, match and store. Returns the import record. `fetcher` is for tests."""
    if not configured() and fetcher is None:
        return {"status": "skipped", "message": "Tag Enforcer is not configured"}
    try:
        if not db.rds.set(LOCK, "1", nx=True, ex=600):
            return {"status": "skipped", "message": "an import is already running"}
    except Exception:  # noqa: BLE001 - Redis down: proceed without the lock
        pass
    started = time.time()
    with db.conn() as c:
        imp = c.execute("INSERT INTO tag_enforcer_imports (trigger) VALUES (%s) RETURNING id", (trigger,)).fetchone()["id"]
    try:
        if fetcher is not None:
            scan, resources = fetcher()
        else:
            with _client() as client:
                scan, resources = fetch(client)
        if not scan:
            raise RuntimeError("Tag Enforcer has no completed scan yet")
        result = store(scan, resources)
        with db.conn() as c:
            c.execute("""UPDATE tag_enforcer_imports SET status='success', finished_at=now(), te_scan_id=%s, received=%s,
                         matched=%s, unmatched=%s, blind_spots=%s, message=%s WHERE id=%s""",
                      (scan["id"], len(resources), result["matched"], Jsonb(result["unmatched"]),
                       result["blind_spots"], f"imported in {time.time() - started:.1f}s", imp))
        db.bump_data_version()
        db.audit(requested_by, "tag_enforcer.import", f"scan {scan['id']}",
                 {"trigger": trigger, "received": len(resources), **result})
        log.info("imported Tag Enforcer scan %s: %s received, %s matched, %s blind spots",
                 scan["id"], len(resources), result["matched"], result["blind_spots"])
        return {"status": "success", "te_scan_id": scan["id"], "received": len(resources), **result}
    except Exception as e:  # noqa: BLE001 - an import failure must leave the last good verdicts in place
        msg = f"{type(e).__name__}: {e}"[:500]
        log.warning("Tag Enforcer import failed: %s", msg)
        with db.conn() as c:
            c.execute("UPDATE tag_enforcer_imports SET status='failed', finished_at=now(), message=%s WHERE id=%s", (msg, imp))
        return {"status": "failed", "message": msg}
    finally:
        try:
            db.rds.delete(LOCK)
        except Exception:  # noqa: BLE001
            pass


def store(scan: dict, resources: list[dict]) -> dict:
    """Match Tag Enforcer resources to Discovery resources and replace tag_compliance."""
    unmatched: dict[str, int] = {}
    matched = blind = 0
    with db.conn() as c, c.transaction():
        org = db.default_org_id(c)
        rows = c.execute(
            """SELECT id, type, external_id, name, aliases, tags FROM resources
               WHERE org_id=%s AND source <> 'DEMO' AND type = ANY(%s)""", (org, DISCOVERY_TYPES)).fetchall()
        by_ext, by_name, by_alias, tags_of = {}, {}, {}, {}
        for r in rows:
            tags_of[r["id"]] = r["tags"] or []
            by_ext[(r["type"], r["external_id"])] = r["id"]
            if r["type"] in TE_TO_DISCOVERY["host"]:
                by_name.setdefault(r["name"].lower(), []).append(r["id"])
                for a in r["aliases"] or []:
                    by_alias.setdefault(a.lower(), []).append(r["id"])
        monitors = [
            {"id": m["id"], "name": m["name"], "scopes": monitor_scopes(m["query"])}
            for m in c.execute("""SELECT r.id, r.name, m.query FROM resources r JOIN monitors m ON m.resource_id=r.id
                                  WHERE r.org_id=%s""", (org,)).fetchall()
        ]
        monitors = [m for m in monitors if m["scopes"]]
        out: dict[int, tuple] = {}
        for res in resources:
            ids = match_ids(res.get("resource_type", ""), str(res.get("resource_id", "")), by_ext, by_name, by_alias)
            if not ids:
                rtype = res.get("resource_type", "unknown")
                unmatched[rtype] = unmatched.get(rtype, 0) + 1
                continue
            findings = res.get("findings") or []
            issues = issues_from(findings)
            for rid in ids:
                if rid in out:
                    continue
                spots = blind_spots(tags_of.get(rid, []), findings, monitors)
                blind += bool(spots)
                out[rid] = (rid, scan["id"], res["resource_type"], str(res["resource_id"]), bool(res.get("compliant")),
                            int(res.get("error_count") or 0), int(res.get("warning_count") or 0),
                            bool(res.get("remediable")), list(res.get("teams") or []), issues, Jsonb(findings),
                            Jsonb(spots), res.get("path") or "")
        matched = len(out)
        c.execute("DELETE FROM tag_compliance tc USING resources r WHERE tc.resource_id=r.id AND r.org_id=%s", (org,))
        if out:
            with c.cursor() as cur:
                cur.executemany(
                    """INSERT INTO tag_compliance (resource_id, te_scan_id, te_type, te_id, compliant, error_count,
                       warning_count, remediable, teams, issues, findings, blind_spots, te_path)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", list(out.values()))
    return {"matched": matched, "unmatched": unmatched, "blind_spots": blind}


def status() -> dict:
    """For System Health."""
    out = {"configured": configured(), "url": settings.tag_enforcer_url or "not set"}
    with db.conn() as c:
        last = c.execute("SELECT * FROM tag_enforcer_imports ORDER BY id DESC LIMIT 1").fetchone()
        ok = c.execute("SELECT * FROM tag_enforcer_imports WHERE status='success' ORDER BY id DESC LIMIT 1").fetchone()
        n = c.execute("SELECT count(*) AS n, count(*) FILTER (WHERE NOT compliant) AS failing FROM tag_compliance").fetchone()
    out.update({
        "ok": bool(configured() and last and last["status"] in ("success", "skipped")),
        "last_attempt": last["started_at"].isoformat() if last else None,
        "last_status": last["status"] if last else "never run",
        "last_message": last["message"] if last else "",
        "last_success": ok["finished_at"].isoformat() if ok and ok["finished_at"] else None,
        "tag_enforcer_scan": ok["te_scan_id"] if ok else None,
        "evaluated_resources": n["n"], "failing_policy": n["failing"],
        "unmatched": ", ".join(f"{k} {v}" for k, v in sorted((ok["unmatched"] or {}).items())) if ok else "",
        "blind_spots": ok["blind_spots"] if ok else 0,
    })
    return out
