# Datadog data sources

The worker collects inventory from the Datadog API through **collectors** (data sources). Each one can be switched on or off
in **Admin › Datadog Config › Data sources & freshness**. Every collector is fetched, upserted and pruned on its own, so a
failure in one never affects the others.

- [Overview](#overview)
- [Permissions](#permissions)
- [Hosts](#hosts) · [Monitors](#monitors) · [Network devices](#network-devices) · [Device interfaces](#device-interfaces)
- [Containers, pods & clusters](#containers-pods--clusters) · [Services](#services) · [Synthetic tests](#synthetic-tests)
- [Dashboards](#dashboards) · [AWS services](#aws-services) · [Tags](#tags)
- [Relationships](#relationships)
- [Normalised resource model](#normalised-resource-model)
- [Resilience, rate limits and error categories](#resilience-rate-limits-and-error-categories)
- [Deep links](#deep-links)
- [Live (on-demand) lookups](#live-on-demand-lookups)
- [Disabling a source](#disabling-a-source)

## Overview

| Source key | Label | Resource types | Datadog API | Calls per sync |
|---|---|---|---|---|
| `hosts` | Hosts | Host, VMware, Cloud | `GET /api/v1/hosts` | 1 per 1,000 hosts |
| `monitors` | Monitors | Monitor | `GET /api/v1/monitor` | 1 per 1,000 monitors |
| `devices` | Network devices | Device | `GET /api/v2/ndm/devices` | 1 per 100 devices |
| `interfaces` | Device interfaces | Interface | `GET /api/v2/ndm/devices` + `GET /api/v2/ndm/interfaces` | 1 per device (max 500 devices) |
| `kubernetes` | Containers, pods & clusters | Container, Pod, Cluster | `GET /api/v2/containers` | 1 per 1,000 containers |
| `services` | Services (APM / Service Catalog) | Service | `GET /api/v2/services/definitions` | 1 per 100 services |
| `synthetics` | Synthetic tests | Synthetic | `GET /api/v1/synthetics/tests` | 1 |
| `dashboards` | Dashboards | Dashboard | `GET /api/v1/dashboard` | 1 per 100 dashboards |
| `aws` | AWS services | Cloud | `GET /api/v1/query` (integration metrics) | 17 (one per AWS service) |
| `tags` | Tags (derived) | Tag | none: derived from all records | 0 |

The **Data sources & freshness** table shows, for each source: whether it's enabled, the record count per resource type, the last
success, the last attempt, and the state (OK, or an [error category](#resilience-rate-limits-and-error-categories) with the message).

## Permissions

Use a dedicated, **read-only** service account. Datadog requires an **API key** (identifies the organization) and an
**application key** (carries the user's or service account's permissions). If you use *scoped* application keys, grant read scopes
for the sources you enable. Scope names vary by Datadog release, so check them in *Organization Settings › Application Keys*.

| Source | Typical scope / permission |
|---|---|
| Key validation | API key only (`/api/v1/validate`) |
| hosts | `hosts_read` |
| monitors | `monitors_read` |
| devices, interfaces | Network Device Monitoring read access (NDM must be enabled for the org) |
| kubernetes | Containers read access (Containers / Orchestrator Explorer) |
| services | `apm_service_catalog_read` |
| synthetics | `synthetics_read` |
| dashboards | `dashboards_read` |
| aws | `timeseries_query` (metrics query) |
| Inspector › Metrics tab (live) | `timeseries_query` |
| Inspector › Logs tab (live) | `logs_read_data` |

**Test connection** checks the API key (`/api/v1/validate`) and the application key (a one-item monitor list).
A source the key cannot read reports **Permission denied** in the freshness table, and the other sources keep working.

## Hosts

`GET /api/v1/hosts?start=…&count=1000&include_muted_hosts_data=true`, paginated with `total_matching`.

| Resource field | From |
|---|---|
| name | `host_name` (fallback `name`, `id`) |
| external_id | Datadog host `id` |
| status | `Up` when `up` is true, else `Down`. `muted` comes from `is_muted` |
| ips | `meta.gohai.network.ipaddress` / `ipaddressv6`, interface IPv4s, and numeric host aliases. Only valid IPs are kept, and loopback is dropped |
| aliases | host `aliases` (AWS instance ID, EC2 DNS, cloud hostnames) plus values of the tag keys `instance-id`, `instance_id`, `aws_instance_id`, `name` (AWS Name tag), `dbinstanceidentifier`, `dbclusteridentifier`, `loadbalancername`, `aws_ec2_instance_id`, `host_alias` |
| tags | all `tags_by_source` values |
| os | gohai platform OS, or `meta.platform` (Windows detected from `winV`) |
| agent_version | `meta.agent_version` |
| type | **VMware** when the `vsphere` app or source is present; **Cloud** when there's no agent and the source is `aws`, `azure`, `gcp` or `gce`; otherwise **Host**. Inferred types show an *inferred* badge |
| last_observed | `last_reported_time` |

## Monitors

`GET /api/v1/monitor?page=N&page_size=1000`.

| Field | From |
|---|---|
| name, external_id | `name`, `id` |
| status | `overall_state` (Alert, Warn, No Data, OK…). **Muted** when `options.silenced` is not empty |
| tags | `tags` |
| query / message / monitor type | stored in the `monitors` table, shown in the inspector |
| last_observed | `overall_state_modified` |

A monitor's query and tags are scanned for `host:<name>` and `device_name:<name>`. Matching hosts and devices are linked
(“Scoped to” / “Monitors”). Monitors that share an `app:`/`service:` tag with a resource also appear in its Monitors tab, with the evidence
“shared tag …”.

The inspector's **Refresh live status** button re-reads one monitor (`GET /api/v1/monitor/{id}`) and records any status change in the history.

## Network devices

`GET /api/v2/ndm/devices?page[size]=100&page[number]=N`. Requires Network Device Monitoring.

| Field | From |
|---|---|
| name | `attributes.name` / `device_name` |
| external_id | device `id` (e.g. `default:10.10.50.10`) |
| status | `attributes.status` |
| ips | `ip_address` |
| vendor / model / os | `vendor`, `model`, `os_name` |
| attributes | `device_type`, `location`, `namespace`, `serial_number` |

If the org doesn't have NDM, this source reports **Not available for org/site** and is skipped.

## Device interfaces

For each device (up to 500 per sync): `GET /api/v2/ndm/interfaces?device_id=<id>&get_ip_addresses=true`.

| Field | From |
|---|---|
| name | `<device name> <interface name>` (e.g. `bos-core-sw01 Gi1/0/1`) |
| external_id | interface `id` (or `<device id>:<index>`) |
| status | interface `status` (Up / Down) |
| ips | `ip_addresses` (prefix length removed) |
| aliases | lower-case MAC address, interface alias and description, so `mac:` and free text can find them |
| tags | `device_name:<device>`, `interface:<name>`, plus the device's `env:`, `geolocation:` and `site:` tags |
| relationship | `interface_of` → its device |

## Containers, pods & clusters

`GET /api/v2/containers?page[size]=1000`, paginated with `meta.pagination.next_cursor`.

**Containers** (Docker and Kubernetes):

| Field | From |
|---|---|
| name | `attributes.name` (else the short ID) |
| external_id | `container_id` |
| status | `state` (Running, Exited…) |
| aliases | the full container ID and its 12-character short ID |
| tags | all container tags (`image_name`, `kube_namespace`, `pod_name`, `env`, …) |
| attributes | host, image, image tags and digest, namespace, cluster, start time |
| relationships | `runs_on` → host (by hostname); `runs_in` → pod |

**Pods** are derived by grouping containers by `kube_cluster_name` / `kube_namespace` / `pod_name`:

- status: **Running** if all containers are running, **Degraded** if some are, otherwise **Failed**;
- tags: the pod-level keys (`kube_*`, `env`, `service`, `version`, `team`, `app`);
- relationship: `member_of` → its cluster.

**Clusters** are derived from `kube_cluster_name` (or `kube_cluster`): node list and count, pod count and namespaces.
Hosts carrying `kube_cluster_name:` / `kube_cluster:` tags are linked to their cluster (`member_of`).

> Plain Docker containers (no `kube_*` tags) appear as containers linked to their host. No pods or clusters are derived for them.

## Services

`GET /api/v2/services/definitions`. Each Service Catalog definition becomes a **Service** with `dd-service` as its name, plus
team, tier, languages and description. A `team:<team>` tag is added.

## Synthetic tests

`GET /api/v1/synthetics/tests`. Name, public ID, type and subtype, request URL, locations, tags, and **Paused** status when the test is paused.
The backing `monitor_id` links the test to its monitor (`backed_by`).

## Dashboards

`GET /api/v1/dashboard?count=100&start=N`. Title, ID, description, author, layout and tags.

## AWS services

AWS resources that have no Datadog host are discovered from **AWS integration metrics reported in the last 4 hours**. For each
service, the collector runs one metrics query grouped by the identifying tag, and turns each distinct series into a **Cloud** resource:

| Service | Metric | Identifying tag | `aws_service:` |
|---|---|---|---|
| Lambda | `aws.lambda.invocations` | `functionname` | `lambda` |
| RDS | `aws.rds.cpuutilization` | `dbinstanceidentifier` | `rds` |
| ALB | `aws.applicationelb.request_count` | `loadbalancer` | `alb` |
| Classic ELB | `aws.elb.request_count` | `loadbalancername` | `elb` |
| NLB | `aws.networkelb.active_flow_count` | `loadbalancer` | `nlb` |
| S3 | `aws.s3.bucket_size_bytes` | `bucketname` | `s3` |
| DynamoDB | `aws.dynamodb.consumed_read_capacity_units` | `tablename` | `dynamodb` |
| SQS | `aws.sqs.approximate_number_of_messages_visible` | `queuename` | `sqs` |
| SNS | `aws.sns.number_of_messages_published` | `topicname` | `sns` |
| ECS | `aws.ecs.cpuutilization` | `clustername` | `ecs` |
| EKS | `aws.eks.cluster_failed_request_count` | `clustername` | `eks` |
| ElastiCache | `aws.elasticache.cpuutilization` | `cacheclusterid` | `elasticache` |
| CloudFront | `aws.cloudfront.requests` | `distributionid` | `cloudfront` |
| API Gateway | `aws.apigateway.count` | `apiname` | `apigateway` |
| Kinesis | `aws.kinesis.incoming_records` | `streamname` | `kinesis` |
| EFS | `aws.efs.client_connections` | `filesystemid` | `efs` |
| NAT Gateway | `aws.natgateway.active_connection_count` | `natgatewayid` | `natgateway` |

Each resource gets the tags `cloud:aws` and `aws_service:<service>`, the series' tags (`region`, `aws_account`, …), vendor `AWS`, model = service,
and an alias `<Service>:<id>`. Resources that stop reporting metrics for 4 hours disappear at the next sync (and are recorded as removed).
To add a service, add a row to `AWS_METRICS` in `api/app/datadog.py`.

**Coverage depends on which AWS namespaces your Datadog AWS integration collects.** If a service isn't enabled in the integration, it
won't appear here. EC2 instances come from the **Hosts** source.

## Tags

Derived after every sync. Each distinct tag across Datadog records becomes a **Tag** entity with its resource count and resource types,
so tags can be searched, browsed and correlated (“Same application”). Per-instance keys are skipped to avoid thousands of one-off tags:
`pod_name`, `container_id`, `container_name`, `kube_container_name`, `display_container_name`, `image_tag`, `image_id`, `short_image`,
`kube_replica_set`, `docker_image`, `pod_phase`, `kube_ownerref_name`, `interface`, `device_name`. Those tags remain searchable on the resources themselves.
Disabling the Tags source deletes Tag entities. Tags on resources are unaffected.

## Relationships

Stored in `resource_relationships` and recomputed after every sync (only added and removed edges are written):

| Relation | From → To | Evidence |
|---|---|---|
| `monitors` | Monitor → Host/Device | `host:` / `device_name:` in the monitor query or tags |
| `runs_on` | Container/Pod → Host | container `host` attribute = host name |
| `runs_in` | Container → Pod | same cluster/namespace/pod |
| `member_of` | Pod → Cluster; Host → Cluster | pod's cluster; node `kube_cluster_name`/`kube_cluster` tag |
| `interface_of` | Interface → Device | interface's device ID |
| `backed_by` | Synthetic → Monitor | test `monitor_id` |

These are computed at query time:

- **Same application**: resources sharing an `app:` or `service:` tag.
- **Shares an IP**: resources with an IP in common. This is explicitly *not* proof that they're the same machine.

## Normalised resource model

Every record, whatever its source, is stored as one row in `resources`:

`type, name, external_id, status, status_group (ok|alert|warn|muted|unknown), ips[], aliases[], tags[], env, os, vendor, model,
agent_version, deep_link, attributes (JSON), created_at, first_indexed, last_indexed, last_observed, source (Datadog|DEMO), collector, content_hash, sync_version`.
Records whose content fingerprint is unchanged are not rewritten during a sync. See [architecture.md › Write efficiency](architecture.md#write-efficiency).

The uniqueness key is `(org, source, type, external_id)`. `env` is taken from the `env:` tag. `search_blob` is a lower-cased
concatenation of the searchable fields, with a trigram index.

## Resilience, rate limits and error categories

- 30 s timeout per request (10–15 s for live lookups).
- HTTP **429**: waits `X-RateLimit-Reset` seconds (capped at 60), then retries with exponential backoff, up to 5 attempts.
- **5xx** and network errors: exponential backoff (1, 2, 4, 8 s), up to 5 attempts.
- Errors are categorised and shown per source:

| Category | Meaning | Typical fix |
|---|---|---|
| Permission denied | 401/403 | Check the key scopes and the site |
| Not available for org/site | 404 | Product not enabled (e.g. NDM) or not available on that site |
| Source unavailable | network error or 5xx after retries | Check egress, proxies and Datadog status |
| Rate limited | still 429 after retries | Increase the sync interval, or disable heavy sources (interfaces) |
| Error | anything else (message shown) | See the worker logs |

A job is **success** with no errors, **partial** when some sources failed but records were collected, and **failed** otherwise.

## Deep links

Built only from the validated site and resource identifiers:

| Type | Link |
|---|---|
| Host / VMware / Cloud host | `https://<app-host>/infrastructure?host=<name>` |
| Device / Interface | `/devices?query=device_name:<name>` |
| Monitor | `/monitors/<id>` |
| Synthetic | `/synthetics/details/<public_id>` |
| Dashboard | `/dashboard/<id>` |
| Service | `/software?query=service:<name>` |
| Container | `/containers?query=container_id:<id>` |
| Pod | `/orchestration/explorer/pod?query=pod_name:<name>` |
| Cluster | `/orchestration/explorer/cluster?query=kube_cluster_name:<name>` |
| AWS service resource | Metrics Explorer for the discovery metric |
| Tag | `/infrastructure?tags=<tag>` |

`<app-host>` is `app.datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `app.datadoghq.eu`, `ap1.datadoghq.com`,
`ap2.datadoghq.com` or `app.ddog-gov.com`.

## Live (on-demand) lookups

| Inspector feature | API | Notes |
|---|---|---|
| Refresh live status (monitors) | `GET /api/v1/monitor/{id}` | Updates the record and history |
| Metrics tab (hosts, devices) | `GET /api/v1/query` for `system.cpu.user`, `system.mem.pct_usable`, `system.load.1` over 1 hour | Synthetic series for DEMO records |
| Logs tab (hosts, devices, services) | `POST /api/v2/logs/events/search`, `host:` or `service:`, last 60 minutes, 50 lines | Synthetic lines for DEMO records |

## Disabling a source

Unchecking a source in **Data sources & freshness** saves immediately. At the next sync, the collector is skipped and all of
its records are deleted. This is a configuration change, so it is **not** recorded as “removed” in the change history.
Re-enabling it treats the next collection as a new baseline only if the source has never synced successfully before. Otherwise, the
returning records are reported as **added**.
