"""Synthetic DEMO inventory so the UI is explorable without Datadog credentials."""
import random
import time
from datetime import datetime, timedelta, timezone

from . import db, inventory
from .config import settings
from .datadog import link

NOW = lambda: datetime.now(timezone.utc)  # noqa: E731


def _hosts():
    H = []
    def host(name, ip, tags, os_="Linux (Ubuntu 22.04)", status="Up", agent="7.75.3", seen=0, kind="Host", **attrs):
        H.append({"type": kind, "name": name, "ips": [ip] if ip else [], "tags": tags, "os": os_, "status": status,
                  "agent_version": agent, "seen_min": seen, "attributes": attrs})
    host("eoc-app-xyz-01", "10.10.50.21", ["app:xyz", "costcenter:eoc", "geolocation:boston", "env:prod", "role:app", "team:noc"], "Windows Server 2022", datadog_host_id="i-0a1b2c3d4e5f6g7h8")
    host("eoc-app-xyz-02", "10.10.50.22", ["app:xyz", "costcenter:eoc", "geolocation:boston", "env:prod", "role:app"], "Windows Server 2022")
    host("eoc-db-xyz-01", "10.10.50.30", ["app:xyz", "costcenter:eoc", "tier:1", "env:prod", "role:db"])
    host("eoc-web-01", "10.10.50.40", ["app:xyz", "env:prod", "role:web"], status="Warning", seen=1)
    host("eoc-web-02", "10.10.50.41", ["app:xyz", "env:prod", "role:web", "costcenter:eoc"])
    host("eoc-batch-01", "10.10.50.50", ["app:xyz", "env:prod", "role:batch"], agent="7.52.0")
    host("bos-app-abc-01", "10.10.51.21", ["app:abc", "costcenter:bos", "geolocation:boston", "env:prod"])
    host("bos-app-abc-02", "10.10.51.22", ["app:abc", "costcenter:bos", "geolocation:boston", "env:prod"], status="Down", seen=95)
    host("bos-db-abc-01", "10.10.51.30", ["app:abc", "costcenter:bos", "tier:1", "env:prod", "role:db"], status="Alert")
    host("dev-app-xyz-01", "10.20.50.21", ["app:xyz", "env:dev", "costcenter:eoc"])
    host("dev-app-xyz-02", "10.20.50.22", ["app:xyz", "env:dev"])
    host("dev-db-01", "10.20.50.30", ["env:dev", "role:db"], agent="7.49.1")
    host("lab-k8s-node-01", "10.30.10.11", ["env:lab", "kube_cluster:lab-1", "costcenter:rnd"])
    host("lab-k8s-node-02", "10.30.10.12", ["env:lab", "kube_cluster:lab-1", "costcenter:rnd"])
    host("lab-k8s-node-03", "10.30.10.13", ["env:lab", "kube_cluster:lab-1"], status="Down", seen=60 * 30)
    host("test-runner-01", "10.40.10.5", ["env:test", "role:ci"])
    host("test-runner-02", "10.40.10.6", ["env:test", "role:ci"])
    host("legacy-ftp-01", "10.10.50.40", [], "Windows Server 2012 R2", agent="6.19.0", seen=60 * 72)  # duplicate IP + missing tags + stale
    for i, (n, ip) in enumerate([("eoc-vm-xyz-01", "10.10.50.61"), ("eoc-vm-xyz-02", "10.10.50.62"), ("eoc-vm-db-01", "10.10.50.63"),
                                ("bos-vm-abc-01", "10.10.51.61"), ("lab-vm-01", "10.30.20.11"), ("lab-vm-02", "10.30.20.12")]):
        tags = ["vmware:true", f"esxi_host:esx-{'bos' if 'bos' in n else 'eoc'}-0{i % 2 + 1}", "vsphere_cluster:cl-prod" if "lab" not in n else "vsphere_cluster:cl-lab"]
        tags += ["app:xyz", "env:prod"] if "xyz" in n or "db" in n else (["app:abc", "env:prod"] if "abc" in n else ["env:lab"])
        host(n, ip, tags, status="Up" if i != 4 else "Warning", kind="VMware", inferred_type=True)
    host("aws-xyz-prod", "10.60.20.20", ["app:xyz", "cloud:aws", "region:us-east-1", "env:prod", "instance-type:m6i.large"], "Amazon Linux 2023", agent="", kind="Cloud", inferred_type=True)
    host("aws-abc-rds", "10.60.21.10", ["app:abc", "cloud:aws", "region:us-east-1", "env:prod", "aws_service:rds"], "", agent="", kind="Cloud", inferred_type=True)
    for h in H:
        h["aliases"] = DEMO_ALIASES.get(h["name"], [])
    return H


