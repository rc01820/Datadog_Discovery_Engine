"""Normalized resource storage shared by demo seeding and Datadog sync."""
import hashlib
import ipaddress
import json
import re
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

from .query import build_search_blob

TYPES = ["Host", "Device", "Interface", "Monitor", "Tag", "Service", "Synthetic", "Dashboard", "VMware", "Cloud",
         "Cluster", "Pod", "Container", "Database"]
UNTRACKED_TYPES = {"Tag"}
# Short-lived resources: their history can have a shorter retention and can be switched off entirely.
EPHEMERAL_TYPES = {"Container", "Pod"}
# Minimum movement of last_observed before an unchanged record is touched (keeps writes low for values
# that the collector synthesizes as "now", e.g. containers and AWS resources).
SEEN_GRANULARITY = timedelta(minutes=10)
# Per-instance tag keys (unique per pod/container/image build) are still searchable on the resource, but are not
# promoted to Tag entities: in real clusters they would create thousands of one-off tags.
HIGH_CARDINALITY_TAG_KEYS = {"pod_name", "container_id", "container_name", "kube_container_name", "display_container_name",
                             "image_tag", "image_id", "short_image", "kube_replica_set", "docker_image", "pod_phase",
                             "kube_ownerref_name", "interface", "device_name"}  # derived each sync; would only add noise to change history

_STATUS = {
    "up": "ok", "ok": "ok", "live": "ok", "passed": "ok", "active": "ok", "running": "ok", "ready": "ok",
    "alert": "alert", "down": "alert", "critical": "alert", "failed": "alert", "unreachable": "alert",
    "warn": "warn", "warning": "warn", "degraded": "warn", "stale": "warn", "pending": "warn", "restarting": "warn",
    "exited": "alert", "crashloopbackoff": "alert", "dead": "alert", "oomkilled": "alert",
    "muted": "muted", "paused": "muted", "ignored": "muted", "silenced": "muted",
}


def status_group(status: str, muted: bool = False) -> str:
    if muted:
        return "muted"
    return _STATUS.get((status or "").strip().lower(), "unknown")


def clean_ips(values) -> list[str]:
    out: list[str] = []
    for v in values or []:
        try:
            ip = str(ipaddress.ip_address(str(v).strip()))
        except ValueError:
            continue
        if ip not in out and not ip.startswith("127.") and ip != "::1":
            out.append(ip)
    return out


def clean_tags(values) -> list[str]:
    out: list[str] = []
    for v in values or []:
        s = str(v).strip()
        if s and s not in out and len(s) <= 200:
            out.append(s)
    return out


def clean_aliases(values, name: str = "") -> list[str]:
    """Distinct alternate names (instance IDs, cloud DNS names, Name tags), excluding the canonical name."""
    out: list[str] = []
    for v in values or []:
        a = str(v).strip()
        if a and len(a) <= 255 and a.lower() != name.lower() and a not in out:
            out.append(a)
    return out[:50]


def tag_value(tags: list[str], key: str) -> str:
    prefix = key + ":"
    for t in tags:
        if t.lower().startswith(prefix):
            return t[len(prefix):]
    return ""


