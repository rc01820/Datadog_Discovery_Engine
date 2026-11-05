import { Check, Copy, Play, Search as SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type SearchResponse } from "../api";
import { copy, cx } from "../util";
import { RECIPES } from "./helpRecipes";

const TOC: [string, string][] = [
  ["quick-start", "Quick start"],
  ["tester", "Query tester"],
  ["cheat-sheet", "Cheat sheet"],
  ["fields", "Fields reference"],
  ["matching", "How values are matched"],
  ["boolean", "AND, OR, NOT & parentheses"],
  ["tags", "Searching tags"],
  ["ips", "Searching IP addresses"],
  ["aliases", "Names & AWS aliases"],
  ["bulk", "Bulk lookup (lists)"],
  ["topology", "Topology view"],
  ["types-status", "Type & status values"],
  ["presence", "has: and missing:"],
  ["history", "Change history"],
  ["regex", "Regular expressions"],
  ["scope", "Scope, filters & sharing"],
  ["recipes", "Examples: I want to…"],
  ["pitfalls", "Common mistakes"],
  ["limits", "Limits"],
  ["shortcuts", "Keyboard shortcuts"],
];

function Q({ children, run = true }: { children: string; run?: boolean }) {
  const nav = useNavigate();
  const [copied, setCopied] = useState(false);
  return (
    <span className="q">
      <code>{children}</code>
      <button className="q-btn" title="Copy" aria-label={`Copy ${children}`} onClick={() => { copy(children); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {run && (
        <button className="q-btn" title="Run this search" aria-label={`Run ${children}`} onClick={() => nav(`/search?q=${encodeURIComponent(children)}`)}>
          <Play size={13} />
        </button>
      )}
    </span>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="panel help-section">
      <h2><a href={`#${id}`} className="anchor">#</a> {title}</h2>
      {children}
    </section>
  );
}

function Tester() {
  const nav = useNavigate();
  const [q, setQ] = useState("app:xyz costcenter:eoc -type:tag");
  const [res, setRes] = useState<{ ok: boolean; text: string; total?: number; sample?: string[] } | null>(null);
  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const t = setTimeout(() => {
      api<SearchResponse>("/search", { params: { q, page_size: 5 } })
        .then((r) => setRes({ ok: true, text: r.query.normalized, total: r.total, sample: r.results.map((x) => `${x.name} (${x.type})`) }))
        .catch((e) => setRes({ ok: false, text: e.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="tester">
      <div className="row gap">
        <input className="input mono grow" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Query to test" spellCheck={false} />
        <button className="btn-primary" onClick={() => nav(`/search?q=${encodeURIComponent(q)}`)}><SearchIcon size={16} /> Search</button>
      </div>
      {res && (
        <div className={cx("tester-out", res.ok ? "ok" : "bad")}>
          {res.ok ? (
            <>
              <div><span className="muted">Parsed as:</span> <code className="wrap">{res.text}</code></div>
              <div><span className="muted">Matches:</span> <strong>{res.total}</strong>{res.sample && res.sample.length > 0 && <span className="muted small"> — e.g. {res.sample.join(", ")}</span>}</div>
            </>
          ) : (
            <div><strong>Error:</strong> {res.text}</div>
          )}
        </div>
      )}
      <p className="muted small">“Parsed as” shows how the query is grouped: every AND/OR group is wrapped in parentheses so you can see precedence.</p>
    </div>
  );
}

export default function Help() {
  const [filter, setFilter] = useState("");
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return RECIPES;
    return RECIPES.map((g) => ({ ...g, recipes: g.recipes.filter((r) => `${r.want} ${r.q} ${r.note ?? ""} ${g.title}`.toLowerCase().includes(f)) }))
      .filter((g) => g.recipes.length);
  }, [filter]);
  const total = RECIPES.reduce((n, g) => n + g.recipes.length, 0);

  return (
    <div className="help-page">
      <nav className="help-toc panel" aria-label="Help contents">
        <h2>Search Help</h2>
        {TOC.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
      </nav>

      <div className="help-body">
        <Section id="quick-start" title="Quick start">
          <p>Type anything into the search bar and press <kbd>Enter</kbd>. Three rules cover most searches:</p>
          <ol className="big-list">
            <li><strong>Plain words search everything</strong> — names, IPs, AWS aliases, tags, OS, vendor, IDs. Matching is case-insensitive and finds the text anywhere: <Q>xyz</Q></li>
            <li><strong>Use <code>field:value</code> to be precise</strong> — e.g. <Q>name:eoc-*</Q> <Q>ip:10.10.50.*</Q> <Q>tag:app:xyz</Q></li>
            <li><strong>Several terms are ANDed together</strong> — <Q>app:xyz env:prod</Q> means both. Use <code>OR</code> for either: <Q>app:xyz OR app:abc</Q></li>
          </ol>
          <p>Put a value in <code>"double quotes"</code> for an exact match, use <code>*</code> and <code>?</code> as wildcards, and put <code>-</code> in front of a term to exclude it.</p>
          <p className="muted small">This query language belongs to Datadog Discovery Engine and runs against the inventory indexed from Datadog. It is not native Datadog query syntax.</p>
        </Section>

        <Section id="tester" title="Query tester">
          <p>Try a query here and see how it is interpreted and how many resources match, without leaving this page.</p>
          <Tester />
        </Section>

        <Section id="cheat-sheet" title="Cheat sheet">
          <table className="help-table">
            <thead><tr><th>Syntax</th><th>Meaning</th><th>Example</th></tr></thead>
            <tbody>
              <tr><td><code>word</code></td><td>Any field contains <em>word</em></td><td><Q>xyz</Q></td></tr>
              <tr><td><code>field:value</code></td><td>Search one field (see Fields reference)</td><td><Q>vendor:cisco</Q></td></tr>
              <tr><td><code>key:value</code></td><td>Unknown keys are treated as a tag</td><td><Q>costcenter:eoc</Q></td></tr>
              <tr><td><code>"…"</code></td><td>Exact match (also needed for spaces)</td><td><Q>{'name:"eoc-web-01"'}</Q></td></tr>
              <tr><td><code>*</code> <code>?</code></td><td>Wildcards: any characters / exactly one character</td><td><Q>name:eoc-web-??</Q></td></tr>
              <tr><td><code>a.b.c.d/nn</code></td><td>IP range (CIDR)</td><td><Q>10.10.50.0/24</Q></td></tr>
              <tr><td><code>regex:field:…</code> or <code>field:/…/</code></td><td>Regular expression</td><td><Q>name:/^bos-(core|edge)/</Q></td></tr>
              <tr><td><code>A B</code> · <code>A AND B</code></td><td>Both must match</td><td><Q>type:host env:prod</Q></td></tr>
              <tr><td><code>A OR B</code></td><td>Either may match</td><td><Q>status:alert OR status:warn</Q></td></tr>
              <tr><td><code>-A</code> · <code>NOT A</code></td><td>Exclude</td><td><Q>app:xyz -env:dev</Q></td></tr>
              <tr><td><code>( … )</code></td><td>Group</td><td><Q>(app:xyz OR app:abc) env:prod</Q></td></tr>
              <tr><td><code>has:x</code> · <code>missing:x</code></td><td>Field or tag key present / absent</td><td><Q>type:host missing:costcenter</Q></td></tr>
            </tbody>
          </table>
        </Section>

        <Section id="fields" title="Fields reference">
          <p>Field names are case-insensitive. Unless noted, an unquoted value matches if the field <em>contains</em> it.</p>
          <table className="help-table">
            <thead><tr><th>Field</th><th>Searches</th><th>Default behavior</th><th>Examples</th></tr></thead>
            <tbody>
              <tr><td><code>name:</code></td><td>Resource name / hostname / monitor title</td><td>contains</td><td><Q>name:xyz</Q> <Q>name:eoc-*</Q></td></tr>
              <tr><td><code>ip:</code></td><td>Every IP address of the resource (IPv4 & IPv6)</td><td>contains; CIDR supported</td><td><Q>ip:10.10.50.*</Q> <Q>ip:10.10.0.0/16</Q></td></tr>
              <tr><td><code>alias:</code> <span className="muted">(<code>aws:</code>, <code>aliases:</code>)</span></td><td>Host aliases: AWS instance ID, EC2/RDS DNS names, AWS Name tag, alternate hostnames</td><td>contains</td><td><Q>alias:i-0a1b*</Q> <Q>alias:*.ec2.internal</Q></td></tr>
              <tr><td><code>mac:</code></td><td>MAC address of a network interface (searched among aliases)</td><td>contains</td><td><Q>mac:00:1a:2b:*</Q></td></tr>
              <tr><td><code>tag:</code></td><td>Tags</td><td><code>key:value</code> = exact tag; <code>key</code> alone = any tag with that key</td><td><Q>tag:app:xyz</Q> <Q>tag:app</Q></td></tr>
              <tr><td><code>type:</code></td><td>Resource type</td><td>type name (see below); anything else = tag <code>type:value</code></td><td><Q>type:device</Q> <Q>type:switch</Q></td></tr>
              <tr><td><code>status:</code></td><td>Status / status group</td><td>status group or exact status</td><td><Q>status:alert</Q> <Q>status:down</Q></td></tr>
              <tr><td><code>env:</code></td><td>Environment (from the <code>env:</code> tag)</td><td>contains</td><td><Q>env:prod</Q></td></tr>
              <tr><td><code>os:</code></td><td>Operating system</td><td>contains</td><td><Q>os:windows</Q></td></tr>
              <tr><td><code>vendor:</code> · <code>model:</code></td><td>Network device vendor / model</td><td>contains</td><td><Q>vendor:cisco</Q> <Q>model:nexus*</Q></td></tr>
              <tr><td><code>agent:</code></td><td>Datadog Agent version</td><td>contains</td><td><Q>agent:7.75</Q> <Q>agent:6.*</Q></td></tr>
              <tr><td><code>id:</code></td><td>Datadog ID (host ID, monitor ID, synthetic public ID, dashboard ID, device ID)</td><td>contains</td><td><Q>id:1000100</Q></td></tr>
              <tr><td><code>source:</code></td><td>Where the record came from: <code>Datadog</code> or <code>DEMO</code></td><td>contains</td><td><Q>source:datadog</Q></td></tr>
              <tr><td><code>has:</code> · <code>missing:</code></td><td>Presence of <code>ip alias os env vendor model agent tags</code> or any tag key</td><td>presence</td><td><Q>has:alias</Q> <Q>missing:env</Q></td></tr>
              <tr><td><code>regex:</code> / <code>re:</code></td><td>Prefix that turns the following term into a regular expression</td><td>regex</td><td><Q>regex:name:^eoc-</Q></td></tr>
              <tr><td><em>any other</em> <code>key:</code></td><td>Treated as a tag (<code>costcenter:eoc</code> = <code>tag:costcenter:eoc</code>)</td><td>exact tag</td><td><Q>team:noc</Q> <Q>region:us-east-1</Q></td></tr>
            </tbody>
          </table>
          <p className="muted small">Free text (no field) searches name, IPs, aliases, tags, type, status, environment, OS, vendor, model and ID together.</p>
        </Section>

        <Section id="matching" title="How values are matched">
          <table className="help-table">
            <thead><tr><th>You type</th><th>Match type</th><th>Behavior</th><th>Example → matches</th></tr></thead>
            <tbody>
              <tr><td>plain value</td><td>contains</td><td>The text appears anywhere in the field, case-insensitive.</td><td><Q>name:web</Q> → eoc-<b>web</b>-01, eoc-<b>web</b>-02</td></tr>
              <tr><td><code>"quoted"</code></td><td>exact</td><td>The whole field equals the value (case-insensitive). Required when the value has spaces.</td><td><Q>{'name:"eoc-web-01"'}</Q> → only eoc-web-01</td></tr>
              <tr><td>has <code>*</code> or <code>?</code></td><td>wildcard</td><td>Anchored: the <em>whole</em> value must fit the pattern. <code>*</code> = any run of characters, <code>?</code> = exactly one.</td><td><Q>name:eoc-*</Q> starts with “eoc-”; <Q>name:*-01</Q> ends with “-01”; <Q>name:*xyz*</Q> contains “xyz”</td></tr>
              <tr><td><code>a.b.c.d/nn</code></td><td>CIDR</td><td>IP is inside the network range.</td><td><Q>10.10.50.0/24</Q> → 10.10.50.0–10.10.50.255</td></tr>
              <tr><td><code>regex:</code> or <code>/…/</code></td><td>regex</td><td>Case-insensitive regular expression; <em>not</em> anchored unless you use <code>^</code> and <code>$</code>.</td><td><Q>name:/^eoc-(app|db)-xyz-\d+$/</Q></td></tr>
            </tbody>
          </table>
          <div className="callout">
            <strong>Contains vs. wildcard:</strong> <code>name:eoc</code> finds “eoc” anywhere, including “geoc-1”. <code>name:eoc*</code> only finds names that <em>start</em> with “eoc”.
            Wildcards anchor the match; plain values do not.
          </div>
        </Section>

        <Section id="boolean" title="AND, OR, NOT & parentheses">
          <ul className="big-list">
            <li><strong>AND</strong>: write <code>AND</code>, <code>&&</code>, or just leave a space. <Q>app:xyz env:prod</Q> = <Q>app:xyz AND env:prod</Q></li>
            <li><strong>OR</strong>: write <code>OR</code> or <code>||</code>. <Q>vendor:cisco OR vendor:arista</Q></li>
            <li><strong>NOT</strong>: write <code>NOT</code> or put <code>-</code> directly in front of a term or group. <Q>NOT env:dev</Q> = <Q>-env:dev</Q> · <Q>app:xyz -(env:dev OR env:lab)</Q></li>
            <li>Keywords are case-insensitive (<code>and</code>, <code>or</code>, <code>not</code> also work). To search for the literal word “or”, quote it: <code>"or"</code>.</li>
            <li>A hyphen <em>inside</em> a word is not NOT: <Q>eoc-app-xyz-01</Q> is one term.</li>
          </ul>
          <h3>Precedence: NOT, then AND, then OR</h3>
          <p>AND binds tighter than OR, exactly like multiplication binds tighter than addition:</p>
          <table className="help-table">
            <thead><tr><th>You type</th><th>Is read as</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td><code>app:xyz OR app:abc env:prod</code></td><td><code>app:xyz OR (app:abc AND env:prod)</code></td><td>All of xyz, plus only the prod part of abc</td></tr>
              <tr><td><code>(app:xyz OR app:abc) env:prod</code></td><td><code>(app:xyz OR app:abc) AND env:prod</code></td><td>Prod resources of either app ✔ usually what you want</td></tr>
              <tr><td><code>-env:dev OR status:alert</code></td><td><code>(NOT env:dev) OR status:alert</code></td><td>Everything not in dev, plus anything alerting</td></tr>
            </tbody>
          </table>
          <p>When in doubt, add parentheses. The <a href="#tester">query tester</a> shows exactly how a query is grouped.</p>
        </Section>

        <Section id="tags" title="Searching tags">
          <p>Datadog tags look like <code>key:value</code> (e.g. <code>app:xyz</code>, <code>env:prod</code>, <code>costcenter:eoc</code>). There are three equivalent ways to search a tag:</p>
          <ul className="big-list">
            <li><Q>tag:app:xyz</Q>: explicit tag search (exact, case-insensitive).</li>
            <li><Q>app:xyz</Q>: shorthand. Any <code>key:value</code> whose key is not a built-in field is treated as a tag.</li>
            <li><Q>xyz</Q>: free text, which also finds tags containing “xyz” but is less precise.</li>
          </ul>
          <h3>Two tags at once</h3>
          <p>To find resources tagged <b>app:xyz</b> <em>and</em> <b>costcenter:abc</b>:</p>
          <p><Q>tag:app:xyz AND tag:costcenter:abc</Q> or the shorthand <Q>app:xyz costcenter:abc</Q></p>
          <p>To find resources with <em>either</em> tag: <Q>app:xyz OR costcenter:abc</Q></p>
          <h3>More tag patterns</h3>
          <ul className="big-list">
            <li>Any value of a key: <Q>tag:app</Q> (has any <code>app:</code> tag), same as <Q>has:app</Q></li>
            <li>Wildcard value: <Q>tag:app:x*</Q> · <Q>tag:*:boston</Q></li>
            <li>Missing a key: <Q>missing:costcenter</Q></li>
            <li>Tag keys that collide with fields: <code>env</code>, <code>os</code>, <code>type</code>, <code>status</code>, <code>name</code> and <code>vendor</code> are fields. For the literal tag, use <code>tag:</code>, e.g. <Q>tag:type:switch</Q> or <Q>{'tag:name:xeomon'}</Q>.</li>
          </ul>
          <div className="callout">Tag searches also return the <b>Tag</b> entity itself (a row named “app:xyz” of type Tag, showing how many resources carry it). Add <code>-type:tag</code> to hide it, or use the Type filter.</div>
          <p>Tip: click any tag chip in the results or inspector to add it to the current search.</p>
        </Section>

        <Section id="ips" title="Searching IP addresses">
          <table className="help-table">
            <thead><tr><th>Goal</th><th>Search</th><th>Notes</th></tr></thead>
            <tbody>
              <tr><td>Exactly one address</td><td><Q>{'ip:"10.10.50.21"'}</Q></td><td>Quotes = exact.</td></tr>
              <tr><td>Address anywhere (quick)</td><td><Q>10.10.50.21</Q></td><td>Contains: also matches 10.10.50.210–219.</td></tr>
              <tr><td>A /24 by wildcard</td><td><Q>ip:10.10.50.*</Q></td><td>Anchored: starts with 10.10.50.</td></tr>
              <tr><td>Any subnet by CIDR</td><td><Q>10.10.48.0/22</Q></td><td>Most precise for ranges; IPv6 works too.</td></tr>
              <tr><td>Last octet</td><td><Q>ip:*.1</Q></td><td>Ends with “.1”.</td></tr>
              <tr><td>Exclude a range</td><td><Q>type:host -ip:10.30.0.0/16</Q></td><td></td></tr>
              <tr><td>No IP known</td><td><Q>missing:ip</Q></td><td></td></tr>
            </tbody>
          </table>
          <div className="callout"><strong>Watch out:</strong> <code>ip:10.10.50.2</code> (no quotes, no wildcard) is a <em>contains</em> search and matches .2, .20–.29 and .200–.255. Use quotes or CIDR when you need one host.</div>
          <p className="muted small">Identical IPs on two resources do not prove they are the same machine (NAT, re-use, stale records). See Reports › Duplicate IP addresses.</p>
        </Section>

        <Section id="aliases" title="Names & AWS aliases">
          <p>Many nodes are known by more than one name. Datadog Discovery Engine indexes every <b>alias</b> Datadog reports for a host, plus identifiers from AWS integration tags:</p>
          <ul className="big-list">
            <li>EC2 instance ID: <Q>i-0a1b2c3d4e5f6g7h8</Q></li>
            <li>EC2 private / public DNS: <Q>alias:ip-10-10-50-21.ec2.internal</Q> <Q>alias:ec2-*.compute-1.amazonaws.com</Q></li>
            <li>AWS <code>Name</code> tag: <Q>alias:EOC-XYZ-App-Primary</Q></li>
            <li>RDS endpoints / identifiers: <Q>alias:*.rds.amazonaws.com</Q></li>
            <li>Alternate hostnames / FQDNs: <Q>alias:*.corp.example.com</Q></li>
          </ul>
          <p>Plain text already searches aliases, so pasting an instance ID or DNS name into the search bar just works. When a result matched on an alias, the row shows <span className="alias-hit">alias: …</span> under the name, and the inspector lists every alias (click one to copy it). <code>aws:</code> is a synonym for <code>alias:</code>.</p>
        </Section>

        <Section id="bulk" title="Bulk lookup (lists)">
          <p>Have a <b>list</b> rather than one query, such as IPs from a firewall log, hostnames from a ticket or instance IDs from an AWS report?
            Open <a href="/bulk">Bulk Lookup</a> in the sidebar and paste up to 2,000 items (one per line, or separated by commas, spaces or semicolons), or load a .txt/.csv file.</p>
          <ul className="big-list">
            <li>Each item is detected as an IP, CIDR range, AWS instance ID, MAC, container ID or name, and <b>matched exactly</b> (case-insensitive) against names,
              aliases, Datadog IDs and IPs. With <i>Match short names</i> on, <code>web01</code> also matches <code>web01.corp.example.com</code>.</li>
            <li>Results: <span className="res res-found">Found</span> <span className="res res-multiple">Multiple matches</span>{" "}
              <span className="res res-not_found">Not found</span> <span className="res res-removed">Previously seen</span> (removed, according to the change history).</li>
            <li>Each match shows which field matched (name, alias, id, ip, short name). You can filter by outcome, <b>Copy not found</b>, <b>Open matches in Search</b> or <b>Export CSV</b>.</li>
          </ul>
        </Section>

        <Section id="topology" title="Topology view">
          <p>See how a resource connects to everything else. In the inspector choose <b>Topology</b> (or <i>View in Topology</i>), or open
            <code>/topology/&lt;id&gt;</code> for the full page. Colours: coral = monitors, teal = same app, amber dashed = shares IP, blue = things running on it,
            violet = things it runs on or belongs to. Groups over 12 collapse to “+N more”. Switch between <b>1 hop</b> (ring) and <b>2 hops</b> (neighbours of neighbours),
            click a node to inspect it, double-click to recenter, and export PNG or SVG.</p>
        </Section>

        <Section id="types-status" title="Type & status values">
          <div className="two-col">
            <div>
              <h3>type:</h3>
              <table className="help-table">
                <tbody>
                  <tr><td><Q>type:host</Q></td><td className="muted">also <code>hosts</code>, <code>server</code></td></tr>
                  <tr><td><Q>type:device</Q></td><td className="muted">also <code>devices</code>, <code>network</code>, <code>ndm</code></td></tr>
                  <tr><td><Q>type:monitor</Q></td><td className="muted"></td></tr>
                  <tr><td><Q>type:tag</Q></td><td className="muted">the tag entities themselves</td></tr>
                  <tr><td><Q>type:service</Q></td><td className="muted">also <code>apm</code></td></tr>
                  <tr><td><Q>type:synthetic</Q></td><td className="muted"></td></tr>
                  <tr><td><Q>type:dashboard</Q></td><td className="muted"></td></tr>
                  <tr><td><Q>type:vmware</Q></td><td className="muted">also <code>vm</code>, <code>vsphere</code> (inferred from host metadata)</td></tr>
                  <tr><td><Q>type:cloud</Q></td><td className="muted">also <code>aws</code> (inferred: cloud resources without an agent)</td></tr>
                  <tr><td><Q>type:interface</Q></td><td className="muted">network device interfaces (also <code>port</code>, <code>nic</code>)</td></tr>
                  <tr><td><Q>type:cluster</Q></td><td className="muted">Kubernetes clusters (also <code>k8s</code>, <code>kubernetes</code>)</td></tr>
                  <tr><td><Q>type:pod</Q></td><td className="muted">Kubernetes pods</td></tr>
                  <tr><td><Q>type:container</Q></td><td className="muted">containers (also <code>docker</code>)</td></tr>
                  <tr><td><Q>type:database</Q></td><td className="muted">PostgreSQL, MySQL, SQL Server, MongoDB, Redis and Elasticsearch (also <code>db</code>). Filter with <code>db_engine:postgresql</code></td></tr>
                  <tr><td><Q>type:switch</Q></td><td className="muted">not a type → tag <code>type:switch</code></td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h3>status:</h3>
              <table className="help-table">
                <tbody>
                  <tr><td><Q>status:ok</Q></td><td className="muted">Up, OK, live tests (also <code>up</code>)</td></tr>
                  <tr><td><Q>status:alert</Q></td><td className="muted">Alert, Down, Critical (also <code>down</code>, <code>critical</code>)</td></tr>
                  <tr><td><Q>status:warn</Q></td><td className="muted">Warn / Warning / Degraded</td></tr>
                  <tr><td><Q>status:muted</Q></td><td className="muted">Muted monitors & hosts, paused tests</td></tr>
                  <tr><td><Q>status:unknown</Q></td><td className="muted">No Data / Unknown (also <code>nodata</code>)</td></tr>
                  <tr><td><Q>{'status:"No Data"'}</Q></td><td className="muted">any exact raw status text</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </Section>

        <Section id="presence" title="has: and missing:">
          <p>Find resources by whether something is <em>present</em>, which is ideal for tag hygiene and inventory gaps.</p>
          <ul className="big-list">
            <li>Built-in fields: <code>ip</code>, <code>alias</code>, <code>os</code>, <code>env</code>, <code>vendor</code>, <code>model</code>, <code>agent</code>, <code>tags</code>. Example: <Q>type:host missing:agent</Q></li>
            <li>Any tag key: <Q>has:costcenter</Q> <Q>type:host missing:team</Q></li>
            <li>Combine them: <Q>type:host (missing:env OR missing:app OR missing:costcenter)</Q></li>
          </ul>
        </Section>

        <Section id="history" title="Change history">
          <p>Every sync is compared with the previous one. These changes are recorded: <span className="chg chg-added">added</span> <span className="chg chg-removed">removed</span>{" "}
            <span className="chg chg-status">status</span> <span className="chg chg-tags">tags</span> <span className="chg chg-ips">ips</span>{" "}
            <span className="chg chg-aliases">aliases</span> <span className="chg chg-renamed">renamed</span>.</p>
          <ul className="big-list">
            <li><b>What Changed</b> (sidebar) lists every change for today, 24 hours, 7, 30 or 90 days. You can filter by change kind, resource type and text, and export to CSV.</li>
            <li><b>When did this disappear?</b> Search for the name or IP. If it is no longer in the inventory, the results page shows when it was removed and its last known IPs. You can also type it into the What Changed filter.</li>
            <li><b>A single resource's timeline</b>: open it in the inspector and choose the <b>History</b> tab.</li>
            <li>The first sync of each data source is a baseline, so “added” is reported from the second sync onward. History follows the audit retention setting.</li>
          </ul>
        </Section>

        <Section id="regex" title="Regular expressions">
          <ul className="big-list">
            <li>Prefix form: <Q>regex:name:^bos-.*</Q>. Without a field it tests name, IPs, aliases, tags, type, status, OS, vendor and ID: <Q>regex:^(bos|nyc)-</Q></li>
            <li>Slash form: <Q>name:/^eoc-(app|db)-xyz-\d+$/</Q>. Use quotes for patterns with spaces: <Q>{'regex:name:"^XYZ - "'}</Q></li>
            <li>Always case-insensitive. Not anchored: use <code>^</code> (start) and <code>$</code> (end).</li>
            <li>Escape dots in IPs and DNS names: <code>10\.10\.50\.</code>, <code>\.ec2\.internal$</code></li>
            <li>Useful pieces: <code>\d</code> digit, <code>[A-Z]{"{3}"}</code> three letters, <code>(a|b)</code> either, <code>.*</code> anything, <code>?</code> optional.</li>
            <li>Invalid patterns are reported with an error message. Each search has a time limit, so very expensive patterns stop rather than slow the system.</li>
          </ul>
          <div className="callout">Prefer wildcards (<code>name:eoc-*</code>) or CIDR (<code>10.10.50.0/24</code>) when they are enough. They are simpler and faster than regex.</div>
        </Section>

        <Section id="scope" title="Scope, filters & sharing">
          <ul className="big-list">
            <li><b>Search Scope</b> buttons (All, Hosts, Devices…) and the <b>type tiles</b> restrict the result type. This is the same as adding <code>type:…</code>.</li>
            <li>The <b>Filters</b> panel (Type, Status, Environment, Tags) narrows results further. Filters are always ANDed with the query; tags checked in the Tags facet must <em>all</em> be present.</li>
            <li>Counts next to filters show how many matching resources fall into each bucket.</li>
            <li>Sort by clicking a column header. Change page size at the bottom right.</li>
            <li>The browser address bar holds the query, scope, filters, sort, page and selected resource. Copy it to <b>share the exact view</b>, or bookmark it.</li>
            <li><b>Save Search</b> stores the query (optionally shared with your team); <b>Favorite</b> pins it to Home and Favorites. Recent searches appear in History.</li>
            <li>Export the full result set (CSV/JSON) from the results footer, or select rows and export only those.</li>
          </ul>
        </Section>

        <Section id="recipes" title={`Examples: I want to… (${total})`}>
          <div className="row gap recipe-filter">
            <input className="input grow" placeholder="Filter examples… e.g. tag, ip, aws, monitor" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter examples" />
          </div>
          <div className="recipe-jump">
            {RECIPES.map((g) => <a key={g.id} href={`#r-${g.id}`} className="chip">{g.title}</a>)}
          </div>
          {groups.map((g) => (
            <div key={g.id} id={`r-${g.id}`} className="recipe-group">
              <h3>{g.title}</h3>
              <table className="help-table recipes">
                <thead><tr><th>If you want to…</th><th>Search</th></tr></thead>
                <tbody>
                  {g.recipes.map((r) => (
                    <tr key={r.q + r.want}>
                      <td>{r.want}{r.note && <div className="muted small">{r.note}</div>}</td>
                      <td><Q>{r.q}</Q></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {!groups.length && <p className="muted">No examples match “{filter}”.</p>}
          <p className="muted small">Example values come from the demo inventory (app:xyz, costcenter:eoc, 10.10.50.0/24…). Substitute your own names, tags and addresses.</p>
        </Section>

        <Section id="pitfalls" title="Common mistakes">
          <table className="help-table">
            <thead><tr><th>Symptom</th><th>Cause</th><th>Fix</th></tr></thead>
            <tbody>
              <tr><td>Too many IP matches</td><td><code>ip:10.10.50.2</code> is a contains search</td><td><Q>{'ip:"10.10.50.2"'}</Q> or CIDR</td></tr>
              <tr><td>Nothing found for a name with spaces</td><td>Unquoted spaces split into separate ANDed terms</td><td><Q>{'name:"XYZ - Process Status"'}</Q></td></tr>
              <tr><td><code>name:eoc*</code> misses “prod-eoc-1”</td><td>Wildcards are anchored at the start</td><td><Q>name:*eoc*</Q> or <Q>name:eoc</Q></td></tr>
              <tr><td>OR returns unexpected extras</td><td>AND binds tighter than OR</td><td>Add parentheses: <Q>(app:xyz OR app:abc) env:prod</Q></td></tr>
              <tr><td>A “Tag” row appears in results</td><td>Tags are searchable entities too</td><td>Add <code>-type:tag</code></td></tr>
              <tr><td><code>env:prod</code> finds “preprod” too</td><td>Fields use contains matching</td><td><Q>{'env:"prod"'}</Q> or <Q>tag:env:prod</Q></td></tr>
              <tr><td><code>type:switch</code> returns devices, not a type</td><td>Unknown type values fall back to the tag <code>type:value</code></td><td>Intended. Use <Q>type:device</Q> for all devices</td></tr>
              <tr><td>Regex error</td><td>Unbalanced <code>(</code> or <code>[</code>, or an unescaped special character</td><td>Check the error position; escape <code>. ( ) [ ] + ?</code> with <code>\</code></td></tr>
              <tr><td>“Unexpected ')'”</td><td>Unbalanced parentheses</td><td>Count the <code>(</code> and <code>)</code>, or use the <a href="#tester">tester</a></td></tr>
              <tr><td>Recently created node not found</td><td>The inventory refreshes on the sync schedule</td><td>An admin can run <b>Sync now</b> in Admin › Datadog Config</td></tr>
            </tbody>
          </table>
        </Section>

        <Section id="limits" title="Limits">
          <ul className="big-list">
            <li>Query length: 500 characters. Up to 30 terms and 12 levels of parentheses.</li>
            <li>Regular expressions: 200 characters each. Every search has a 5-second time limit.</li>
            <li>Exports: up to 50,000 rows. Pages: up to 100 rows each.</li>
            <li>Results reflect the indexed inventory as of the last sync (see “Last Sync” in the header). Monitor status can be refreshed live from the inspector.</li>
          </ul>
        </Section>

        <Section id="shortcuts" title="Keyboard shortcuts">
          <table className="help-table">
            <tbody>
              {[
                ["/", "Focus the search bar"], ["Enter", "Run search / accept the highlighted suggestion"], ["Tab", "Accept autocomplete"],
                ["↑ ↓", "Move through suggestions"], ["j / k", "Next / previous result"], ["o", "Open the selected resource in Datadog"],
                ["f", "Favorite the selected resource"], ["s", "Save the current search"], ["e", "Export results as CSV"],
                ["[ / ]", "Previous / next page"], ["Esc", "Close suggestions, dialogs or the inspector"], ["?", "Shortcut cheat sheet"],
              ].map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}