# AWS-style aliases: EC2 instance IDs, private/public DNS names, Name tags and an RDS endpoint.
DEMO_ALIASES = {
    "eoc-app-xyz-01": ["i-0a1b2c3d4e5f6g7h8", "ip-10-10-50-21.ec2.internal", "EOC-XYZ-App-Primary"],
    "eoc-app-xyz-02": ["i-0b2c3d4e5f6a7b8c9", "ip-10-10-50-22.ec2.internal", "EOC-XYZ-App-Secondary"],
    "eoc-db-xyz-01": ["i-0c3d4e5f6a7b8c9d0", "ip-10-10-50-30.ec2.internal"],
    "eoc-web-01": ["i-0d4e5f6a7b8c9d0e1", "ip-10-10-50-40.ec2.internal", "ec2-54-210-12-40.compute-1.amazonaws.com"],
    "eoc-web-02": ["i-0e5f6a7b8c9d0e1f2", "ip-10-10-50-41.ec2.internal", "ec2-54-210-12-41.compute-1.amazonaws.com"],
    "dev-app-xyz-01": ["i-0f6a7b8c9d0e1f2a3", "ip-10-20-50-21.us-west-2.compute.internal"],
    "dev-app-xyz-02": ["i-01a2b3c4d5e6f7a8b", "ip-10-20-50-22.us-west-2.compute.internal"],
    "lab-k8s-node-01": ["i-02b3c4d5e6f7a8b9c", "ip-10-30-10-11.ec2.internal", "lab-1-nodegroup-a"],
    "lab-k8s-node-02": ["i-03c4d5e6f7a8b9c0d", "ip-10-30-10-12.ec2.internal", "lab-1-nodegroup-a"],
    "lab-k8s-node-03": ["i-04d5e6f7a8b9c0d1e", "ip-10-30-10-13.ec2.internal", "lab-1-nodegroup-b"],
    "aws-xyz-prod": ["i-09f8e7d6c5b4a3210", "ip-10-60-20-20.ec2.internal", "ec2-3-91-44-20.compute-1.amazonaws.com", "XYZ-Prod-Web"],
    "aws-abc-rds": ["abc-prod-db", "abc-prod-db.c9akciq32xyz.us-east-1.rds.amazonaws.com"],
    "legacy-ftp-01": ["LEGACYFTP01", "legacy-ftp-01.corp.example.com"],
}


DEVICES = [
    ("bos-core-sw01", "10.10.50.10", "Up", "Cisco", "Catalyst 9500", ["type:switch", "vendor:cisco", "geolocation:boston", "env:prod"]),
    ("bos-fw-01", "10.10.50.11", "Up", "Check Point", "Quantum 6600", ["type:firewall", "vendor:checkpoint", "geolocation:boston", "env:prod"]),
    ("bos-edge-rtr-01", "10.10.50.12", "Warning", "Cisco", "ASR 1001-X", ["type:router", "vendor:cisco", "geolocation:boston", "env:prod"]),
    ("bos-dist-sw02", "10.10.50.13", "Up", "Arista", "7050X3", ["type:switch", "vendor:arista", "geolocation:boston", "env:prod"]),
    ("eoc-lb-01", "10.10.50.20", "Up", "F5", "BIG-IP i5800", ["type:loadbalancer", "vendor:f5", "app:xyz", "env:prod"]),
    ("nyc-core-sw01", "10.50.0.10", "Alert", "Cisco", "Nexus 9300", ["type:switch", "vendor:cisco", "geolocation:nyc", "env:prod"]),
    ("lab-wifi-ap-01", "10.30.0.50", "Up", "Aruba", "AP-535", ["type:wireless", "vendor:aruba", "env:lab"]),
]

