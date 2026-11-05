# Search syntax reference

Datadog Discovery Engine has its own query language for operations work. It is **not** Datadog's native query syntax.
Queries run against the inventory indexed from Datadog. The in-app **Search Help** page has the same reference with a live
query tester and more than 100 runnable examples.

- [The three rules](#the-three-rules)
- [Grammar](#grammar)
- [Fields](#fields)
- [Match types](#match-types)
- [Boolean logic and precedence](#boolean-logic-and-precedence)
- [Tags](#tags)
- [IP addresses and CIDR](#ip-addresses-and-cidr)
- [Names, aliases, AWS IDs, MACs and container IDs](#names-aliases-aws-ids-macs-and-container-ids)
- [Type values](#type-values)
- [Status values](#status-values)
- [Presence: has: and missing:](#presence-has-and-missing)
- [Regular expressions](#regular-expressions)
- [How the query becomes SQL](#how-the-query-becomes-sql)
- [Scope, filters and the URL](#scope-filters-and-the-url)
- [Cookbook](#cookbook)
- [Common mistakes](#common-mistakes)
- [Limits](#limits)

> Have a **list** of IPs, hostnames or IDs rather than one query? Use **Bulk Lookup** instead. It takes up to 2,000 items and
> reports found / multiple / not found / previously seen for each. See [user-guide.md › Bulk Lookup](user-guide.md#bulk-lookup).

## The three rules

1. **Plain words search everything.** `xyz` finds resources where any indexed field contains “xyz”, case-insensitively.
2. **`field:value` is precise.** `name:eoc-*`, `ip:10.10.50.*`, `tag:app:xyz`.
3. **Adjacent terms are ANDed.** `app:xyz env:prod` means both. Use `OR` for either.

## Grammar

```
query      := or_expr
or_expr    := and_expr ( ("OR" | "||") and_expr )*
and_expr   := unary ( ("AND" | "&&")? unary )*        ← adjacency = AND
unary      := ("NOT" | "-") unary | "(" or_expr ")" | term
term       := [ "regex:" | "re:" ] [ field ":" ] value
value      := word | "quoted string" | /regex/
```

- Keywords `AND`, `OR` and `NOT` are case-insensitive. Quote them (`"or"`) to search for the literal word.
- A `-` counts as NOT only at the start of a term (`-env:dev`, `-(a OR b)`). Hyphens inside words are literal: `eoc-app-xyz-01`.
- Inside quotes, `\"` is a literal quote.

## Fields

| Field | Searches | Unquoted value matches | Examples |
|---|---|---|---|
| *(none)* | name, external ID, type, status, env, OS, vendor, model, IPs, aliases, tags | contains | `xyz`, `10.10.50.21` |
| `name:` | resource name, hostname or monitor title | contains | `name:web`, `name:eoc-*` |
| `ip:` | all IPv4 and IPv6 addresses | contains (CIDR supported) | `ip:10.10.50.*`, `ip:10.0.0.0/8` |
| `alias:` (`aliases:`, `aws:`, `mac:`) | aliases: AWS instance ID, EC2/RDS DNS, AWS Name tag, container IDs, interface MAC and description, alternate hostnames | contains | `alias:i-0a1b*`, `mac:00:1a:2b:*` |
| `tag:` | tags | exact `key:value`, or any tag with that key when given just `key` | `tag:app:xyz`, `tag:app` |
| `type:` | resource type | type name or alias. Unknown values fall back to the tag `type:<value>` | `type:pod`, `type:switch` |
| `status:` | status / status group | group name or exact raw status | `status:alert`, `status:"No Data"` |
| `env:` | environment (from the `env:` tag) | contains | `env:prod` |
| `os:` | operating system | contains | `os:windows` |
| `vendor:` · `model:` | device vendor / model; for AWS resources, vendor `AWS` and model = service | contains | `vendor:cisco`, `model:Lambda` |
| `agent:` | Datadog Agent version | contains | `agent:7.75`, `agent:6.*` |
| `id:` | Datadog identifier (host ID, monitor ID, synthetic public ID, dashboard ID, device ID, container ID) | contains | `id:1000100` |
| `source:` | `Datadog` or `DEMO` | contains | `source:datadog` |
| `has:` · `missing:` | presence of `ip alias os env vendor model agent tags` or any tag key | presence | `has:alias`, `missing:costcenter` |
| any other `key:` | treated as an exact tag | exact tag | `costcenter:eoc`, `kube_namespace:xyz`, `aws_service:s3` |

Field names are case-insensitive. A bare MAC address (`aa:bb:cc:dd:ee:ff`) is searched as text, not treated as a tag.

## Match types

| You type | Match | Behaviour | Example |
|---|---|---|---|
| plain value | contains | value appears anywhere in the field, case-insensitive | `name:web` → eoc-**web**-01 |
| `"quoted"` | exact | whole field equals value, case-insensitive. Required for spaces | `name:"XYZ - Process Status"` |
| contains `*` or `?` | wildcard | **anchored**: `*` = any run of characters, `?` = exactly one | `name:eoc-*` (starts with), `name:*-01` (ends with) |
| `a.b.c.d/nn` | CIDR | IP is inside the network (IPv4 or IPv6) | `10.10.50.0/24` |
| `regex:` prefix or `/…/` | regex | case-insensitive POSIX regex, **not** anchored unless you use `^`/`$` | `name:/^eoc-(app|db)-/` |

**Contains vs. wildcard:** `name:eoc` finds “geoc-1”. `name:eoc*` doesn't, because wildcards are anchored at the start.

## Boolean logic and precedence

Precedence from tightest to loosest: **NOT** → **AND** → **OR**.

| Typed | Parsed as |
|---|---|
| `a OR b c` | `a OR (b AND c)` |
| `(a OR b) c` | `(a OR b) AND c` |
| `-a OR b` | `(NOT a) OR b` |
| `a -(b OR c)` | `a AND NOT (b OR c)` |

The query tester on the Help page shows the parsed form, with every group in parentheses.

## Tags

Three ways to match `app:xyz`:

```
tag:app:xyz          explicit (exact, case-insensitive)
app:xyz              shorthand: unknown keys are tags
xyz                  free text (also matches names etc.)
```

| Goal | Query |
|---|---|
| Both tags | `app:xyz costcenter:abc` or `tag:app:xyz AND tag:costcenter:abc` |
| Either tag | `app:xyz OR costcenter:abc` |
| Any value of a key | `tag:app` or `has:app` |
| Wildcard value | `tag:app:x*`, `tag:*:boston` |
| Missing key | `missing:costcenter` |
| Literal tag whose key is also a field (`env`, `os`, `type`, `status`, `name`, `vendor`…) | `tag:type:switch`, `tag:name:xeomon` |
| Hide the Tag entities themselves | add `-type:tag` |

Tag searches also return **Tag** entities: one row per distinct tag, showing how many resources carry it.

## IP addresses and CIDR

| Goal | Query | Note |
|---|---|---|
| One address exactly | `ip:"10.10.50.21"` | quotes = exact |
| Address anywhere (quick) | `10.10.50.21` | contains: also .210–.219 |
| Prefix | `ip:10.10.50.*` | anchored wildcard |
| Range | `10.10.48.0/22`, `ip:fd00::/8` | most precise |
| Last octet | `ip:*.1` | |
| Exclude a range | `type:host -ip:10.30.0.0/16` | |
| No IP | `missing:ip` | |

Only syntactically valid IP addresses are stored, so CIDR comparisons never fail on bad data.

## Names, aliases, AWS IDs, MACs and container IDs

Aliases are alternate identifiers collected from Datadog:

| Alias kind | Source | Example query |
|---|---|---|
| EC2 instance ID | host aliases / `instance-id` tag | `i-0831170512d0e4fdb` |
| EC2 private / public DNS | host aliases | `alias:ip-172-31-*.ec2.internal` |
| AWS Name tag | `name:` tag on AWS hosts | `alias:XYZ-Prod-Web` |
| RDS / ELB identifiers | `dbinstanceidentifier`, `loadbalancername` tags | `alias:*.rds.amazonaws.com` |
| Container ID (full and 12-char short) | Containers API | `alias:3f2a9c*` |
| Interface MAC and description | NDM interfaces | `mac:00:1a:2b:*`, `alias:*uplink*` |
| AWS service resource | `<Service>:<id>` | `alias:Lambda:*` |

Free text searches aliases as well. When a row matched on an alias, it shows `alias: …` under the name.

## Type values

| Query | Type | Aliases |
|---|---|---|
| `type:host` | Host | `hosts`, `server` |
| `type:vmware` | VMware (inferred from vSphere metadata) | `vm`, `vsphere` |
| `type:cloud` | Cloud (agentless cloud hosts and AWS service resources) | `aws` |
| `type:device` | Network device (NDM) | `devices`, `network`, `ndm` |
| `type:interface` | Device interface | `interfaces`, `port`, `nic` |
| `type:monitor` | Monitor | `monitors` |
| `type:cluster` | Kubernetes cluster | `clusters`, `k8s`, `kubernetes` |
| `type:pod` | Kubernetes pod | `pods` |
| `type:container` | Container | `containers`, `docker` |
| `type:service` | APM / Service Catalog service | `services`, `apm` |
| `type:synthetic` | Synthetic test | `synthetics` |
| `type:dashboard` | Dashboard | `dashboards` |
| `type:tag` | Tag entity | `tags` |
| `type:<anything else>` | the tag `type:<value>` | e.g. `type:switch`, `type:firewall` |

## Status values

| Query | Matches |
|---|---|
| `status:ok` (`up`) | Up, OK, Running, Ready, live tests |
| `status:alert` (`down`, `critical`, `alerting`) | Alert, Down, Critical, Failed, Exited, CrashLoopBackOff, OOMKilled |
| `status:warn` (`warning`) | Warn, Warning, Degraded, Pending, Restarting |
| `status:muted` | muted monitors and hosts, paused tests |
| `status:unknown` (`nodata`) | No Data, Unknown and anything unmapped |
| `status:"No Data"` | exact raw status text |

## Presence: has: and missing:

`has:x` is true when field or tag key *x* is present, and `missing:x` when it is absent.

- Built-in: `ip`, `alias`, `os`, `env`, `vendor`, `model`, `agent`, `tags`
- Any tag key: `has:costcenter`, `missing:team`

```
type:host (missing:env OR missing:app OR missing:costcenter)
type:host missing:agent
type:host has:alias
```

## Regular expressions

- Prefix form: `regex:name:^bos-.*`. Without a field, it tests name, ID, type, status, OS, vendor, IPs, aliases and tags.
- Slash form: `name:/^eoc-(app|db)-xyz-\d+$/`
- Quote patterns that contain spaces: `regex:name:"^XYZ - "`
- PostgreSQL Advanced Regular Expressions, case-insensitive. Escape `. ( ) [ ] + ? \` with `\`.
- Validated before execution. Invalid patterns return an error that names the problem.
- Each search runs under a 5-second statement timeout.

## How the query becomes SQL

1. A **tokenizer** splits the input into parentheses, operators and terms (respecting quotes, `/regex/` and nested parentheses inside terms).
2. A **recursive-descent parser** builds an AST (`BoolOp`, `Not`, `Term`), enforcing the limits below.
3. A **compiler** turns each `Term` into a parameterised SQL predicate. User input never becomes SQL text.
   Contains uses `LIKE` over a lower-cased search blob, backed by a trigram (GIN) index. Arrays (tags, IPs, aliases) use `EXISTS (… unnest …)`.
   CIDR uses PostgreSQL's `inet <<=`, and regex uses `~*`.
4. Scope and filters are ANDed in. Facets and type counts come from the same compiled predicate.
5. Results are cached in Redis for 30 seconds, keyed by query, filters and the inventory data version, so a sync invalidates the cache immediately.

## Scope, filters and the URL

- The scope buttons and type tiles restrict the result type, the same as adding `type:`.
- The Filters panel (Type, Status, Environment, Tags) is ANDed with the query. All checked tags must be present.
- The browser URL holds `q`, `scope`, `types`, `status`, `env`, `tags`, `sort`, `dir`, `page`, `size` and `sel`, so you can share or bookmark the exact view.

## Cookbook

```text
# IPs
ip:"10.10.50.21"                      exactly this IP
10.10.50.0/24 -type:device            subnet, excluding network gear
regex:ip:^10\.10\.50\.2[0-9]$         .20–.29

# names & aliases
name:"eoc-app-xyz-01"                 exact name
name:bos-* -name:*fw*                 Boston, no firewalls
i-0a1b2c3d4e5f6g7h8                   AWS instance ID
alias:*.ec2.internal                  anything with an EC2 DNS alias

# tags
app:xyz costcenter:abc                both tags
(app:xyz OR app:abc) env:prod         either app, prod only
type:host missing:costcenter          tag hygiene

# monitors & status
type:monitor status:alert
(status:alert OR status:warn) -env:lab
type:monitor app:xyz -status:ok

# kubernetes & containers
type:pod kube_cluster_name:lab-1
type:pod -status:ok
type:container status:alert           exited / crashed
type:container image_name:nginx

# network
type:interface device_name:bos-core-sw01
type:interface status:down
mac:00:1a:2b:*

# AWS services
aws_service:lambda
cloud:aws region:us-east-1
aws_service:alb OR aws_service:nlb OR aws_service:elb
```

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| Too many IP matches | `ip:10.10.50.2` is a contains search | `ip:"10.10.50.2"` or CIDR |
| Name with spaces finds nothing | unquoted spaces split into ANDed terms | `name:"XYZ - Process Status"` |
| `name:eoc*` misses “prod-eoc-1” | wildcards are anchored | `name:*eoc*` or `name:eoc` |
| OR returns extras | AND binds tighter | add parentheses |
| A “Tag” row appears | tags are entities too | add `-type:tag` |
| `env:prod` also finds “preprod” | contains matching | `env:"prod"` or `tag:env:prod` |
| `type:switch` isn't a type | falls back to the tag `type:switch` | intended. Use `type:device` for all devices |
| “Unexpected ')'” | unbalanced parentheses | count them, or use the tester |
| New node not found | not synced yet | wait for the next sync, or run **Sync now** |
| Removed node not found | it's gone from Datadog | the results page shows “previously seen”. Check **What Changed** |

## Limits

| Limit | Value |
|---|---|
| Query length | 500 characters |
| Terms per query | 30 |
| Parenthesis depth | 12 |
| Regex length | 200 characters |
| Statement timeout | 5 s (search), 15 s (export) |
| Page size | up to 100 in the UI (API: 200) |
| Export | 50,000 rows |
