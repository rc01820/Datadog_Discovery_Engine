"""Datadog API adapter: site handling, deep links, resilient HTTP and per-product fetchers."""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote

import httpx

from . import db, security
from .config import settings

log = logging.getLogger("datadog-search.datadog")

SITES = {
    "datadoghq.com": ("US1", "app.datadoghq.com"),
    "us3.datadoghq.com": ("US3", "us3.datadoghq.com"),
    "us5.datadoghq.com": ("US5", "us5.datadoghq.com"),
    "datadoghq.eu": ("EU1", "app.datadoghq.eu"),
    "ap1.datadoghq.com": ("AP1", "ap1.datadoghq.com"),
    "ap2.datadoghq.com": ("AP2", "ap2.datadoghq.com"),
    "ddog-gov.com": ("US1-FED GovCloud", "app.ddog-gov.com"),
}


class SourceError(Exception):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category


def site_label(site: str) -> str:
    return SITES.get(site, (site, ""))[0]


def app_host(site: str) -> str:
    if site not in SITES:
        raise ValueError("Unsupported Datadog site")
    return SITES[site][1]


def api_base(site: str) -> str:
    if site not in SITES:
        raise ValueError("Unsupported Datadog site")
    return f"https://api.{site}"


# ---- deep links (built only from a validated site + identifiers) ------------
def link(site: str, kind: str, ident: str) -> str:
    try:
        base = "https://" + app_host(site)
    except ValueError:
        return ""
    q = quote(str(ident), safe="")
    return {
        "Host": f"{base}/infrastructure?host={q}",
        "VMware": f"{base}/infrastructure?host={q}",
        "Cloud": f"{base}/infrastructure?host={q}",
        "Device": f"{base}/devices?query={quote('device_name:' + str(ident), safe='')}",
        "Monitor": f"{base}/monitors/{q}",
        "Synthetic": f"{base}/synthetics/details/{q}",
        "Dashboard": f"{base}/dashboard/{q}",
        "Service": f"{base}/software?query={quote('service:' + str(ident), safe='')}",
        "Tag": f"{base}/infrastructure?tags={q}",
        "Container": f"{base}/containers?query={quote('container_id:' + str(ident), safe='')}",
        "Pod": f"{base}/orchestration/explorer/pod?query={quote('pod_name:' + str(ident), safe='')}",
        "Cluster": f"{base}/orchestration/explorer/cluster?query={quote('kube_cluster_name:' + str(ident), safe='')}",
        "Interface": f"{base}/devices?query={quote('device_name:' + str(ident), safe='')}",
        "metric": f"{base}/metric/explorer?exp_metric={q}",
        "logs": f"{base}/logs?query={quote('host:' + str(ident), safe='')}",
        "metrics": f"{base}/infrastructure?host={q}&tab=metrics",
    }.get(kind, "")


# ---- connection --------------------------------------------------------------
def connection(org_id: int | None = None) -> dict | None:
    """Effective connection: environment variables override values stored in the database."""
    with db.conn() as c:
        oid = org_id or db.default_org_id(c)
        row = c.execute(
            "SELECT d.*, o.name AS org_name FROM datadog_connections d JOIN organizations o ON o.id=d.org_id WHERE d.org_id=%s",
            (oid,),
        ).fetchone()
        org_name = c.execute("SELECT name FROM organizations WHERE id=%s", (oid,)).fetchone()["name"]
    api_key = settings.datadog_api_key or (security.decrypt(row["api_key_enc"]) if row else "")
    app_key = settings.datadog_app_key or (security.decrypt(row["app_key_enc"]) if row else "")
    return {
        "org_id": oid,
        "org_name": org_name,
        "site": (row["site"] if row else settings.datadog_site),
        "api_key": api_key,
        "app_key": app_key,
        "enabled": row["enabled"] if row else bool(api_key and app_key),
        "sync_interval_minutes": row["sync_interval_minutes"] if row else 15,
        "sources": row["sources"] if row else list(DEFAULT_SOURCES),
        "env_keys": bool(settings.datadog_api_key and settings.datadog_app_key),
        "configured": bool(api_key and app_key),
    }