MONITORS = [
    ("XYZ - URL Availability", "Alert", "synthetics alert", "", ["app:xyz", "type:synthetic", "team:noc"], False),
    ("XYZ - Process Status", "OK", "process.up", "process:\"xyz.exe\" over host:eoc-app-xyz-01", ["app:xyz", "type:process"], False),
    ("XYZ - Host Availability", "OK", "service check", "\"datadog.agent.up\".over(\"app:xyz\")", ["app:xyz", "type:host"], False),
    ("XYZ - High CPU on eoc-app-xyz-01", "OK", "metric alert", "avg(last_5m):avg:system.cpu.user{host:eoc-app-xyz-01} > 90", ["app:xyz", "type:metric"], False),
    ("XYZ - Disk Space eoc-db-xyz-01", "Warn", "metric alert", "max(last_10m):max:system.disk.in_use{host:eoc-db-xyz-01} > 0.85", ["app:xyz", "type:metric"], False),
    ("XYZ - Web 5xx Rate", "Warn", "metric alert", "sum(last_5m):sum:trace.http.request.errors{service:xyz-web} > 50", ["app:xyz", "service:xyz-web"], False),
    ("ABC - Database Alert", "Alert", "metric alert", "avg(last_5m):avg:postgresql.connections{host:bos-db-abc-01} > 400", ["app:abc", "type:database"], False),
    ("ABC - Host Down bos-app-abc-02", "Alert", "service check", "\"datadog.agent.up\".over(\"host:bos-app-abc-02\")", ["app:abc", "type:host"], False),
    ("BOS - Core Switch Interface Errors", "OK", "metric alert", "avg(last_15m):avg:snmp.ifInErrors{device_name:bos-core-sw01} > 10", ["geolocation:boston", "type:network"], False),
    ("NYC - Core Switch Unreachable", "Alert", "service check", "\"snmp.can_check\".over(\"device_name:nyc-core-sw01\")", ["geolocation:nyc", "type:network"], False),
    ("LAB - Kubernetes Node NotReady", "OK", "metric alert", "max(last_5m):max:kubernetes_state.node.status{kube_cluster:lab-1,status:notready} > 0", ["env:lab", "type:kubernetes"], True),
    ("DEV - Nightly Batch Duration", "No Data", "metric alert", "avg(last_1h):avg:custom.batch.duration{env:dev} > 3600", ["env:dev", "type:batch"], True),
]

SYNTHETICS = [
    ("XYZ Login Journey", "abc-123-xyz", "browser", "https://xyz.example.internal/login", "OK", ["app:xyz", "env:prod"]),
    ("XYZ URL Availability", "def-456-xyz", "api", "https://xyz.example.internal/health", "Alert", ["app:xyz", "env:prod", "type:synthetic"]),
    ("ABC API Health", "ghi-789-abc", "api", "https://abc.example.internal/api/health", "OK", ["app:abc", "env:prod"]),
]

SERVICES = [
    ("xyz-web", ["app:xyz", "env:prod", "team:noc", "language:dotnet"]),
    ("xyz-api", ["app:xyz", "env:prod", "team:noc", "language:python"]),
    ("xyz-db", ["app:xyz", "env:prod", "team:dba"]),
    ("abc-api", ["app:abc", "env:prod", "team:platform", "language:go"]),
]

DASHBOARDS = [
    ("XYZ Application Overview", "xyz-ovr-001", ["app:xyz", "costcenter:eoc"]),
    ("Boston Network Health", "bos-net-002", ["geolocation:boston", "type:network"]),
]


