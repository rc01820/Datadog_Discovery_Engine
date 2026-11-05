import {
  Activity, Copy, ExternalLink, FileText, GitBranch, LineChart, Link2, RefreshCw, Share2, Star, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import TopologyGraph, { type TopoData, type TopologyHandle } from "./TopologyGraph";
import { api, type Related, type ResourceDetail } from "../api";
import { useApp } from "../context";
import { copy, cx, fmtTime, relTime, StatusPill, TypeIcon } from "../util";
import Sparkline from "./Sparkline";

type Tab = "overview" | "monitors" | "related" | "topology" | "metrics" | "logs" | "history" | "raw";

interface Change { id: number; at: string; change: string; summary: string }

interface Props {
  id: number;
  onClose: () => void;
  onAddTerm: (term: string) => void;
  onSelect: (id: number) => void;
  onChanged?: () => void;
}

interface LogLine { timestamp: string; status: string; service: string; host: string; message: string }

const RELATION_LABEL: Record<string, string> = {
  monitor: "Monitors", application: "Same application", same_ip: "Shares an IP", scoped_to: "Scoped to", synthetic: "Synthetics",
  runs_on: "Runs on host", runs_in: "Runs in pod", member_of: "Member of", interface_of: "Interface of", backed_by: "Backed by monitor",
  workloads: "Containers & pods on this host", containers: "Containers", members: "Members", interfaces: "Interfaces", child: "Children",
};

export default function Inspector({ id, onClose, onAddTerm, onSelect, onChanged }: Props) {
  const { toast } = useApp();
  const [r, setR] = useState<ResourceDetail | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [history, setHistory] = useState<{ first_indexed: string; changes: Change[] } | null>(null);
  const [related, setRelated] = useState<Related[] | null>(null);
  const [metrics, setMetrics] = useState<{ mode: string; note?: string; series: { name: string; points: number[][] }[] } | null>(null);
  const [logs, setLogs] = useState<{ mode: string; note?: string; query?: string; logs: LogLine[] } | null>(null);
  const [showAllTags, setShowAllTags] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setErr("");
    api<ResourceDetail>(`/resources/${id}`).then(setR).catch((e) => setErr(e.message));
    api<{ related: Related[] }>(`/resources/${id}/related`).then((x) => setRelated(x.related)).catch(() => setRelated([]));
  };

  useEffect(() => {
    setR(null); setRelated(null); setMetrics(null); setLogs(null); setHistory(null); setShowAllTags(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (tab === "history" && !history) api<{ first_indexed: string; changes: Change[] }>(`/resources/${id}/history`).then(setHistory).catch(() => setHistory({ first_indexed: "", changes: [] }));
    if (tab === "metrics" && !metrics) api<typeof metrics>(`/resources/${id}/metrics`).then(setMetrics).catch((e) => setMetrics({ mode: "error", note: e.message, series: [] }));
    if (tab === "logs" && !logs) api<typeof logs>(`/resources/${id}/logs`).then(setLogs).catch((e) => setLogs({ mode: "error", note: e.message, logs: [] }));
  }, [tab, id, metrics, logs, history]);

  const toggleFav = async () => {
    if (!r) return;
    try {
      if (r.favorite) await api("/favorites", { method: "DELETE", params: { kind: "resource", ref: String(r.id) } });
      else await api("/favorites", { method: "PUT", body: { kind: "resource", ref: String(r.id), label: r.name } });
      setR({ ...r, favorite: !r.favorite });
      toast(r.favorite ? "Removed from favorites" : "Added to favorites");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const x = await api<{ refreshed: boolean; reason?: string; status: string }>(`/resources/${id}/refresh`, { method: "POST" });
      toast(x.refreshed ? `Live status: ${x.status}` : x.reason ?? "Not refreshed", x.refreshed ? "ok" : "info");
      if (x.refreshed) { load(); onChanged?.(); }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRefreshing(false);
    }
  };

  if (err) return <aside className="inspector panel"><div className="empty">{err}</div></aside>;
  if (!r) return <aside className="inspector panel"><div className="empty">Loading…</div></aside>;

  const monitors = (related ?? []).filter((x) => x.relation === "monitor");
  const others = (related ?? []).filter((x) => x.relation !== "monitor");
  const isInfra = ["Host", "VMware", "Cloud", "Device"].includes(r.type);
  const attrs = r.attributes ?? {};
  const tagsShown = showAllTags ? r.tags : r.tags.slice(0, 3);
  const kv: [string, React.ReactNode][] = [
    ...(r.ips.length > 1 ? [["IP Addresses", <div key="ips" className="alias-list mono small">{r.ips.map((ip) => <span key={ip}>{ip}</span>)}</div>] as [string, React.ReactNode]] : []),
    ["OS", r.os || "—"],
    ...(r.type === "Device" ? [["Vendor / Model", `${r.vendor || "—"} ${r.model || ""}`] as [string, string]] : []),
    ...(r.agent_version || r.type === "Host" ? [["Agent Version", r.agent_version || "—"] as [string, string]] : []),
    ...(r.aliases.length ? [["Aliases", (
      <div key="al" className="alias-list">
        {r.aliases.map((a) => (
          <button key={a} className="linklike mono small" title="Copy alias" onClick={() => { copy(a); toast(`Copied ${a}`); }}>{a}</button>
        ))}
      </div>
    )] as [string, React.ReactNode]] : []),
    ["Environment", r.env || "—"],
    [r.type === "Monitor" ? "Monitor ID" : "Datadog ID", String(attrs.datadog_host_id ?? r.external_id)],
    ["Organization", r.org_name],
    ["Created", fmtTime(r.created_at)],
    ["Last Seen", <span key="ls" className={cx(r.stale && "warn-text")}>{relTime(r.last_observed)}{r.stale && " · stale"}</span>],
    ["Content changed", relTime(r.last_indexed)],
  ];

  return (
    <aside className="inspector panel" aria-label="Resource inspector">
      <div className="insp-head">
        <div className="insp-icon"><TypeIcon type={r.type} size={34} /></div>
        <div className="insp-title">
          <div className="row gap">
            <h2 title={r.name}>{r.name}</h2>
            <StatusPill status={r.status} group={r.status_group} />
          </div>
          <div className="muted">{r.type}{r.freshness.inferred_type && <span className="badge" title="Type inferred from integration metadata">inferred</span>}</div>
          {r.ips.length > 0 && (
            <button className="linklike ip" onClick={() => { copy(r.ips[0]); toast(`Copied ${r.ips[0]}`); }} title="Copy IP">
              <Link2 size={13} /> {r.ips[0]}{r.ips.length > 1 && <span className="muted small" title={r.ips.join(", ")}> +{r.ips.length - 1} more</span>}
            </button>
          )}
        </div>
        <div className="insp-actions">
          {r.deep_link && <a className="icon-btn" href={r.deep_link} target="_blank" rel="noopener noreferrer" title="Open in Datadog"><ExternalLink size={18} /></a>}
          <button className={cx("icon-btn", r.favorite && "starred")} onClick={toggleFav} title={r.favorite ? "Unfavorite" : "Favorite"} aria-pressed={r.favorite}>
            <Star size={18} fill={r.favorite ? "currentColor" : "none"} />
          </button>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close inspector"><X size={18} /></button>
        </div>
      </div>
      <div className={cx("freshness", `fr-${r.freshness.mode}`)}>{r.freshness.label} · source {r.source}</div>

      <div className="tabs" role="tablist">
        {(["overview", "monitors", "related", "topology", ...(isInfra || r.type === "Service" ? ["metrics", "logs"] : []), "history", "raw"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={cx(tab === t && "active")} onClick={() => setTab(t)}>
            {t === "monitors" ? `Monitors${related ? ` (${monitors.length})` : ""}` : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="insp-body">
          <h3>Tags ({r.tags.length})</h3>
          <div className="chips">
            {tagsShown.map((t) => (
              <button key={t} className="chip" onClick={() => onAddTerm(`tag:${t}`)} title="Add to search">{t}</button>
            ))}
            {r.tags.length > 3 && (
              <button className="linklike small" onClick={() => setShowAllTags(!showAllTags)}>
                {showAllTags ? "show less" : `+${r.tags.length - 3} more`}
              </button>
            )}
          </div>
          <table className="kv-table">
            <tbody>
              {kv.map(([k, v]) => (
                <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>
              ))}
              {r.type === "Monitor" && r.monitor_query && (
                <tr><td className="muted">Query</td><td><code className="wrap">{r.monitor_query}</code></td></tr>
              )}
              {typeof attrs.url === "string" && <tr><td className="muted">URL</td><td className="wrap">{attrs.url}</td></tr>}
              {EXTRA_ATTRS.filter(([k]) => attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== "").map(([k, label]) => (
                <tr key={k}><td className="muted">{label}</td><td className="wrap">{Array.isArray(attrs[k]) ? (attrs[k] as unknown[]).join(", ") : String(attrs[k])}</td></tr>
              ))}
              {typeof attrs.description === "string" && attrs.description && <tr><td className="muted">Description</td><td>{attrs.description}</td></tr>}
            </tbody>
          </table>
          <h3>Quick Actions</h3>
          <div className="quick">
            {r.deep_link && <a href={r.deep_link} target="_blank" rel="noopener noreferrer"><ExternalLink size={18} /> Open in Datadog</a>}
            {isInfra && <button onClick={() => setTab("metrics")}><LineChart size={18} /> View {r.type === "Device" ? "Device" : "Host"} Metrics</button>}
            <button onClick={() => setTab("monitors")}><Activity size={18} /> View Monitors ({related ? monitors.length : "…"})</button>
            {(isInfra || r.type === "Service") && <button onClick={() => setTab("logs")}><FileText size={18} /> View Logs</button>}
            <button onClick={() => setTab("related")}><GitBranch size={18} /> View Related ({related ? others.length : "…"})</button>
            <button onClick={() => setTab("topology")}><Share2 size={18} /> View in Topology</button>
            {r.type === "Monitor" && <button onClick={refresh} disabled={refreshing}><RefreshCw size={18} className={cx(refreshing && "spin")} /> Refresh live status</button>}
            <button onClick={() => { copy(`${location.origin}/search?q=${encodeURIComponent(`name:"${r.name}"`)}&sel=${r.id}`); toast("Link copied"); }}>
              <Copy size={18} /> Copy shareable link
            </button>
          </div>
        </div>
      )}

      {(tab === "monitors" || tab === "related") && (
        <div className="insp-body">
          {!related && <div className="muted">Loading…</div>}
          {related && (tab === "monitors" ? monitors : others).length === 0 && <div className="muted">Nothing correlated.</div>}
          {related && Object.entries(groupBy(tab === "monitors" ? monitors : others)).map(([rel, items]) => (
            <div key={rel}>
              {tab === "related" && <h3>{RELATION_LABEL[rel] ?? rel} ({items.length})</h3>}
              <ul className="rel-list">
                {items.map((x) => (
                  <li key={`${rel}-${x.id}`}>
                    <button className="rel-item" onClick={() => onSelect(x.id)}>
                      <TypeIcon type={x.type} />
                      <span className="rel-name">{x.name}</span>
                      <StatusPill status={x.status} group={x.status_group} />
                    </button>
                    <div className="muted small evidence">{x.evidence}</div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {tab === "metrics" && (
        <div className="insp-body">
          {!metrics && <div className="muted">Loading…</div>}
          {metrics?.mode === "demo" && <div className="muted small">Synthetic demo series (last 60 minutes).</div>}
          {metrics?.note && <div className="muted small">{metrics.note}</div>}
          {metrics?.series.map((s) => (
            <div key={s.name} className="metric">
              <div className="small">{s.name}</div>
              <Sparkline points={s.points} />
            </div>
          ))}
          {r.links.metrics && <a className="small" href={r.links.metrics} target="_blank" rel="noopener noreferrer">Open full metrics in Datadog ↗</a>}
        </div>
      )}

      {tab === "logs" && (
        <div className="insp-body">
          {!logs && <div className="muted">Loading…</div>}
          {logs?.query && <div className="muted small">Query <code>{logs.query}</code> · last 60 min{logs.mode === "demo" && " · synthetic demo lines"}</div>}
          {logs?.note && <div className="muted small">{logs.note}</div>}
          <ul className="logs">
            {logs?.logs.map((l, i) => (
              <li key={i} className={`log-${l.status}`}>
                <span className="muted">{new Date(l.timestamp).toLocaleTimeString()}</span>
                <span className="log-status">{l.status}</span>
                <span>{l.message}</span>
              </li>
            ))}
          </ul>
          {r.links.logs && <a className="small" href={r.links.logs} target="_blank" rel="noopener noreferrer">Open in Log Explorer ↗</a>}
        </div>
      )}

      {tab === "topology" && <TopologyTab id={id} onSelect={onSelect} />}

      {tab === "history" && (
        <div className="insp-body">
          {!history && <div className="muted">Loading…</div>}
          {history && (
            <ul className="timeline">
              {history.changes.map((c) => (
                <li key={c.id} className={`tl-${c.change}`}>
                  <span className="tl-dot" />
                  <div>
                    <div className="small muted" title={fmtTime(c.at)}>{fmtTime(c.at)} · {relTime(c.at)}</div>
                    <div><span className={`chg chg-${c.change}`}>{c.change}</span> {c.summary}</div>
                  </div>
                </li>
              ))}
              <li className="tl-first">
                <span className="tl-dot" />
                <div>
                  <div className="small muted">{fmtTime(history.first_indexed)}</div>
                  <div>First indexed by Datadog Discovery Engine</div>
                </div>
              </li>
            </ul>
          )}
          {history && !history.changes.length && <p className="muted small">No changes recorded since it was first indexed.</p>}
        </div>
      )}

      {tab === "raw" && (
        <div className="insp-body">
          <pre className="raw">{JSON.stringify(r, null, 2)}</pre>
        </div>
      )}
    </aside>
  );
}

function groupBy(items: Related[]): Record<string, Related[]> {
  return items.reduce<Record<string, Related[]>>((acc, x) => {
    (acc[x.relation] ??= []).push(x);
    return acc;
  }, {});
}

const EXTRA_ATTRS: [string, string][] = [
  ["engine", "Database engine"], ["db", "Database"], ["instance", "Instance"], ["image", "Image"], ["namespace", "Namespace"], ["cluster", "Cluster"], ["host", "Host"], ["containers", "Containers"],
  ["node_count", "Nodes"], ["pods", "Pods"], ["restarts", "Restarts"], ["device", "Device"], ["interface", "Interface"],
  ["mac_address", "MAC address"], ["aws_service", "AWS service"], ["region", "Region"], ["aws_account", "AWS account"],
  ["discovered_via", "Discovered via"], ["derived_from", "Derived from"],
];

function TopologyTab({ id, onSelect }: { id: number; onSelect: (id: number) => void }) {
  const nav = useNavigate();
  const [hops, setHops] = useState(1);
  const [data, setData] = useState<TopoData | null>(null);
  const [err, setErr] = useState("");
  const ref = useRef<TopologyHandle>(null);
  useEffect(() => {
    setData(null);
    setErr("");
    api<TopoData>(`/resources/${id}/topology`, { params: { hops } }).then(setData).catch((e) => setErr(e.message));
  }, [id, hops]);
  return (
    <div className="insp-body">
      <div className="row gap topo-tab-bar">
        <div className="seg small-seg">
          {[1, 2].map((h) => <button key={h} className={cx(hops === h && "active")} onClick={() => setHops(h)}>{h} hop{h === 2 ? "s" : ""}</button>)}
        </div>
        <span className="grow" />
        <button className="btn small" onClick={() => ref.current?.exportPng()} title="Export PNG">PNG</button>
        <button className="btn small" onClick={() => nav(`/topology/${id}${hops === 2 ? "?hops=2" : ""}`)}>Open full page</button>
      </div>
      {err && <div className="muted small">{err}</div>}
      {!data && !err && <div className="muted">Building graph…</div>}
      {data && data.nodes.length === 1 && <p className="muted small">No relationships found for this resource yet.</p>}
      {data && data.nodes.length > 1 && (
        <div className="topo-mini">
          <TopologyGraph ref={ref} data={data} height={360} compact onSelect={onSelect}
            onRecenter={(n) => nav(`/topology/${n}${hops === 2 ? "?hops=2" : ""}`)} />
        </div>
      )}
      <p className="muted small">Click a node to inspect it here. Ctrl/⌘+scroll zooms, drag pans. Groups over 12 collapse to “+N more” (click to expand).</p>
    </div>
  );
}
