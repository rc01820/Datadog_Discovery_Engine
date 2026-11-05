import hashlib
import math
import random
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import datadog, db, inventory, security
from .search import SUMMARY_COLS, _stale_cutoff, summarize

router = APIRouter(prefix="/api/v1/resources", tags=["resources"])


def _get(c, rid: int) -> dict:
    row = c.execute(
        f"""SELECT {SUMMARY_COLS}, r.attributes, r.created_at, r.first_indexed, r.org_id, o.name AS org_name,
                   m.monitor_type, m.query AS monitor_query, m.message AS monitor_message, m.muted
            FROM resources r JOIN organizations o ON o.id=r.org_id LEFT JOIN monitors m ON m.resource_id=r.id WHERE r.id=%s""",
        (rid,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Resource not found or no longer indexed")
    return row


@router.get("/{rid}")
def detail(rid: int, user: dict = Depends(security.require("inspect"))):
    with db.conn() as c:
        row = _get(c, rid)
        fav = c.execute("SELECT 1 FROM favorites WHERE user_id=%s AND kind='resource' AND ref=%s", (user["id"], str(rid))).fetchone()
        counts = c.execute(
            """SELECT count(*) FILTER (WHERE relation='monitors') AS monitors FROM resource_relationships WHERE to_id=%s""", (rid,)
        ).fetchone()
    out = summarize(row, _stale_cutoff())
    conn = datadog.connection()
    out["favorite"] = bool(fav)
    out["freshness"] = {
        "mode": "demo" if row["source"] == "DEMO" else "cached",
        "label": "Synthetic demo data" if row["source"] == "DEMO" else "Cached from last sync; refresh for live status",
        "last_indexed": row["last_indexed"], "last_observed": row["last_observed"],
        "inferred_type": bool((row["attributes"] or {}).get("inferred_type")),
    }
    out["links"] = {k: datadog.link(conn["site"], k, row["name"]) for k in ("logs", "metrics")} if row["type"] in ("Host", "VMware", "Cloud") else {}
    out["scope_monitor_count"] = counts["monitors"] if counts else 0
    return out


OUTGOING = {"monitors": "scoped_to", "runs_on": "runs_on", "runs_in": "runs_in", "member_of": "member_of",
            "interface_of": "interface_of", "backed_by": "backed_by"}
INCOMING = {"runs_on": "workloads", "runs_in": "containers", "member_of": "members", "interface_of": "interfaces",
            "backed_by": "synthetic"}


def related_items(c, r: dict, cutoff, structural_only: bool = False, limit: int = 500) -> list[dict]:
    """Resources related to r, each with relation + evidence. structural_only skips shared-app-tag correlation
    (used for 2nd-hop expansion, where it would just repeat the same application group)."""
    rid = r["id"]
    out: list[dict] = []
    seen: set[tuple[int, str]] = set()

    def add(rows, relation, evidence_fn):
        for x in rows:
            key = (x["id"], relation)
            if x["id"] == rid or key in seen or len(out) >= limit:
                continue
            seen.add(key)
            out.append({"relation": relation, "evidence": evidence_fn(x), **summarize(x, cutoff)})

    cols = SUMMARY_COLS
    add(c.execute(f"""SELECT {cols}, rr.evidence FROM resource_relationships rr JOIN resources r ON r.id=rr.from_id
                      WHERE rr.to_id=%s AND rr.relation='monitors'""", (rid,)), "monitor", lambda x: x["evidence"])
    # outgoing: this resource -> parent (monitor scope, runs on host, member of cluster, interface of device...)
    for x in c.execute(f"""SELECT {cols}, rr.evidence, rr.relation AS rel FROM resource_relationships rr
                           JOIN resources r ON r.id=rr.to_id WHERE rr.from_id=%s ORDER BY r.type, r.name LIMIT 300""", (rid,)).fetchall():
        add([x], OUTGOING.get(x["rel"], "scoped_to"), lambda y: y["evidence"])
    # incoming: children (containers in a pod, pods in a cluster, interfaces of a device, synthetics...)
    for x in c.execute(f"""SELECT {cols}, rr.evidence, rr.relation AS rel FROM resource_relationships rr
                           JOIN resources r ON r.id=rr.from_id WHERE rr.to_id=%s AND rr.relation <> 'monitors'
                           ORDER BY r.type, r.name LIMIT 500""", (rid,)).fetchall():
        add([x], INCOMING.get(x["rel"], "child"), lambda y: y["evidence"])
    if not structural_only:
        apps = [t for t in r["tags"] if t.lower().startswith(("app:", "service:"))]
        if r["type"] == "Tag":
            apps = [r["name"]]
        if apps:
            rows = c.execute(f"""SELECT {cols}, (SELECT array_agg(t) FROM unnest(r.tags) t WHERE t = ANY(%s)) AS shared
                                 FROM resources r WHERE r.org_id=%s AND r.tags && %s AND r.type <> 'Tag' AND r.id <> %s
                                 ORDER BY r.type, r.name LIMIT 100""", (apps, r["org_id"], apps, rid)).fetchall()
            add([x for x in rows if x["type"] == "Monitor"], "monitor", lambda x: "shared tag " + ", ".join(x["shared"] or []))
            add([x for x in rows if x["type"] != "Monitor"], "application", lambda x: "shared tag " + ", ".join(x["shared"] or []))
    if r["ips"]:
        add(c.execute(f"""SELECT {cols} FROM resources r WHERE r.org_id=%s AND r.ips && %s AND r.id <> %s AND r.type <> 'Tag' LIMIT 50""",
                      (r["org_id"], r["ips"], rid)), "same_ip",
            lambda x: "shares IP " + ", ".join(sorted(set(x["ips"]) & set(r["ips"]))) + " (not necessarily the same resource)")
    return out


@router.get("/{rid}/related")
def related(rid: int, user: dict = Depends(security.require("inspect"))):
    """Related entities, each carrying the evidence used to correlate it."""
    with db.conn() as c:
        r = _get(c, rid)
        return {"related": related_items(c, r, _stale_cutoff())}


TOPO_MAX_NODES = 300
TOPO_EXPAND = 60        # first-hop neighbours expanded for a 2-hop graph
TOPO_PER_NEIGHBOUR = 30


def _node(x: dict, hop: int) -> dict:
    return {"id": x["id"], "type": x["type"], "name": x["name"], "status": x["status"], "status_group": x["status_group"],
            "ip": (x.get("ips") or [None])[0], "source": x["source"], "deep_link": x["deep_link"], "stale": x.get("stale", False),
            "hop": hop}


@router.get("/{rid}/topology")
def topology(rid: int, hops: int = Query(1, ge=1, le=2), user: dict = Depends(security.require("inspect"))):
    """Graph around one resource: nodes + edges (with relation and evidence), 1 or 2 hops."""
    cutoff = _stale_cutoff()
    with db.conn() as c:
        r = _get(c, rid)
        center = summarize(r, cutoff)
        nodes: dict[int, dict] = {rid: _node(center, 0)}
        edges: list[dict] = []
        pairs: set[frozenset] = set()
        truncated = False

        def link_(a: int, b: int, rel: str, ev: str) -> None:
            key = frozenset((a, b))
            if a != b and key not in pairs:
                pairs.add(key)
                edges.append({"source": a, "target": b, "relation": rel, "evidence": ev})

        first = related_items(c, r, cutoff)
        for x in first:
            nodes.setdefault(x["id"], _node(x, 1))
            link_(rid, x["id"], x["relation"], x["evidence"])
        if hops == 2:
            # expand structural neighbours first (they have the most informative second hop), then the rest
            order = sorted(first, key=lambda x: (x["relation"] in ("application", "monitor"), x["relation"]))
            for x in order[:TOPO_EXPAND]:
                nr = _get(c, x["id"])
                for y in related_items(c, nr, cutoff, structural_only=True, limit=TOPO_PER_NEIGHBOUR):
                    if y["id"] not in nodes:
                        if len(nodes) >= TOPO_MAX_NODES:
                            truncated = True
                            continue
                        nodes[y["id"]] = _node(y, 2)
                    link_(x["id"], y["id"], y["relation"], y["evidence"])
            truncated = truncated or len(first) > TOPO_EXPAND
    return {"center": rid, "hops": hops, "nodes": list(nodes.values()), "edges": edges, "truncated": truncated,
            "center_detail": {"name": center["name"], "type": center["type"], "ips": center["ips"], "tags": center["tags"][:12]}}


@router.post("/{rid}/refresh")
def refresh(rid: int, user: dict = Depends(security.require("inspect"))):
    """On-demand live status lookup against Datadog for monitors; other types report cached state."""
    with db.conn() as c:
        r = _get(c, rid)
    if r["source"] == "DEMO":
        return {"refreshed": False, "reason": "Demo record; no live source", "status": r["status"]}
    if r["type"] != "Monitor":
        return {"refreshed": False, "reason": "Live refresh currently supports monitors; others refresh on the next sync", "status": r["status"]}
    conn = datadog.connection()
    try:
        with datadog.Client(conn, timeout=10) as client:
            m = client.monitor(r["external_id"])
    except datadog.SourceError as e:
        raise HTTPException(502, f"{e.category}: {e}") from None
    state = m.get("overall_state") or "Unknown"
    muted = bool(((m.get("options") or {}).get("silenced") or {}))
    with db.conn() as c:
        c.execute("UPDATE resources SET status=%s, status_group=%s, last_observed=now(), last_indexed=now() WHERE id=%s",
                  (state, inventory.status_group(state, muted), rid))
        if state != r["status"]:
            inventory.ChangeTracker(r["org_id"]).record(
                c, rid, inventory.resource_key(r["source"], r["type"], r["external_id"]), r["source"], r["type"], r["name"],
                "status", {"status": r["status"]}, {"status": state}, f"status {r['status']} → {state} (live refresh by {user['username']})")
    db.bump_data_version()
    return {"refreshed": True, "status": state, "muted": muted}


def _demo_series(seed: str, base: float, spread: float, minutes: int = 60) -> list[list[float]]:
    rng = random.Random(int(hashlib.sha256(seed.encode()).hexdigest()[:8], 16) + int(time.time() // 300))
    now = int(time.time())
    val, pts = base, []
    for i in range(minutes):
        val = max(0.0, min(100.0, val + rng.uniform(-spread, spread) + 0.15 * math.sin(i / 6)))
        pts.append([(now - (minutes - i) * 60) * 1000, round(val, 2)])
    return pts


METRICS = [("CPU user %", "avg:system.cpu.user{host:%s}", 35, 4), ("Memory used %", "avg:system.mem.pct_usable{host:%s}", 60, 2),
           ("Load (1m)", "avg:system.load.1{host:%s}", 20, 3)]


@router.get("/{rid}/metrics")
def metrics(rid: int, user: dict = Depends(security.require("inspect"))):
    with db.conn() as c:
        r = _get(c, rid)
    if r["type"] not in ("Host", "VMware", "Cloud", "Device"):
        return {"mode": "n/a", "series": [], "note": "Metrics are available for hosts and devices"}
    if r["source"] == "DEMO":
        base = 80 if r["status_group"] == "alert" else 55 if r["status_group"] == "warn" else 0
        return {"mode": "demo", "series": [{"name": n, "unit": "%", "points": _demo_series(r["name"] + n, max(b, base), s)}
                                           for n, _, b, s in METRICS]}
    conn = datadog.connection()
    series = []
    try:
        with datadog.Client(conn, timeout=10) as client:
            for name, q, _, _ in METRICS:
                series.append({"name": name, "unit": "", "points": client.metric(q % r["name"])})
    except datadog.SourceError as e:
        return {"mode": "error", "series": series, "note": f"{e.category}: {e}"}
    return {"mode": "live", "series": series}


@router.get("/{rid}/logs")
def logs(rid: int, user: dict = Depends(security.require("inspect"))):
    with db.conn() as c:
        r = _get(c, rid)
    if r["type"] not in ("Host", "VMware", "Cloud", "Service", "Device"):
        return {"mode": "n/a", "logs": [], "note": "Logs are available for hosts, devices and services"}
    key = "service" if r["type"] == "Service" else "host"
    if r["source"] == "DEMO":
        rng = random.Random(r["name"])
        now = datetime.now(timezone.utc)
        msgs = [("info", "Health check passed"), ("info", "Request completed in 112ms"), ("warn", "Slow query detected (2.4s)"),
                ("error", "Connection reset by peer"), ("info", "Agent check run completed"), ("warn", "Disk usage above 80%")]
        return {"mode": "demo", "query": f"{key}:{r['name']}", "logs": [
            {"timestamp": (now - timedelta(seconds=rng.randint(5, 3600))).isoformat(), "status": s, "service": "xyz-web",
             "host": r["name"], "message": m} for s, m in rng.choices(msgs, k=12)]}
    conn = datadog.connection()
    try:
        with datadog.Client(conn, timeout=15) as client:
            items = client.logs(f"{key}:{r['name']}")
    except datadog.SourceError as e:
        return {"mode": "error", "logs": [], "note": f"{e.category}: {e}"}
    return {"mode": "live", "query": f"{key}:{r['name']}", "logs": items}