def seed(force: bool = False) -> int:
    """Insert DEMO records (idempotent). Returns the number of records written."""
    site = settings.datadog_site
    with db.conn() as c, c.transaction():
        org_id = db.default_org_id(c)
        if not force and c.execute("SELECT 1 FROM resources WHERE source='DEMO' LIMIT 1").fetchone():
            return 0
        version = int(time.time() * 1000)
        rng = random.Random(7)
        n = 0
        for h in _hosts():
            offset = h.pop("seen_min")
            seen = NOW() - timedelta(minutes=offset)
            attrs = h.pop("attributes")
            attrs["demo_offset_min"] = offset
            attrs.setdefault("cpu_cores", rng.choice([2, 4, 8, 16]))
            inventory.upsert(c, org_id, "DEMO", {**h, "external_id": h["name"], "deep_link": link(site, h["type"], h["name"]),
                             "created_at": NOW() - timedelta(days=rng.randint(30, 400)), "last_observed": seen,
                             "attributes": attrs}, version); n += 1
        for name, ip, status, vendor, model, tags in DEVICES:
            inventory.upsert(c, org_id, "DEMO", {"type": "Device", "external_id": f"default:{ip}", "name": name, "ips": [ip],
                             "status": status, "vendor": vendor, "model": model, "tags": tags, "os": f"{vendor} OS",
                             "deep_link": link(site, "Device", name), "last_observed": NOW() - timedelta(minutes=rng.randint(0, 3)),
                             "attributes": {"device_type": tags[0].split(":")[1], "namespace": "default",
                                            "location": "Boston DC1" if "boston" in str(tags) else ""}}, version); n += 1
        for i, (name, status, mtype, q, tags, muted) in enumerate(MONITORS):
            mid = str(1000100 + i)
            inventory.upsert(c, org_id, "DEMO", {"type": "Monitor", "external_id": mid, "name": name, "status": status,
                             "muted": muted, "tags": tags, "deep_link": link(site, "Monitor", mid),
                             "monitor": {"type": mtype, "query": q, "message": f"@noc-oncall {name}"},
                             "last_observed": NOW() - timedelta(minutes=rng.randint(0, 30)),
                             "attributes": {"monitor_type": mtype, "priority": rng.choice([1, 2, 3])}}, version); n += 1
        for name, pid, ttype, url, status, tags in SYNTHETICS:
            mon = "1000100" if "URL" in name else None
            inventory.upsert(c, org_id, "DEMO", {"type": "Synthetic", "external_id": pid, "name": name, "status": status,
                             "tags": tags, "deep_link": link(site, "Synthetic", pid), "last_observed": NOW(),
                             "attributes": {"url": url, "test_type": ttype, "locations": ["aws:us-east-1", "aws:us-west-2"],
                                            "monitor_id": mon}}, version); n += 1
        for name, tags in SERVICES:
            inventory.upsert(c, org_id, "DEMO", {"type": "Service", "external_id": name, "name": name,
                             "status": "Warning" if name == "xyz-web" else "OK", "tags": tags,
                             "deep_link": link(site, "Service", name), "last_observed": NOW(),
                             "attributes": {"team": [t for t in tags if t.startswith("team:")][0][5:]}}, version); n += 1
        for name, did, tags in DASHBOARDS:
            inventory.upsert(c, org_id, "DEMO", {"type": "Dashboard", "external_id": did, "name": name, "status": "OK",
                             "tags": tags, "deep_link": link(site, "Dashboard", did), "last_observed": NOW(),
                             "attributes": {"description": f"{name} for NOC shifts"}}, version); n += 1
        n += _seed_extended(c, org_id, version, site, rng)
        n += inventory.rebuild_tags(c, org_id, "DEMO", version, lambda t: link(site, "Tag", t))
        inventory.rebuild_relationships(c, org_id)
        _seed_history(c, org_id)
    db.bump_data_version()
    return n


def purge() -> int:
    with db.conn() as c:
        n = c.execute("DELETE FROM resources WHERE source='DEMO'").rowcount
        c.execute("DELETE FROM resource_changes WHERE source='DEMO'")
    db.bump_data_version()
    return n