class ChangeTracker:
    """Records added / removed / changed resources for one sync (or live refresh)."""

    def __init__(self, org_id: int, job_id: int | None = None, track_added: bool = True, skip_types: set[str] | None = None):
        self.org_id, self.job_id, self.track_added = org_id, job_id, track_added
        self.skip_types = skip_types or set()
        self.counts: dict[str, int] = {}

    def record(self, c, rid, key, source, type_, name, change, before, after, summary):
        if type_ in self.skip_types:
            return
        c.execute(
            """INSERT INTO resource_changes (org_id, resource_id, resource_key, source, type, name, change, before, after, summary, job_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (self.org_id, rid, key, source, type_, name[:300], change, Jsonb(before) if before is not None else None,
             Jsonb(after) if after is not None else None, summary[:500], self.job_id),
        )
        self.counts[change] = self.counts.get(change, 0) + 1

    def diff(self, c, rid, key, source, type_, prev, cur):
        if prev is None:
            if self.track_added:
                self.record(c, rid, key, source, type_, cur["name"], "added", None, cur,
                            "first seen" + (f" ({', '.join(cur['ips'][:3])})" if cur["ips"] else ""))
            return
        if prev["name"] != cur["name"]:
            self.record(c, rid, key, source, type_, cur["name"], "renamed", {"name": prev["name"]}, {"name": cur["name"]},
                        f"renamed from {prev['name']}")
        if prev["status"] != cur["status"]:
            self.record(c, rid, key, source, type_, cur["name"], "status", {"status": prev["status"]}, {"status": cur["status"]},
                        f"status {prev['status']} → {cur['status']}")
        for field, change in (("tags", "tags"), ("ips", "ips"), ("aliases", "aliases")):
            old, new = set(prev[field] or []), set(cur[field] or [])
            if old != new:
                added, removed = sorted(new - old), sorted(old - new)
                parts = [f"+{x}" for x in added[:6]] + [f"−{x}" for x in removed[:6]]
                more = len(added) + len(removed) - len(parts)
                self.record(c, rid, key, source, type_, cur["name"], change, {"removed": removed}, {"added": added},
                            f"{field}: " + " ".join(parts) + (f" (+{more} more)" if more > 0 else ""))


def _parse_ts(v) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v, timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _canon(v):
    """Order-insensitive form for hashing: lists of plain values are sorted, recursively."""
    if isinstance(v, dict):
        return {k: _canon(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        items = [_canon(x) for x in v]
        if all(isinstance(x, (str, int, float, bool)) or x is None for x in items):
            return sorted(items, key=lambda x: (str(type(x)), str(x)))
        return items
    return v


def record_hash(rec: dict) -> str:
    """Fingerprint of everything stored for a record except observation timestamps."""
    tags = clean_tags(rec.get("tags"))
    attrs = rec.get("attributes") or {}
    payload = [
        rec["type"], str(rec["external_id"]), rec["name"][:300], rec.get("status") or "Unknown", bool(rec.get("muted")),
        # set-like lists are sorted: Datadog does not return tags/aliases/IPs in a stable order
        sorted(clean_ips(rec.get("ips"))), sorted(tags), sorted(clean_aliases(rec.get("aliases") or attrs.get("aliases"), rec["name"])),
        rec.get("env") or tag_value(tags, "env"), rec.get("os", ""), rec.get("vendor", ""), rec.get("model", ""),
        rec.get("agent_version", ""), rec.get("deep_link", ""), attrs, str(rec.get("created_at") or ""), rec.get("monitor"),
        rec.get("collector", ""),
    ]
    return hashlib.md5(json.dumps(_canon(payload), sort_keys=True, default=str).encode()).hexdigest()


def resource_key(source: str, type_: str, external_id: str) -> str:
    return f"{source}|{type_}|{external_id}"


def upsert(c, org_id: int, source: str, rec: dict, version: int, tracker: ChangeTracker | None = None) -> int:
    tags = clean_tags(rec.get("tags"))
    ips = clean_ips(rec.get("ips"))
    env = rec.get("env") or tag_value(tags, "env")
    status = rec.get("status") or "Unknown"
    muted = bool(rec.get("muted"))
    attrs = rec.get("attributes") or {}
    aliases = clean_aliases(rec.get("aliases") or attrs.get("aliases"), rec["name"])
    prev = None
    if tracker and rec["type"] not in UNTRACKED_TYPES:
        prev = c.execute(
            "SELECT name, status, tags, ips, aliases FROM resources WHERE org_id=%s AND source=%s AND type=%s AND external_id=%s",
            (org_id, source, rec["type"], str(rec["external_id"]))).fetchone()
    blob = build_search_blob(rec["name"], str(rec["external_id"]), rec["type"], status, ips, tags, env,
                             rec.get("os", ""), rec.get("vendor", ""), rec.get("model", ""), " ".join(aliases))
    row = c.execute(
        """INSERT INTO resources (org_id, source, type, external_id, name, status, status_group, ips, tags, aliases, env, os,
               vendor, model, agent_version, deep_link, attributes, search_blob, created_at, last_observed, sync_version, collector, content_hash, last_indexed)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
           ON CONFLICT (org_id, source, type, external_id) DO UPDATE SET
               name=EXCLUDED.name, status=EXCLUDED.status, status_group=EXCLUDED.status_group, ips=EXCLUDED.ips, aliases=EXCLUDED.aliases,
               tags=EXCLUDED.tags, env=EXCLUDED.env, os=EXCLUDED.os, vendor=EXCLUDED.vendor, model=EXCLUDED.model,
               agent_version=EXCLUDED.agent_version, deep_link=EXCLUDED.deep_link, attributes=EXCLUDED.attributes,
               search_blob=EXCLUDED.search_blob, created_at=COALESCE(EXCLUDED.created_at, resources.created_at),
               last_observed=EXCLUDED.last_observed, sync_version=EXCLUDED.sync_version, collector=EXCLUDED.collector, content_hash=EXCLUDED.content_hash, last_indexed=now()
           RETURNING id""",
        (org_id, source, rec["type"], str(rec["external_id"]), rec["name"][:300], status, status_group(status, muted),
         ips, tags, aliases, env, rec.get("os", ""), rec.get("vendor", ""), rec.get("model", ""), rec.get("agent_version", ""),
         rec.get("deep_link", ""), Jsonb(attrs), blob, rec.get("created_at"), rec.get("last_observed"), version, rec.get("collector", ""), record_hash(rec)),
    ).fetchone()
    rid = row["id"]
    if tracker and rec["type"] not in UNTRACKED_TYPES:
        tracker.diff(c, rid, resource_key(source, rec["type"], str(rec["external_id"])), source, rec["type"], prev,
                     {"name": rec["name"][:300], "status": status, "tags": tags, "ips": ips, "aliases": aliases})
    mon = rec.get("monitor")
    if mon is not None:
        c.execute(
            """INSERT INTO monitors (resource_id, monitor_type, query, message, muted) VALUES (%s,%s,%s,%s,%s)
               ON CONFLICT (resource_id) DO UPDATE SET monitor_type=EXCLUDED.monitor_type, query=EXCLUDED.query,
               message=EXCLUDED.message, muted=EXCLUDED.muted""",
            (rid, mon.get("type", ""), mon.get("query", "")[:4000], mon.get("message", "")[:4000], muted),
        )
    return rid


def prune(c, org_id: int, source: str, collector: str, seen_ids: list[int], tracker: ChangeTracker | None = None) -> int:
    """Delete records from one collector that were not seen in this sync (recording them as removed)."""
    gone = c.execute(
        """DELETE FROM resources WHERE org_id=%s AND source=%s AND collector=%s AND NOT (id = ANY(%s))
           RETURNING id, type, external_id, name, status, ips, tags, aliases, last_observed""",
        (org_id, source, collector, seen_ids),
    ).fetchall()
    if tracker:
        for g in gone:
            if g["type"] in UNTRACKED_TYPES:
                continue
            seen = g["last_observed"].strftime("%Y-%m-%d %H:%M UTC") if g["last_observed"] else "unknown"
            tracker.record(c, None, resource_key(source, g["type"], g["external_id"]), source, g["type"], g["name"], "removed",
                           {"status": g["status"], "ips": g["ips"], "tags": g["tags"], "aliases": g["aliases"],
                            "last_observed": g["last_observed"].isoformat() if g["last_observed"] else None},
                           None, f"no longer reported by Datadog (last seen {seen})")
    return len(gone)


def apply_records(c, org_id: int, source: str, collector: str, records, version: int,
                  tracker: ChangeTracker | None = None) -> dict:
    """Write one collector's records with minimal churn.

    * unchanged content (same fingerprint)  -> no row rewrite; only a narrow last_observed update, and only
      when it moved by at least SEEN_GRANULARITY (heap-only update: no index maintenance)
    * changed or new content               -> full upsert + change tracking
    * not seen this sync                    -> deleted and recorded as removed
    """
    existing = {(r["type"], r["external_id"]): r for r in c.execute(
        "SELECT id, type, external_id, content_hash, last_observed FROM resources WHERE org_id=%s AND source=%s AND collector=%s",
        (org_id, source, collector))}
    seen: list[int] = []
    touch_ids: list[int] = []
    touch_at: list[datetime] = []
    written = 0
    for rec in records:
        rec["collector"] = collector
        ex = existing.get((rec["type"], str(rec["external_id"])))
        if ex and ex["content_hash"] == record_hash(rec):
            seen.append(ex["id"])
            lo = _parse_ts(rec.get("last_observed"))
            if lo and (ex["last_observed"] is None or lo - ex["last_observed"] >= SEEN_GRANULARITY):
                touch_ids.append(ex["id"])
                touch_at.append(lo)
            continue
        seen.append(upsert(c, org_id, source, rec, version, tracker))
        written += 1
    if touch_ids:
        c.execute("""UPDATE resources r SET last_observed = v.lo
                     FROM unnest(%s::bigint[], %s::timestamptz[]) AS v(id, lo) WHERE r.id = v.id""", (touch_ids, touch_at))
    pruned = prune(c, org_id, source, collector, seen, tracker)
    return {"records": len(seen), "written": written, "touched": len(touch_ids), "unchanged": len(seen) - written - len(touch_ids),
            "pruned": pruned}


def tag_records(c, org_id: int, source: str, deep_link=None) -> list[dict]:
    """One Tag record per distinct (low-cardinality) tag, with resource counts."""
    rows = c.execute(
        """SELECT t AS tag, count(*) AS n, array_agg(DISTINCT type) AS types
           FROM resources, unnest(tags) AS t WHERE org_id=%s AND source=%s AND type <> 'Tag'
             AND split_part(t, ':', 1) <> ALL(%s) GROUP BY t""",
        (org_id, source, sorted(HIGH_CARDINALITY_TAG_KEYS)),
    ).fetchall()
    return [{"type": "Tag", "external_id": r["tag"], "name": r["tag"], "status": "OK", "tags": [r["tag"]],
             "deep_link": deep_link(r["tag"]) if deep_link else "",
             "attributes": {"resource_count": r["n"], "resource_types": sorted(r["types"])}} for r in rows]


def rebuild_tags(c, org_id: int, source: str, version: int, deep_link=None) -> int:
    """Demo path: rewrite Tag entities for a source (Datadog uses apply_records with collector 'tags')."""
    recs = tag_records(c, org_id, source, deep_link)
    for rec in recs:
        upsert(c, org_id, source, rec, version)
    c.execute("DELETE FROM resources WHERE org_id=%s AND source=%s AND type='Tag' AND sync_version < %s",
              (org_id, source, version))
    return len(recs)


_HOST_IN_QUERY = re.compile(r"(?:host|device_name):([A-Za-z0-9_.\-]+)")


def rebuild_relationships(c, org_id: int) -> None:
    """Store verifiable relationships: monitor scope -> host/device, synthetic -> its monitor."""
    # Build the full edge set in a temp table, then apply only the difference (avoids rewriting every edge each sync).
    c.execute("""CREATE TEMP TABLE IF NOT EXISTS _rel_new (from_id BIGINT, to_id BIGINT, relation TEXT, evidence TEXT,
                 PRIMARY KEY (from_id, to_id, relation)) ON COMMIT DROP""")
    c.execute("TRUNCATE _rel_new")
    hosts = {r["name"].lower(): r["id"] for r in c.execute(
        "SELECT id, name FROM resources WHERE org_id=%s AND type IN ('Host','Device','VMware','Cloud')", (org_id,))}
    for m in c.execute(
        "SELECT r.id, r.tags, m.query FROM resources r JOIN monitors m ON m.resource_id=r.id WHERE r.org_id=%s", (org_id,)
    ).fetchall():
        names = set(n.lower() for n in _HOST_IN_QUERY.findall(m["query"] or ""))
        names.update(t.split(":", 1)[1].lower() for t in m["tags"] if t.lower().startswith("host:"))
        for n in names:
            if n in hosts:
                c.execute(
                    "INSERT INTO _rel_new VALUES (%s,%s,'monitors',%s) ON CONFLICT DO NOTHING",
                    (m["id"], hosts[n], f"monitor scope references {n}"),
                )
    _link_by_attr(c, org_id, "Container", "pod_key", "Pod", "runs_in", "container in pod")
    _link_by_attr(c, org_id, "Pod", "cluster", "Cluster", "member_of", "pod in cluster")
    _link_by_attr(c, org_id, "Interface", "device_id", "Device", "interface_of", "interface of device")
    # containers -> host (by hostname), hosts -> cluster (by kube cluster tag)
    c.execute("""INSERT INTO _rel_new (from_id, to_id, relation, evidence)
                 SELECT ct.id, h.id, 'runs_on', lower(ct.type) || ' runs on ' || h.name FROM resources ct
                 JOIN resources h ON h.org_id=ct.org_id AND h.type IN ('Host','VMware','Cloud') AND lower(h.name)=lower(ct.attributes->>'host')
                 WHERE ct.org_id=%s AND ct.type IN ('Container','Pod','Database') ON CONFLICT DO NOTHING""", (org_id,))
    c.execute("""INSERT INTO _rel_new (from_id, to_id, relation, evidence)
                 SELECT h.id, cl.id, 'member_of', 'node tag ' || t FROM resources h, unnest(h.tags) t
                 JOIN resources cl ON cl.type='Cluster' AND lower(cl.name) = lower(split_part(t, ':', 2))
                 WHERE h.org_id=%s AND cl.org_id=h.org_id AND h.type IN ('Host','VMware','Cloud')
                   AND (t ILIKE 'kube_cluster_name:%%' OR t ILIKE 'kube_cluster:%%') ON CONFLICT DO NOTHING""", (org_id,))
    for s in c.execute(
        "SELECT id, attributes->>'monitor_id' AS mid FROM resources WHERE org_id=%s AND type='Synthetic' AND attributes ? 'monitor_id'",
        (org_id,),
    ).fetchall():
        mon = c.execute("SELECT id FROM resources WHERE org_id=%s AND type='Monitor' AND external_id=%s",
                        (org_id, s["mid"])).fetchone()
        if mon:
            c.execute("INSERT INTO _rel_new VALUES (%s,%s,'backed_by',%s) ON CONFLICT DO NOTHING",
                      (s["id"], mon["id"], f"synthetic monitor_id {s['mid']}"))
    c.execute("""DELETE FROM resource_relationships rr USING resources r
                 WHERE rr.from_id = r.id AND r.org_id = %s
                   AND NOT EXISTS (SELECT 1 FROM _rel_new n WHERE n.from_id=rr.from_id AND n.to_id=rr.to_id AND n.relation=rr.relation)""",
              (org_id,))
    c.execute("""INSERT INTO resource_relationships (from_id, to_id, relation, evidence)
                 SELECT from_id, to_id, relation, evidence FROM _rel_new
                 ON CONFLICT (from_id, to_id, relation) DO UPDATE SET evidence = EXCLUDED.evidence
                 WHERE resource_relationships.evidence IS DISTINCT FROM EXCLUDED.evidence""")


def _link_by_attr(c, org_id: int, from_type: str, attr: str, to_type: str, relation: str, evidence: str) -> None:
    """Link from_type -> to_type where from.attributes[attr] equals the target's external_id (same source)."""
    c.execute(
        f"""INSERT INTO _rel_new (from_id, to_id, relation, evidence)
            SELECT a.id, b.id, %s, %s || ' ' || b.name FROM resources a
            JOIN resources b ON b.org_id=a.org_id AND b.source=a.source AND b.type=%s AND b.external_id = a.attributes->>%s
            WHERE a.org_id=%s AND a.type=%s ON CONFLICT DO NOTHING""",
        (relation, evidence, to_type, attr, org_id, from_type),
    )
