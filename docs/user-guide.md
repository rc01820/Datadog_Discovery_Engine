# User guide

This guide walks through every screen for NOC operators and anyone else who searches. Administrators should also read
[admin-guide.md](admin-guide.md).

- [Signing in](#signing-in)
- [The layout](#the-layout)
- [Home](#home)
- [Search](#search)
- [The resource inspector](#the-resource-inspector)
- [Topology](#topology)
- [Bulk Lookup](#bulk-lookup)
- [What Changed](#what-changed)
- [Reports](#reports)
- [Saved Searches](#saved-searches)
- [Favorites](#favorites)
- [History](#history)
- [Search Help](#search-help)
- [Exporting](#exporting)
- [Sharing a view](#sharing-a-view)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Themes](#themes)
- [Your account](#your-account)
- [What your role allows](#what-your-role-allows)

## Signing in

Open the URL your administrator gave you (for example `https://search.example.com`) and sign in with your username and password.
Sessions last 8 hours by default. After 5 failed attempts for one username, sign-in is blocked for 5 minutes.

## The layout

- **Header**: the app logo, the title, the animated mesh, the **connection status** (green = connected to Datadog,
  amber = demo mode, grey = not configured) with the org name and **Last Sync** time, the **theme toggle**, and the **user menu**.
- **Sidebar**: Home, Search, Bulk Lookup, Saved Searches, Favorites, History, What Changed, Reports, Search Help, and Admin (administrators only).
- **Footer** (sidebar bottom): Keyboard shortcuts (or press <kbd>?</kbd>) and the app version.

## Home

- **Search box** with autocomplete, plus quick chips (*All alerting*, *Warnings*, *Network devices*, …).
- **Inventory tiles**: one per resource type, with counts. Click one to open Search scoped to that type. Types with no
  inventory (e.g. Pods when there's no Kubernetes) are hidden.
- **Alerting now**: the resources currently in alert. Click one to open it.
- **What changed (24h)**: counts per change kind and the latest changes.
- **Recent searches**: your last searches, with result counts.
- **Favorites**: your starred resources and queries.
- **Inventory health**: counts from each report. Click one to open the report.

## Search

### Running a search

Type into the search bar and press <kbd>Enter</kbd>. As you type, **autocomplete** suggests field names (`name:`, `ip:`, `alias:` …),
resource names, tags, aliases, types and statuses. Use <kbd>↑</kbd>/<kbd>↓</kbd> to move and <kbd>Tab</kbd> or <kbd>Enter</kbd> to accept.
Press <kbd>/</kbd> anywhere to jump to the search bar.

For the full language, see [search-syntax.md](search-syntax.md) or the in-app **Search Help** page. A few examples:

```
ip:"10.10.50.21"             app:xyz costcenter:abc        type:monitor status:alert
10.10.50.0/24                i-0831170512d0e4fdb            type:pod -status:ok
```

### Narrowing results

- **Search Scope** buttons (All, Hosts, Devices, Monitors…) and the **type tiles** above the table restrict the resource type.
  The tile counts show how many matches there are of each type.
- The **Filters** panel narrows further by **Type**, **Status** (Up/OK, Alerting, Warning, Muted, Unknown), **Environment** and **Tags**
  (type in *Filter tags…* to find one). Counts reflect the current query. **Clear All** resets the filters.
- The header shows the parsed query and how long it took (and whether the result was cached).

### The results table

| Column | Notes |
|---|---|
| ☐ | Select rows for bulk export |
| Name | Type icon and name. An amber `alias: …` line shows when the row matched on an alias (e.g. an AWS instance ID). A `DEMO` badge marks demo data |
| Type | Resource type |
| IP Address | First IP, with `+N` if there are more |
| Status | Coloured pill: green OK/Up/Running, red Alert/Down/Exited, amber Warning, grey Muted/Unknown |
| Key Tags | First three tags. **Click a tag to add it to the search** |
| Last Seen | Time since Datadog last observed the resource. Amber means *stale* (older than the stale threshold) |

Click a column header to sort. Use the controls at the bottom to page and choose 10/25/50/100 rows per page.
Click a row to open the **inspector**, and click it again to close.

If nothing matches, the page suggests a wildcard and links to examples. If the term matches something that **used to exist**,
it shows *“Not in the current inventory, but previously seen”*, with when it was removed.

## The resource inspector

The right-hand panel for the selected resource:

- **Header**: icon, name, status, type (with an *inferred* badge when the type was deduced, e.g. VMware or Cloud), the first IP
  (click to copy; *+N more* when there are several), **Open in Datadog** ↗, **Favorite** ☆ and **Close**.
- **Freshness line**: *Synthetic demo data*, or *Cached from last sync; refresh for live status*, plus the source.
- **Tabs**:
  - **Overview**: tags (click one to add it to the search), key facts (OS, agent version, aliases (click to copy), IP addresses, environment,
    Datadog ID, organization, created, last seen, content changed), type-specific attributes (image, namespace, cluster, MAC, AWS service,
    region, account, discovered via…) and **Quick Actions**: *Open in Datadog*, *View Host Metrics*, *View Monitors (n)*,
    *View Logs*, *View Related (n)*, *View in Topology*, *Refresh live status* (monitors) and *Copy shareable link*.
  - **Tag policy** (when the [Tag Enforcer integration](tag-enforcer.md) is on): Tag Enforcer's verdict, the owning team, every finding
    with the policy's suggested fix and an *auto-fixable* badge, and **Monitors not watching this resource**: monitors that would
    cover it if a tag were spelled as the policy says. A red dot on the tab means the resource fails the policy. Click a finding to
    search for every resource with the same problem; *Open in Tag Enforcer* goes to the resource there. Overview also gets a
    *Tag policy* row.
  - **Monitors**: monitors scoped to this resource, or sharing its `app:`/`service:` tag, each with the evidence.
  - **Topology**: the resource drawn as a graph (see [Topology](#topology)), with 1/2-hop toggle, PNG export and *Open full page*.
  - **Related**: grouped by relationship (*Runs on host*, *Containers & pods on this host*, *Member of*, *Interfaces*,
    *Same application*, *Shares an IP*…), with evidence. Click an entry to inspect it.
  - **Metrics** (hosts, devices): CPU, memory and load sparklines for the last hour, plus a link to Datadog.
  - **Logs** (hosts, devices, services): the latest 50 log lines from the last 60 minutes, plus a link to the Log Explorer.
  - **History**: this resource's change timeline (see [change-history.md](change-history.md)).
  - **Raw**: the full JSON record.

## Topology

The Topology view draws a resource and everything related to it, using the same relationships (with the same evidence) as the Related tab:
its **monitors**, resources in the **same app** (`app:`/`service:` tag), anything that **shares an IP** (dashed line), the host it **runs on**,
**containers, pods and databases** running on it, the **cluster** it belongs to, **interfaces** of a device, and the monitor behind a synthetic.

**Opening it**

- In the inspector, choose the **Topology** tab, or the **View in Topology** quick action. Use *Open full page* for larger graphs.
- Go directly to `/topology/<resource id>` (add `?hops=2` for two hops). Copy the link to share the exact view.

**Reading it**

| Element | Meaning |
|---|---|
| Centre node (accent border, larger) | the selected resource, with its type and first IP |
| Line colour | relationship group: coral = monitors/synthetics, teal = same app, amber dashed = shares IP, blue = things that run on or belong to it, violet = things it runs on or belongs to |
| Dot on each node | status: green OK/Up, red alert/down, amber warning, grey muted/unknown |
| “+N more” node | the group has more than 12 members. Click it to expand the group |
| Orange outline | (Tag Enforcer) the resource fails the tag policy. **Solid**: at least one monitor misses it because of a tag spelling; **dashed**: fails, but no monitor is affected. The full page shows a *Fails tag policy (n)* chip |
| Hover | a tooltip with name, type, status, IP and the evidence for the link |

**1 hop or 2 hops**

- **1 hop** uses a ring layout: each relationship group gets its own sector around the centre.
- **2 hops** also shows neighbours of neighbours (for example host → container → pod → cluster) in a force-directed layout. To keep it readable, it expands
  the structural relationships of up to 60 first-hop resources (up to 30 each) and caps the graph at 300 nodes. When it trims, the header says *large graph trimmed*.

**Interacting**

- **Click** a node to open it in the inspector (on the full page, the inspector opens beside the graph). **Double-click** to recenter the graph on it.
- **Scroll** to zoom (in the inspector tab, hold <kbd>Ctrl</kbd>/<kbd>⌘</kbd>), **drag** the background to pan, and use **Fit** to reset.
- Full page only: **layer chips** show or hide relationship groups, with counts.
- **PNG** and **SVG** export the current graph. The export uses the current theme's colours, and the graph follows the dark/light theme.

## Bulk Lookup

Use it when you have a **list**: IPs from a firewall log, hostnames from a change ticket, instance IDs from an AWS report, a spreadsheet
column of servers.

1. Open **Bulk Lookup** from the sidebar (or the link on Home).
2. **Paste** the items into the box, or **Load file** (`.txt`, `.csv`, `.log`, up to 1 MB). Items can be separated by new lines, commas,
   semicolons, spaces, tabs or `|`. Quotes, brackets and trailing dots are stripped, lines starting with `#` are ignored, and duplicates are
   removed (case-insensitively). The box shows how many unique items it detected. Up to **2,000** per lookup.
3. Choose options:
   - **Match short names**: when an exact match fails, `web01` matches `web01.corp.example.com` and vice versa (on by default).
   - **Include Tag entities**: also match Tag rows (off by default).
4. Click **Look up** (or press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>).

Each item is classified and matched:

| Kind (auto-detected) | Example | Matched against |
|---|---|---|
| IP | `10.10.50.21`, `fe80::1` | any IP of a resource (exact) |
| CIDR | `10.10.50.0/24` | every resource with an IP inside the range |
| Instance ID | `i-0831170512d0e4fdb` | name, aliases, Datadog ID |
| MAC | `00:1a:2b:3c:4d:5e` | aliases (interface MACs) |
| Container ID | `00c288a0744c` (12 or 64 hex) | aliases (container IDs) |
| Name | `eoc-app-xyz-01`, `xeomon`, `ip-10-1-2-3.ec2.internal` | name, aliases (EC2 DNS, AWS Name tag…), Datadog ID, then short name if enabled |

Every result is one of:

| Result | Meaning |
|---|---|
| **Found** | exactly one resource matched |
| **Multiple matches** | more than one matched (common for shared IPs such as `172.17.0.1` Docker bridges, or for CIDR ranges). Up to 20 are listed |
| **Not found** | nothing current or historical matched |
| **Previously seen** | not in the inventory now, but the change history shows a resource with that name, IP or alias was **removed**. Shows when, with a link to its history |

For each match you see the type, name (click to open it in Search with the inspector), status, **which field matched** (name, alias, id, ip,
short name) and its first IP.

**Working with the results**

- Click the **summary tiles** (All, Found, Multiple, Not found, Previously seen) to filter the table.
- **Copy not found** copies the misses (not found + previously seen), one per line, ready to paste back into a ticket.
- **Open matches in Search** runs a `name:"…" OR …` search for the matched resources (the first 30).
- **Export CSV** (needs the export permission) downloads one row per match, or one row for each miss, with the columns
  `input, kind, result, match_count, name, type, status, ips, matched_on, source, deep_link, previously_removed_at, previously_summary`.
- Your last input is kept for the browser session, so you can go to Search and come back.

Every lookup is recorded in your History and the audit log as `[bulk lookup: N items] …`.

## What Changed

Shows changes between syncs: added, removed, status, tags, IPs, aliases and renames.
Choose a **period** (Today, 24 h, 7/30/90 days), click **summary tiles** to filter by kind, pick a **type**, or type a **name or IP**.
Removed resources are struck through, and live ones link to the inspector. **CSV** exports the list. Details: [change-history.md](change-history.md).

## Reports

Seven hygiene reports, each with a count card. Click a row to open it in Search.

| Report | Shows |
|---|---|
| Alerting & warning resources | everything in Alert or Warn, worst first |
| Duplicate IP addresses | IPs on more than one resource (investigate NAT, re-use or stale records) |
| Missing required tags | infrastructure missing any of the required keys (Admin › Settings). With Tag Enforcer connected: every resource missing a key its policy requires for that type |
| Stale inventory | infrastructure not observed within the stale threshold |
| Infrastructure without monitor coverage | no monitor scoped to it by name, and no monitor sharing its `app:` tag |
| Agent versions | agent version distribution. Versions older than the most common major are flagged |
| Monitor blind spots | (Tag Enforcer) one row per resource and monitor: the tag the resource has, the tag the policy and monitor expect, and the monitor that misses it |

## Saved Searches

- **Save Search** on the Search page (or press <kbd>s</kbd>) stores the query and scope with a name and description.
  Operators and Administrators can tick **Share with all users**.
- The Saved Searches page lists **My searches** and **Shared searches**. Each has Run ▶, Favorite ☆, Edit ✎ and Delete 🗑 (owners, or
  sharers for shared searches), plus run counts and last run time.
- **Templates** are ready-made searches (alerting monitors, devices in a location, missing tags, IP collision…). You can run them or *Save as…*.

## Favorites

- Star a **resource** in the inspector (or press <kbd>f</kbd> with a row selected).
- Star a **query** with the **Favorite** button on the Search page.
- The Favorites page lists both. A resource that is no longer indexed shows as *no longer indexed*.

## History

Your own recent searches, deduplicated, with run count, last result count, average latency and last run. ▶ re-runs a search.
**Clear history** hides them from your view. The organization's audit log keeps them for administrators.

## Search Help

The in-app reference: quick start, a **query tester** (shows the parsed query, match count and sample results as you type),
cheat sheet, field reference, match types, boolean precedence, tags, IPs, aliases, types and statuses, presence, regex,
change history, scope and filters, more than 100 **“I want to… → search this”** examples (each with copy and run buttons, plus a filter box),
common mistakes, limits and shortcuts. The **Examples** button on the Search page opens it.

## Exporting

- **CSV** or **JSON** in the results footer exports **all** matching results (up to 50,000), not just the current page.
- Select rows with the checkboxes, then use **Export selected** in the bulk bar.
- CSV columns: name, type, status, ips, aliases, env, os, vendor, tags, source, external_id, last_observed, deep_link. Values that
  start with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas.
- Exports are recorded in the audit log. Viewers can export only if an administrator has enabled it.

## Sharing a view

The URL holds the query, scope, filters, sort, page and the selected resource. Copy it from the address bar, or use
**Copy shareable link** in the inspector. The recipient needs an account.

## Keyboard shortcuts

| Key | Action |
|---|---|
| <kbd>/</kbd> | Focus the search bar |
| <kbd>Enter</kbd> | Run search / accept the highlighted suggestion |
| <kbd>Tab</kbd> | Accept autocomplete |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move through suggestions |
| <kbd>j</kbd> / <kbd>k</kbd> | Next / previous result |
| <kbd>o</kbd> | Open the selected resource in Datadog |
| <kbd>f</kbd> | Favorite the selected resource |
| <kbd>s</kbd> | Save the current search |
| <kbd>e</kbd> | Export results as CSV |
| <kbd>[</kbd> / <kbd>]</kbd> | Previous / next page |
| <kbd>Esc</kbd> | Close suggestions, dialogs or the inspector |
| <kbd>?</kbd> | Show the shortcut list |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> | Run Bulk Lookup (in its text box) |

## Themes

Click the **sun/moon** button in the header to switch between dark and light, or choose **Dark / Light / Match system** in the user menu.
The choice is saved in your browser.

## Your account

User menu › **Account & password** shows your role and permissions and lets you change your password (12+ characters).
Changing your password signs out your other sessions.

## What your role allows

| Capability | Viewer | Operator | Administrator |
|---|---|---|---|
| Search, inspect, deep links, reports, What Changed, Bulk Lookup | ✓ | ✓ | ✓ |
| Personal saved searches, favorites, history | ✓ | ✓ | ✓ |
| Export CSV/JSON (incl. Bulk Lookup CSV) | if enabled | ✓ | ✓ |
| Create and edit shared saved searches | – | ✓ | ✓ |
| Users, roles, settings, Datadog config, audit, health | – | – | ✓ |