# ---- Kubernetes, interfaces and AWS service resources -----------------------------------
K8S = {
    # cluster: (nodes, env, [(namespace, deployment, replicas, containers, image, state-override)])
    "lab-1": (["lab-k8s-node-01", "lab-k8s-node-02", "lab-k8s-node-03"], "lab", [
        ("xyz", "xyz-api", 3, ["xyz-api", "istio-proxy"], "registry.example.com/xyz-api:2.4.1", None),
        ("xyz", "xyz-worker", 2, ["xyz-worker"], "registry.example.com/xyz-worker:2.4.1", {1: "exited"}),
        ("monitoring", "datadog-agent", 3, ["agent", "trace-agent", "process-agent"], "gcr.io/datadoghq/agent:7.75.3", None),
        ("kube-system", "coredns", 2, ["coredns"], "registry.k8s.io/coredns/coredns:v1.11.1", None),
    ]),
    "prod-eks-1": (["ip-10-60-30-11.ec2.internal", "ip-10-60-30-12.ec2.internal"], "prod", [
        ("abc", "abc-api", 2, ["abc-api"], "723527124594.dkr.ecr.us-east-1.amazonaws.com/abc-api:1.9.0", None),
        ("abc", "abc-frontend", 2, ["nginx", "abc-frontend"], "723527124594.dkr.ecr.us-east-1.amazonaws.com/abc-frontend:1.9.0", None),
    ]),
}

INTERFACES = {
    "bos-core-sw01": [("Gi1/0/1", "Uplink to bos-edge-rtr-01", "up"), ("Gi1/0/2", "eoc-app-xyz-01", "up"),
                      ("Gi1/0/3", "eoc-app-xyz-02", "up"), ("Gi1/0/24", "spare", "down"), ("Vlan50", "SVI 10.10.50.1", "up")],
    "bos-edge-rtr-01": [("Gi0/0/0", "ISP-A", "up"), ("Gi0/0/1", "ISP-B", "down"), ("Gi0/0/2", "to bos-core-sw01", "up")],
    "bos-fw-01": [("eth1", "outside", "up"), ("eth2", "inside", "up"), ("eth3", "dmz", "up")],
    "nyc-core-sw01": [("Eth1/1", "uplink", "down"), ("Eth1/2", "server-farm", "down")],
}

DATABASES = [
    # engine, host, instance (db / port / cluster), tags
    ("PostgreSQL", "eoc-db-xyz-01", "orders", ["app:xyz", "env:prod", "team:dba"]),
    ("PostgreSQL", "eoc-db-xyz-01", "customers", ["app:xyz", "env:prod", "team:dba"]),
    ("PostgreSQL", "bos-db-abc-01", "abc", ["app:abc", "env:prod", "team:dba"]),
    ("MySQL", "dev-db-01", "", ["env:dev", "team:dba"]),
    ("Redis", "eoc-vm-db-01", "6379", ["app:xyz", "env:prod"]),
    ("MongoDB", "lab-vm-01", "", ["env:lab"]),
]

AWS_RESOURCES = [
    ("Lambda", "xyz-image-resizer", "us-east-1", ["app:xyz", "env:prod"]),
    ("Lambda", "xyz-nightly-report", "us-east-1", ["app:xyz", "env:prod"]),
    ("Lambda", "abc-webhook-handler", "us-west-2", ["app:abc", "env:prod"]),
    ("S3", "xyz-prod-assets", "us-east-1", ["app:xyz", "env:prod", "costcenter:eoc"]),
    ("S3", "abc-backups", "us-west-2", ["app:abc", "env:prod"]),
    ("SQS", "xyz-orders-queue", "us-east-1", ["app:xyz", "env:prod"]),
    ("DynamoDB", "xyz-sessions", "us-east-1", ["app:xyz", "env:prod"]),
    ("ALB", "app/xyz-prod-alb/50dc6c495c0c9188", "us-east-1", ["app:xyz", "env:prod"]),
    ("ElastiCache", "abc-redis-001", "us-west-2", ["app:abc", "env:prod"]),
]