class Client:
    def __init__(self, conn: dict, timeout: float = 30):
        self.site = conn["site"]
        self.base = api_base(self.site)
        self.http = httpx.Client(
            timeout=timeout,
            headers={"DD-API-KEY": conn["api_key"], "DD-APPLICATION-KEY": conn["app_key"],
                     "Accept": "application/json", "User-Agent": "datadog-search/1.0"},
        )

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.http.close()

    def request(self, method: str, path: str, **kw):
        """Request with rate-limit aware retry and categorized failures."""
        delay = 1.0
        for attempt in range(5):
            try:
                resp = self.http.request(method, self.base + path, **kw)
            except httpx.HTTPError as exc:
                if attempt == 4:
                    raise SourceError("source_unavailable", f"{type(exc).__name__}: {exc}") from None
                time.sleep(delay); delay *= 2
                continue
            if resp.status_code == 429:
                wait = min(float(resp.headers.get("X-RateLimit-Reset", delay) or delay), 60)
                log.warning("rate limited on %s; waiting %ss", path, wait)
                if attempt == 4:
                    raise SourceError("rate_limited", f"Rate limited on {path}")
                time.sleep(wait); delay *= 2
                continue
            if resp.status_code >= 500:
                if attempt == 4:
                    raise SourceError("source_unavailable", f"HTTP {resp.status_code} from {path}")
                time.sleep(delay); delay *= 2
                continue
            if resp.status_code in (401, 403):
                raise SourceError("permission_denied", f"HTTP {resp.status_code}: check API/application key scopes for {path}")
            if resp.status_code == 404:
                raise SourceError("not_available", f"{path} is not available for this organization or site")
            if resp.status_code >= 400:
                raise SourceError("error", f"HTTP {resp.status_code} from {path}: {resp.text[:200]}")
            return resp.json() if resp.content else {}
        raise SourceError("error", "retry budget exhausted")

    def get(self, path: str, **params):
        return self.request("GET", path, params=params or None)

    # ---- validation ----------------------------------------------------------
    def validate(self) -> dict:
        out = {"api_key": False, "app_key": False, "site": self.site, "errors": []}
        try:
            out["api_key"] = bool(self.get("/api/v1/validate").get("valid"))
        except SourceError as e:
            out["errors"].append(f"API key: {e}")
        try:
            self.get("/api/v1/monitor", page=0, page_size=1)
            out["app_key"] = True
        except SourceError as e:
            out["errors"].append(f"Application key: {e}")
        return out

    # ---- inventory fetchers (each yields normalized records) ------------------
    def hosts(self):
        start = 0
        while True:
            data = self.get("/api/v1/hosts", start=start, count=1000, include_muted_hosts_data="true")
            items = data.get("host_list") or []
            for h in items:
                yield self._host(h)
            start += len(items)
            if not items or start >= int(data.get("total_matching") or 0):
                break

    def _host(self, h: dict) -> dict:
        name = h.get("host_name") or h.get("name") or str(h.get("id"))
        tags: list[str] = []
        for src_tags in (h.get("tags_by_source") or {}).values():
            tags.extend(src_tags or [])
        meta = h.get("meta") or {}
        ips: list[str] = []
        gohai = meta.get("gohai")
        if isinstance(gohai, str):
            try:
                gohai = json.loads(gohai)
            except ValueError:
                gohai = {}
        net = (gohai or {}).get("network") or {}
        for k in ("ipaddress", "ipaddressv6"):
            if net.get(k):
                ips.append(net[k])
        for iface in net.get("interfaces") or []:
            ips.extend(iface.get("ipv4") or [])
        ips.extend(a for a in (h.get("aliases") or []) if re.fullmatch(r"[0-9.]+", str(a)))
        apps = [a.lower() for a in h.get("apps") or []]
        sources = [s.lower() for s in h.get("sources") or []]
        platform = ((gohai or {}).get("platform") or {})
        os_name = platform.get("os") or meta.get("platform") or ""
        if platform.get("kernel_name") == "Windows" or "windows" in str(meta.get("platform", "")).lower():
            os_name = (meta.get("winV") or ["Windows"])[0] if isinstance(meta.get("winV"), list) else "Windows"
        kind, inferred = "Host", False
        if "vsphere" in apps or "vsphere" in sources:
            kind, inferred = "VMware", True
        elif not meta.get("agent_version") and set(sources) & {"aws", "azure", "gcp", "gce"}:
            kind, inferred = "Cloud", True
        last = h.get("last_reported_time")
        muted = bool(h.get("is_muted"))
        # Aliases: Datadog host aliases (AWS instance ID, EC2 private/public DNS, cloud hostnames) plus
        # identifiers the AWS integration attaches as tags (instance-id, Name tag, RDS/ELB identifiers).
        aliases = [str(a) for a in (h.get("aliases") or [])]
        for t in tags:
            key, _, val = t.partition(":")
            if val and key.lower() in ALIAS_TAG_KEYS:
                aliases.append(val)
        return {
            "type": kind, "external_id": str(h.get("id") or name), "name": name,
            "status": "Up" if h.get("up") else "Down", "muted": muted, "ips": ips, "tags": tags, "aliases": aliases,
            "os": os_name, "agent_version": meta.get("agent_version") or "",
            "deep_link": link(self.site, kind, name),
            "last_observed": datetime.fromtimestamp(last, timezone.utc) if last else None,
            "attributes": {"aliases": h.get("aliases") or [], "apps": h.get("apps") or [], "sources": h.get("sources") or [],
                           "cpu_cores": meta.get("cpuCores"), "machine": meta.get("machine"),
                           "inferred_type": inferred, "datadog_host_id": h.get("id")},
        }

    def monitors(self):
        page = 0
        while True:
            items = self.get("/api/v1/monitor", page=page, page_size=1000)
            if not isinstance(items, list):
                raise SourceError("error", "Unexpected monitor payload")
            for m in items:
                silenced = ((m.get("options") or {}).get("silenced") or {})
                state = m.get("overall_state") or "Unknown"
                yield {
                    "type": "Monitor", "external_id": str(m["id"]), "name": m.get("name") or str(m["id"]),
                    "status": state, "muted": bool(silenced), "tags": m.get("tags") or [],
                    "deep_link": link(self.site, "Monitor", m["id"]),
                    "created_at": m.get("created"), "last_observed": m.get("overall_state_modified") or m.get("modified"),
                    "monitor": {"type": m.get("type", ""), "query": m.get("query", ""), "message": m.get("message", "")},
                    "attributes": {"monitor_type": m.get("type"), "priority": m.get("priority"),
                                   "creator": (m.get("creator") or {}).get("handle")},
                }
            if len(items) < 1000:
                break
            page += 1

    def synthetics(self):
        data = self.get("/api/v1/synthetics/tests")
        for t in data.get("tests") or []:
            req = ((t.get("config") or {}).get("request") or {})
            yield {
                "type": "Synthetic", "external_id": t["public_id"], "name": t.get("name") or t["public_id"],
                "status": "Paused" if t.get("status") == "paused" else "OK", "tags": t.get("tags") or [],
                "deep_link": link(self.site, "Synthetic", t["public_id"]),
                "attributes": {"url": req.get("url") or req.get("host"), "test_type": t.get("type"),
                               "subtype": t.get("subtype"), "locations": t.get("locations") or [],
                               "monitor_id": str(t["monitor_id"]) if t.get("monitor_id") else None},
            }

    def dashboards(self):
        start = 0
        while True:
            data = self.get("/api/v1/dashboard", count=100, start=start)
            items = data.get("dashboards") or []
            for d in items:
                yield {
                    "type": "Dashboard", "external_id": d["id"], "name": d.get("title") or d["id"], "status": "OK",
                    "tags": d.get("tags") or [], "deep_link": link(self.site, "Dashboard", d["id"]),
                    "created_at": d.get("created_at"), "last_observed": d.get("modified_at"),
                    "attributes": {"description": d.get("description") or "", "author": d.get("author_handle"),
                                   "layout": d.get("layout_type")},
                }
            if len(items) < 100:
                break
            start += len(items)

    def devices(self):
        page = 0
        while True:
            data = self.get("/api/v2/ndm/devices", **{"page[size]": 100, "page[number]": page})
            items = data.get("data") or []
            for d in items:
                a = d.get("attributes") or {}
                name = a.get("name") or a.get("device_name") or d.get("id")
                yield {
                    "type": "Device", "external_id": d.get("id"), "name": name,
                    "status": (a.get("status") or "Unknown").title(), "ips": [a.get("ip_address")],
                    "tags": a.get("tags") or [], "vendor": a.get("vendor") or "", "model": a.get("model") or "",
                    "os": a.get("os_name") or "", "deep_link": link(self.site, "Device", name),
                    "attributes": {"device_type": a.get("device_type"), "location": a.get("location"),
                                   "namespace": a.get("namespace"), "serial": a.get("serial_number"),
                                   "interfaces_up": a.get("interface_statuses", {}).get("up") if isinstance(a.get("interface_statuses"), dict) else None},
                }
            total = ((data.get("meta") or {}).get("page") or {}).get("total_filtered_count") or 0
            page += 1
            if not items or page * 100 >= total:
                break

    def services(self):
        page = 0
        while True:
            data = self.get("/api/v2/services/definitions", **{"page[size]": 100, "page[number]": page})
            items = data.get("data") or []
            for s in items:
                schema = ((s.get("attributes") or {}).get("schema") or {})
                name = schema.get("dd-service") or (schema.get("info") or {}).get("dd-service") or s.get("id")
                tags = list(schema.get("tags") or [])
                if schema.get("team"):
                    tags.append(f"team:{schema['team']}")
                yield {
                    "type": "Service", "external_id": name, "name": name, "status": "OK", "tags": tags,
                    "deep_link": link(self.site, "Service", name),
                    "attributes": {"team": schema.get("team"), "tier": schema.get("tier"),
                                   "language": schema.get("languages"), "description": schema.get("description")},
                }
            page += 1
            if len(items) < 100:
                break

    # ---- network device interfaces -------------------------------------------
    MAX_INTERFACE_DEVICES = 500

    def interfaces(self):
        """Interfaces of every NDM device (one call per device, capped)."""
        devices = list(self.devices())
        for d in devices[: self.MAX_INTERFACE_DEVICES]:
            data = self.get("/api/v2/ndm/interfaces", device_id=d["external_id"], get_ip_addresses="true")
            for i in data.get("data") or []:
                a = i.get("attributes") or {}
                ifname = a.get("name") or a.get("alias") or str(a.get("index"))
                mac = (a.get("mac_address") or "").lower()
                status = (a.get("status") or "unknown").title()
                yield {
                    "type": "Interface", "external_id": i.get("id") or f"{d['external_id']}:{a.get('index')}",
                    "name": f"{d['name']} {ifname}", "status": status,
                    "ips": [ip.split("/")[0] for ip in (a.get("ip_addresses") or [])],
                    "aliases": [x for x in (mac, a.get("alias"), a.get("description")) if x],
                    "tags": [f"device_name:{d['name']}", f"interface:{ifname}", *[t for t in d["tags"] if t.startswith(("env:", "geolocation:", "site:"))]],
                    "vendor": d.get("vendor", ""), "model": d.get("model", ""),
                    "deep_link": link(self.site, "Interface", d["name"]),
                    "attributes": {"device_id": d["external_id"], "device": d["name"], "interface": ifname, "index": a.get("index"),
                                   "mac_address": mac, "description": a.get("description"), "alias": a.get("alias")},
                }

    # ---- kubernetes (containers API; pods & clusters derived from container tags) ----
    def containers(self):
        cursor = None
        for _ in range(200):  # safety bound
            params = {"page[size]": 1000}
            if cursor:
                params["page[cursor]"] = cursor
            data = self.get("/api/v2/containers", **params)
            for item in data.get("data") or []:
                yield item
            cursor = (((data.get("meta") or {}).get("pagination") or {}).get("next_cursor"))
            if not cursor:
                break

    def kubernetes(self):
        pods: dict[str, dict] = {}
        clusters: dict[str, dict] = {}
        for item in self.containers():
            a = item.get("attributes") or {}
            tags = [str(t) for t in a.get("tags") or []]
            tv = {t.split(":", 1)[0]: t.split(":", 1)[1] for t in tags if ":" in t}
            cid = a.get("container_id") or item.get("id")
            cluster = tv.get("kube_cluster_name") or tv.get("kube_cluster") or ""
            ns = tv.get("kube_namespace", "")
            pod = tv.get("pod_name", "")
            pod_key = f"{cluster}/{ns}/{pod}" if pod else ""
            state = (a.get("state") or "unknown").title()
            yield {
                "type": "Container", "external_id": cid, "name": a.get("name") or cid[:12], "status": state,
                "tags": tags, "aliases": [cid, cid[:12]] if cid else [],
                "deep_link": link(self.site, "Container", cid),
                "created_at": a.get("created_at"), "last_observed": datetime.now(timezone.utc),
                "attributes": {"host": a.get("host"), "image": a.get("image_name"), "image_tags": a.get("image_tags"),
                               "image_digest": a.get("image_digest"), "pod_key": pod_key, "cluster": cluster,
                               "namespace": ns, "started_at": a.get("started_at")},
            }
            if pod:
                p = pods.setdefault(pod_key, {"name": pod, "cluster": cluster, "namespace": ns, "host": a.get("host"),
                                              "states": [], "tags": set(), "containers": 0})
                p["states"].append(state.lower()); p["containers"] += 1
                p["tags"].update(t for t in tags if t.split(":", 1)[0] in POD_TAG_KEYS)
            if cluster:
                cl = clusters.setdefault(cluster, {"pods": set(), "nodes": set(), "namespaces": set(), "tags": set()})
                if pod:
                    cl["pods"].add(pod_key)
                if a.get("host"):
                    cl["nodes"].add(a["host"])
                if ns:
                    cl["namespaces"].add(ns)
                cl["tags"].update(t for t in tags if t.split(":", 1)[0] in ("env", "kube_cluster_name", "region", "cloud_provider"))
        for key, p in pods.items():
            st = p["states"]
            status = "Running" if all(s == "running" for s in st) else "Degraded" if any(s == "running" for s in st) else "Failed"
            yield {
                "type": "Pod", "external_id": key, "name": p["name"], "status": status, "tags": sorted(p["tags"]),
                "deep_link": link(self.site, "Pod", p["name"]),
                "attributes": {"cluster": p["cluster"], "namespace": p["namespace"], "host": p["host"],
                               "containers": p["containers"], "derived_from": "container tags"},
            }
        for name, cl in clusters.items():
            yield {
                "type": "Cluster", "external_id": name, "name": name, "status": "OK",
                "tags": sorted(cl["tags"] | {f"kube_cluster_name:{name}"}), "deep_link": link(self.site, "Cluster", name),
                "attributes": {"pods": len(cl["pods"]), "nodes": sorted(cl["nodes"]), "node_count": len(cl["nodes"]),
                               "namespaces": sorted(cl["namespaces"]), "derived_from": "container tags"},
            }

    # ---- databases discovered via database integration metrics -------------------
    def databases(self):
        """One Database resource per engine instance (and per logical db where the integration tags it)."""
        now = int(time.time())
        seen: set[str] = set()
        for engine, metric, keys in DB_METRICS:
            try:
                data = self.get("/api/v1/query", **{"from": now - 4 * 3600, "to": now,
                                                    "query": f"avg:{metric}{{*}} by {{{','.join(keys)}}}"})
            except SourceError as e:
                if e.category == "permission_denied":
                    raise
                continue
            for series in data.get("series") or []:
                tags = [t for t in (series.get("tag_set") or []) if not t.endswith(":n/a")]
                tv = {t.split(":", 1)[0]: t.split(":", 1)[1] for t in tags if ":" in t}
                host = tv.get("host") or tv.get("redis_host") or ""
                instance = tv.get(keys[1]) if len(keys) > 1 else ""
                if not (host or instance):
                    continue
                slug = engine.lower().replace(" ", "")
                ext = f"db:{slug}:{host}:{instance}"
                if ext in seen:
                    continue
                seen.add(ext)
                if keys[1:2] == ["db"] and instance:
                    name = f"{instance}@{host}" if host else instance
                elif instance:
                    name = f"{slug}@{host}:{instance}" if host else f"{slug}:{instance}"
                else:
                    name = f"{slug}@{host}"
                aliases = [a for a in (instance, f"{host}:{instance}" if host and instance else "") if a]
                yield {
                    "type": "Database", "external_id": ext, "name": name, "status": "OK",
                    "tags": sorted({*tags, f"db_engine:{slug}"}), "aliases": aliases, "vendor": engine, "model": engine,
                    "deep_link": link(self.site, "metric", metric), "last_observed": datetime.now(timezone.utc),
                    "attributes": {"engine": engine, "host": host, keys[1] if len(keys) > 1 else "instance": instance or None,
                                   "discovered_via": f"metric {metric} (last 4h)", "inferred_type": True},
                }

    # ---- AWS resources discovered via integration metrics ------------------------
    def aws_resources(self):
        now = int(time.time())
        seen: set[tuple[str, str]] = set()
        for service, metric, ident, extra in AWS_METRICS:
            group = ",".join([ident, *extra])
            try:
                data = self.get("/api/v1/query", **{"from": now - 4 * 3600, "to": now, "query": f"avg:{metric}{{*}} by {{{group}}}"})
            except SourceError as e:
                if e.category == "permission_denied":
                    raise
                continue
            for series in data.get("series") or []:
                tags = [t for t in (series.get("tag_set") or []) if not t.endswith(":n/a")]
                tv = {t.split(":", 1)[0]: t.split(":", 1)[1] for t in tags if ":" in t}
                rid = tv.get(ident)
                if not rid or (service, rid) in seen:
                    continue
                seen.add((service, rid))
                yield {
                    "type": "Cloud", "external_id": f"aws:{service.lower().replace(' ', '')}:{tv.get('region', '')}:{rid}",
                    "name": rid, "status": "OK",
                    "tags": sorted({*tags, "cloud:aws", f"aws_service:{service.lower().replace(' ', '')}"}),
                    "aliases": [f"{service}:{rid}"], "vendor": "AWS", "model": service,
                    "deep_link": link(self.site, "metric", metric),
                    "last_observed": datetime.now(timezone.utc),
                    "attributes": {"aws_service": service, "region": tv.get("region"), "aws_account": tv.get("aws_account"),
                                   "discovered_via": f"metric {metric} (last 4h)", "inferred_type": True},
                }

    # ---- on-demand live lookups ---------------------------------------------
    def monitor(self, monitor_id: str) -> dict:
        return self.get(f"/api/v1/monitor/{quote(monitor_id, safe='')}")

    def logs(self, query: str, minutes: int = 60, limit: int = 50) -> list[dict]:
        data = self.request("POST", "/api/v2/logs/events/search", json={
            "filter": {"query": query, "from": f"now-{minutes}m", "to": "now"},
            "page": {"limit": limit}, "sort": "-timestamp"})
        out = []
        for e in data.get("data") or []:
            a = e.get("attributes") or {}
            out.append({"timestamp": a.get("timestamp"), "status": a.get("status"), "service": a.get("service"),
                        "host": a.get("host"), "message": (a.get("message") or "")[:500]})
        return out

    def metric(self, query: str, minutes: int = 60) -> list[list[float]]:
        now = int(time.time())
        data = self.get("/api/v1/query", **{"from": now - minutes * 60, "to": now, "query": query})
        series = data.get("series") or []
        return series[0].get("pointlist", []) if series else []


