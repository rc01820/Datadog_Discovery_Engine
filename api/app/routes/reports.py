"""NOC intelligence reports (Phase 4): actionable lists with traceable evidence."""
from fastapi import APIRouter, Depends, HTTPException

from .. import db, security
from .search import _stale_cutoff

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

INFRA = ("Host", "Device", "VMware", "Cloud")


def _required_tags() -> list[str]:
    return [t for t in (db.get_setting("required_tags", []) or []) if t]


REPORTS = {
    "alerting": ("Alerting & warning resources", "Everything currently in Alert or Warn state, worst first.",
                 "status:alert OR status:warn"),
    "duplicate-ips": ("Duplicate IP addresses", "IPs observed on more than one resource. Identical IPs do not prove the same resource; investigate NAT, re-use or stale records.", ""),
    "missing-tags": ("Missing required tags", "Infrastructure missing one or more required tag keys (configurable in Admin > Settings).", ""),
    "stale": ("Stale inventory", "Infrastructure that has not reported within the stale threshold.", ""),
    "unmonitored": ("Infrastructure without monitor coverage", "No monitor scoped to it by name and no monitor sharing its app: tag.", ""),
    "agent-versions": ("Agent versions", "Datadog Agent version distribution across hosts; flags agents older than the most common major version.", ""),
}


@router.get("")
def summary(user: dict = Depends(security.require("search"))):
    out = []
    for key, (title, desc, _) in REPORTS.items():
        data = report(key, user)
        out.append({"key": key, "title": title, "description": desc, "count": len(data["rows"])})
    return out


@router.get("/{key}")
def report(key: str, user: dict = Depends(security.require("search"))):
    if key not in REPORTS:
        raise HTTPException(404, "Unknown report")
    title, desc, q = REPORTS[key]
    cutoff = _stale_cutoff()
    with db.conn() as c:
        if key == "alerting":
            rows = c.execute(
                """SELECT id, name, type, status, status_group, ips, tags, last_observed FROM resources
                   WHERE status_group IN ('alert','warn') AND type <> 'Tag'
                   ORDER BY status_group, type, name""").fetchall()
            cols = ["name", "type", "status", "tags", "last_observed"]
        elif key == "duplicate-ips":
            rows = c.execute(
                """SELECT ip, count(*) AS resources, array_agg(name ORDER BY name) AS names, array_agg(type ORDER BY name) AS types,
                          min(id) AS id
                   FROM resources, unnest(ips) ip WHERE type <> 'Tag' GROUP BY ip HAVING count(*) > 1 ORDER BY count(*) DESC, ip""").fetchall()
            for r in rows:
                r["query"] = f"ip:\"{r['ip']}\""
            cols = ["ip", "resources", "names", "types"]
        elif key == "missing-tags":
            req = _required_tags()
            rows = []
            for r in c.execute("SELECT id, name, type, tags, status FROM resources WHERE type = ANY(%s) ORDER BY type, name", (list(INFRA),)):
                keys = {t.split(":", 1)[0].lower() for t in r["tags"]}
                missing = [k for k in req if k.lower() not in keys]
                if missing:
                    r["missing"] = missing
                    rows.append(r)
            cols = ["name", "type", "missing", "tags"]
            desc = desc + f" Required: {', '.join(req) or 'none configured'}."
        elif key == "stale":
            rows = c.execute(
                """SELECT id, name, type, status, ips, last_observed, source FROM resources
                   WHERE type = ANY(%s) AND last_observed < %s ORDER BY last_observed""", (list(INFRA), cutoff)).fetchall()
            cols = ["name", "type", "status", "ips", "last_observed", "source"]
        elif key == "unmonitored":
            rows = c.execute(
                """SELECT r.id, r.name, r.type, r.status, r.tags FROM resources r
                   WHERE r.type = ANY(%s)
                     AND NOT EXISTS (SELECT 1 FROM resource_relationships rr WHERE rr.to_id=r.id AND rr.relation='monitors')
                     AND NOT EXISTS (SELECT 1 FROM resources m WHERE m.type='Monitor' AND m.org_id=r.org_id
                                     AND m.tags && ARRAY(SELECT t FROM unnest(r.tags) t WHERE t LIKE 'app:%%'))
                   ORDER BY r.type, r.name""", (list(INFRA),)).fetchall()
            cols = ["name", "type", "status", "tags"]
        else:  # agent-versions
            rows = c.execute(
                """SELECT agent_version AS version, count(*) AS hosts, array_agg(name ORDER BY name) AS names, min(id) AS id
                   FROM resources WHERE type IN ('Host','VMware') AND agent_version <> '' GROUP BY agent_version
                   ORDER BY string_to_array(regexp_replace(agent_version, '[^0-9.]', '', 'g'), '.')::int[] DESC""").fetchall()
            if rows:
                major = lambda v: int((v.split(".")[0] or "0") if v.split(".")[0].isdigit() else 0)
                common = major(max(rows, key=lambda r: r["hosts"])["version"])
                for r in rows:
                    r["outdated"] = major(r["version"]) < common
                    r["query"] = f"agent:\"{r['version']}\""
            cols = ["version", "hosts", "outdated", "names"]
    return {"key": key, "title": title, "description": desc, "query": q, "columns": cols, "rows": rows}