def _seed_extended(c, org_id, version, site, rng) -> int:
    n = 0
    for cluster, (nodes, env, deployments) in K8S.items():
        pods = 0
        for ns, dep, replicas, containers, image, overrides in deployments:
            for r in range(replicas):
                suffix = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(5))
                pod = f"{dep}-{rng.randint(5, 9)}d{rng.randint(10, 99)}f-{suffix}"
                pod_key = f"{cluster}/{ns}/{pod}"
                node = nodes[r % len(nodes)]
                states = []
                for cname in containers:
                    cid = "".join(rng.choice("0123456789abcdef") for _ in range(64))
                    state = (overrides or {}).get(r, "running") if cname == containers[0] else "running"
                    states.append(state)
                    tags = [f"kube_cluster_name:{cluster}", f"kube_namespace:{ns}", f"kube_deployment:{dep}",
                            f"pod_name:{pod}", f"kube_container_name:{cname}", f"env:{env}", f"image_name:{image.split(':')[0]}",
                            f"image_tag:{image.split(':')[-1]}"]
                    if ns in ("xyz", "abc"):
                        tags.append(f"app:{ns}")
                    upsert = inventory.upsert(c, org_id, "DEMO", {
                        "type": "Container", "external_id": cid, "name": cname, "status": state.title(), "tags": tags,
                        "aliases": [cid, cid[:12]], "deep_link": link(site, "Container", cid), "last_observed": NOW(),
                        "attributes": {"host": node, "image": image, "pod_key": pod_key, "cluster": cluster, "namespace": ns,
                                       "restarts": 4 if state != "running" else 0}}, version)
                    n += 1 if upsert else 0
                status = "Running" if all(s == "running" for s in states) else "Degraded"
                ptags = [f"kube_cluster_name:{cluster}", f"kube_namespace:{ns}", f"kube_deployment:{dep}", f"env:{env}"]
                if ns in ("xyz", "abc"):
                    ptags.append(f"app:{ns}")
                inventory.upsert(c, org_id, "DEMO", {
                    "type": "Pod", "external_id": pod_key, "name": pod, "status": status, "tags": ptags,
                    "deep_link": link(site, "Pod", pod), "last_observed": NOW(),
                    "attributes": {"cluster": cluster, "namespace": ns, "host": node, "containers": len(containers),
                                   "derived_from": "container tags"}}, version)
                n += 1; pods += 1
        inventory.upsert(c, org_id, "DEMO", {
            "type": "Cluster", "external_id": cluster, "name": cluster, "status": "OK",
            "tags": [f"kube_cluster_name:{cluster}", f"env:{env}"] + (["cloud:aws", "region:us-east-1"] if "eks" in cluster else []),
            "deep_link": link(site, "Cluster", cluster), "last_observed": NOW(),
            "attributes": {"pods": pods, "nodes": nodes, "node_count": len(nodes), "derived_from": "container tags"}}, version)
        n += 1
    for dev, ifaces in INTERFACES.items():
        for idx, (ifname, desc, state) in enumerate(ifaces, start=1):
            mac = ":".join(f"{rng.randint(0, 255):02x}" for _ in range(6))
            ips = ["10.10.50.1"] if ifname == "Vlan50" else []
            inventory.upsert(c, org_id, "DEMO", {
                "type": "Interface", "external_id": f"{dev}:{idx}", "name": f"{dev} {ifname}", "status": state.title(),
                "ips": ips, "aliases": [mac, desc], "tags": [f"device_name:{dev}", f"interface:{ifname}", "env:prod"],
                "deep_link": link(site, "Interface", dev), "last_observed": NOW(),
                "attributes": {"device_id": f"default:{[d for d in DEVICES if d[0] == dev][0][1]}", "device": dev, "interface": ifname,
                               "index": idx, "mac_address": mac, "description": desc}}, version)
            n += 1
    for engine, host, inst, tags in DATABASES:
        slug = engine.lower()
        name = f"{inst}@{host}" if engine == "PostgreSQL" else (f"{slug}@{host}:{inst}" if inst else f"{slug}@{host}")
        inventory.upsert(c, org_id, "DEMO", {
            "type": "Database", "external_id": f"db:{slug}:{host}:{inst}", "name": name,
            "status": "Warning" if host == "bos-db-abc-01" else "OK", "tags": [*tags, f"db_engine:{slug}"],
            "aliases": [a for a in (inst, f"{host}:{inst}" if inst else "") if a], "vendor": engine, "model": engine,
            "last_observed": NOW(),
            "attributes": {"engine": engine, "host": host, "db" if engine == "PostgreSQL" else "instance": inst or None,
                           "discovered_via": "database integration metrics (demo)", "inferred_type": True}}, version)
        n += 1
    for service, rid, region, tags in AWS_RESOURCES:
        svc = service.lower()
        inventory.upsert(c, org_id, "DEMO", {
            "type": "Cloud", "external_id": f"aws:{svc}:{region}:{rid}", "name": rid, "status": "OK",
            "tags": [*tags, "cloud:aws", f"aws_service:{svc}", f"region:{region}", "aws_account:723527124594"],
            "aliases": [f"{service}:{rid}"], "vendor": "AWS", "model": service, "last_observed": NOW(),
            "attributes": {"aws_service": service, "region": region, "discovered_via": "integration metrics (demo)",
                           "inferred_type": True}}, version)
        n += 1
    return n