POD_TAG_KEYS = {"kube_cluster_name", "kube_namespace", "kube_deployment", "kube_replica_set", "kube_stateful_set", "kube_daemon_set",
                "kube_service", "env", "service", "version", "team", "app", "pod_name"}

ALIAS_TAG_KEYS = {"instance-id", "instance_id", "aws_instance_id", "name", "dbinstanceidentifier", "dbclusteridentifier",
                  "loadbalancername", "aws_ec2_instance_id", "host_alias"}

# collector name -> Client method. Each collector is pruned independently.
FETCHERS = {
    "hosts": "hosts",
    "monitors": "monitors",
    "devices": "devices",
    "interfaces": "interfaces",
    "synthetics": "synthetics",
    "dashboards": "dashboards",
    "services": "services",
    "kubernetes": "kubernetes",
    "aws": "aws_resources",
    "databases": "databases",
}
DEFAULT_SOURCES = ["hosts", "monitors", "devices", "interfaces", "synthetics", "dashboards", "services", "kubernetes", "aws",
                   "databases", "tags"]

# Databases discovered from Datadog database integrations: (engine, metric, [host tag, instance tag?]).
DB_METRICS = [
    ("PostgreSQL", "postgresql.connections", ["host", "db"]),
    ("MySQL", "mysql.net.connections", ["host"]),
    ("SQL Server", "sqlserver.stats.connections", ["host"]),
    ("MongoDB", "mongodb.connections.current", ["host"]),
    ("Redis", "redis.net.clients", ["host", "redis_port"]),
    ("Elasticsearch", "elasticsearch.number_of_nodes", ["host", "cluster_name"]),
]