def _seed_history(c, org_id) -> None:
    """A few days of plausible changes so the What Changed view is explorable in demo mode."""
    c.execute("DELETE FROM resource_changes WHERE source='DEMO'")
    rows = {r["name"]: r for r in c.execute(
        "SELECT id, type, external_id, name FROM resources WHERE source='DEMO' AND type <> 'Tag'")}
    tracker = inventory.ChangeTracker(org_id)
    events = [
        (0.2, "bos-app-abc-02", "status", {"status": "Up"}, {"status": "Down"}, "status Up → Down"),
        (0.5, "ABC - Database Alert", "status", {"status": "OK"}, {"status": "Alert"}, "status OK → Alert"),
        (1.5, "eoc-web-01", "status", {"status": "Up"}, {"status": "Warning"}, "status Up → Warning"),
        (2.0, "XYZ - URL Availability", "status", {"status": "OK"}, {"status": "Alert"}, "status OK → Alert"),
        (3.0, "eoc-web-02", "tags", {"removed": ["env:staging"]}, {"added": ["env:prod", "costcenter:eoc"]}, "tags: +costcenter:eoc +env:prod −env:staging"),
        (5.0, "aws-xyz-prod", "ips", {"removed": ["10.60.20.19"]}, {"added": ["10.60.20.20"]}, "ips: +10.60.20.20 −10.60.20.19"),
        (8.0, "nyc-core-sw01", "status", {"status": "Up"}, {"status": "Alert"}, "status Up → Alert"),
        (20.0, "eoc-batch-01", "added", None, {"ips": ["10.10.50.50"]}, "first seen (10.10.50.50)"),
        (26.0, "dev-app-xyz-02", "renamed", {"name": "dev-app-xyz-2"}, {"name": "dev-app-xyz-02"}, "renamed from dev-app-xyz-2"),
        (30.0, "lab-k8s-node-03", "status", {"status": "Up"}, {"status": "Down"}, "status Up → Down"),
        (50.0, "eoc-app-xyz-01", "aliases", {"removed": []}, {"added": ["EOC-XYZ-App-Primary"]}, "aliases: +EOC-XYZ-App-Primary"),
        (70.0, "legacy-ftp-01", "status", {"status": "Up"}, {"status": "Down"}, "status Up → Down"),
    ]
    for hours, name, change, before, after, summary in events:
        r = rows.get(name)
        if not r:
            continue
        tracker.record(c, r["id"], inventory.resource_key("DEMO", r["type"], r["external_id"]), "DEMO", r["type"], name,
                       change, before, after, summary)
        c.execute("UPDATE resource_changes SET at = now() - make_interval(secs => %s) WHERE id = (SELECT max(id) FROM resource_changes)",
                  (hours * 3600,))
    for hours, name, typ, ips, last in [(4.0, "eoc-web-03", "Host", ["10.10.50.42"], 6.0), (40.0, "bos-old-sw09", "Device", ["10.10.50.99"], 41.0)]:
        tracker.record(c, None, inventory.resource_key("DEMO", typ, name), "DEMO", typ, name, "removed",
                       {"status": "Up", "ips": ips, "tags": ["env:prod"], "aliases": []}, None,
                       f"no longer reported by Datadog (last seen {last:.0f}h before removal)")
        c.execute("UPDATE resource_changes SET at = now() - make_interval(secs => %s) WHERE id = (SELECT max(id) FROM resource_changes)",
                  (hours * 3600,))