# Every data source an administrator can toggle, in display order. "tags" is derived (no API call of its own).
SOURCE_CATALOG = [
    {"key": "hosts", "label": "Hosts", "types": ["Host", "VMware", "Cloud"], "api": "GET /api/v1/hosts",
     "description": "Infrastructure hosts with IPs, aliases (AWS instance ID, EC2 DNS, Name tag), OS and agent version. "
                    "vSphere VMs and agentless cloud hosts are classified as VMware / Cloud."},
    {"key": "monitors", "label": "Monitors", "types": ["Monitor"], "api": "GET /api/v1/monitor",
     "description": "Monitor definitions, current state, mute status and query (used to link monitors to hosts/devices)."},
    {"key": "devices", "label": "Network devices", "types": ["Device"], "api": "GET /api/v2/ndm/devices",
     "description": "Network Device Monitoring (NDM) devices: vendor, model, management IP, location. Requires NDM."},
    {"key": "interfaces", "label": "Device interfaces", "types": ["Interface"], "api": "GET /api/v2/ndm/interfaces",
     "description": "Interfaces of each NDM device: status, IPs, MAC, description. One API call per device (max 500)."},
    {"key": "kubernetes", "label": "Containers, pods & clusters", "types": ["Container", "Pod", "Cluster"], "api": "GET /api/v2/containers",
     "description": "Running containers (Docker and Kubernetes). Pods and clusters are derived from container tags "
                    "(pod_name, kube_namespace, kube_cluster_name)."},
    {"key": "services", "label": "Services (APM / Service Catalog)", "types": ["Service"], "api": "GET /api/v2/services/definitions",
     "description": "Service Catalog definitions: service name, team, tier, languages."},
    {"key": "synthetics", "label": "Synthetic tests", "types": ["Synthetic"], "api": "GET /api/v1/synthetics/tests",
     "description": "API and browser tests with URL, locations and backing monitor."},
    {"key": "dashboards", "label": "Dashboards", "types": ["Dashboard"], "api": "GET /api/v1/dashboard",
     "description": "Dashboard titles, descriptions and authors."},
    {"key": "aws", "label": "AWS services", "types": ["Cloud"], "api": "GET /api/v1/query (AWS integration metrics)",
     "description": "Lambda, RDS, ALB/NLB/ELB, S3, DynamoDB, SQS, SNS, ECS, EKS, ElastiCache, CloudFront, API Gateway, Kinesis, EFS and "
                    "NAT Gateway resources that reported AWS integration metrics in the last 4 hours."},
    {"key": "databases", "label": "Databases", "types": ["Database"], "api": "GET /api/v1/query (database integration metrics)",
     "description": "PostgreSQL (per database), MySQL, SQL Server, MongoDB, Redis and Elasticsearch instances that reported integration "
                    "metrics in the last 4 hours, linked to the host they run on."},
    {"key": "tags", "label": "Tags", "types": ["Tag"], "api": "derived from all synced resources", "derived": True,
     "description": "One searchable Tag entity per distinct tag (with resource counts). High-cardinality per-pod / per-container "
                    "tags are skipped. Turning this off removes Tag entities; tags on resources stay searchable."},
]
CATALOG_KEYS = {s["key"] for s in SOURCE_CATALOG}

# AWS resource types discovered from integration metrics: each metric is grouped by the tags that identify a resource.
AWS_METRICS = [
    # (service label, metric, identifying tag, extra group-by tags)
    ("Lambda", "aws.lambda.invocations", "functionname", ["region", "aws_account"]),
    ("RDS", "aws.rds.cpuutilization", "dbinstanceidentifier", ["region", "engine", "aws_account"]),
    ("ALB", "aws.applicationelb.request_count", "loadbalancer", ["region", "aws_account"]),
    ("ELB", "aws.elb.request_count", "loadbalancername", ["region", "aws_account"]),
    ("NLB", "aws.networkelb.active_flow_count", "loadbalancer", ["region", "aws_account"]),
    ("S3", "aws.s3.bucket_size_bytes", "bucketname", ["region", "aws_account"]),
    ("DynamoDB", "aws.dynamodb.consumed_read_capacity_units", "tablename", ["region", "aws_account"]),
    ("SQS", "aws.sqs.approximate_number_of_messages_visible", "queuename", ["region", "aws_account"]),
    ("SNS", "aws.sns.number_of_messages_published", "topicname", ["region", "aws_account"]),
    ("ECS", "aws.ecs.cpuutilization", "clustername", ["servicename", "region", "aws_account"]),
    ("EKS", "aws.eks.cluster_failed_request_count", "clustername", ["region", "aws_account"]),
    ("ElastiCache", "aws.elasticache.cpuutilization", "cacheclusterid", ["region", "aws_account"]),
    ("CloudFront", "aws.cloudfront.requests", "distributionid", ["aws_account"]),
    ("API Gateway", "aws.apigateway.count", "apiname", ["region", "aws_account"]),
    ("Kinesis", "aws.kinesis.incoming_records", "streamname", ["region", "aws_account"]),
    ("EFS", "aws.efs.client_connections", "filesystemid", ["region", "aws_account"]),
    ("NAT Gateway", "aws.natgateway.active_connection_count", "natgatewayid", ["region", "aws_account"]),
]
