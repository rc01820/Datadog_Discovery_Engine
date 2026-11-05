import { AlertTriangle, ArrowRight, Clock, GitCompareArrows, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Resource } from "../api";
import { ChangeLink, type ChangeRow } from "./Changes";
import SearchBar from "../components/SearchBar";
import { useApp } from "../context";
import { CORE_TYPES, relTime, StatusPill, TYPE_META, TYPES, TypeIcon } from "../util";

interface Facets { types: Record<string, number>; status: Record<string, number> }
interface Hist { query: string; scope: string; last_run: string; last_count: number }
interface ReportSummary { key: string; title: string; count: number }

const QUICK = [
  ["All alerting", "status:alert"],
  ["Warnings", "status:warn"],
  ["Network devices", "type:device"],
  ["Hosts missing env tag", "type:host missing:env"],
  ["Boston subnet", "10.10.50.0/24"],
  ["Muted monitors", "type:monitor status:muted"],
];

export default function Home() {
  const { user, status } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [facets, setFacets] = useState<Facets | null>(null);
  const [hist, setHist] = useState<Hist[]>([]);
  const [alerts, setAlerts] = useState<Resource[]>([]);
  const [favs, setFavs] = useState<{ resources: { ref: string; resource: Resource | null }[]; queries: { ref: string }[] } | null>(null);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [changes, setChanges] = useState<{ summary: Record<string, number>; rows: ChangeRow[]; total: number } | null>(null);

  useEffect(() => {
    api<Facets>("/facets").then(setFacets).catch(() => {});
    api<Hist[]>("/history").then((h) => setHist(h.slice(0, 6))).catch(() => {});
    api<{ results: Resource[] }>("/search", { params: { q: "status:alert", page_size: 6, sort: "type" } }).then((r) => setAlerts(r.results)).catch(() => {});
    api<typeof favs>("/favorites").then(setFavs).catch(() => {});
    api<ReportSummary[]>("/reports").then(setReports).catch(() => {});
    api<typeof changes>("/changes", { params: { hours: 24, page_size: 6 } }).then(setChanges).catch(() => {});
  }, []);

  const go = (query: string) => nav(`/search?q=${encodeURIComponent(query)}`);

  return (
    <div className="home">
      <section className="hero panel">
        <h2>Welcome back, {user?.display_name || user?.username}</h2>
        <p className="muted">
          {status?.mode === "demo" && "You are exploring synthetic DEMO inventory. An administrator can connect Datadog in Admin › Datadog Config. "}
          Press <kbd>/</kbd> anywhere to search, <kbd>?</kbd> for shortcuts. Have a list of IPs or hosts? Use <Link to="/bulk">Bulk Lookup</Link>.
        </p>
        <SearchBar value={q} onChange={setQ} onSubmit={go} large autoFocus />
        <div className="quick-chips">
          {QUICK.map(([label, query]) => (
            <button key={query} className="chip big" onClick={() => go(query)}>{label}</button>
          ))}
        </div>
      </section>

      <section className="tiles home-tiles">
        {TYPES.filter((t) => CORE_TYPES.has(t) || (facets?.types[t] ?? 0) > 0).map((t) => (
          <Link key={t} to={`/search?scope=${t}`} className="tile">
            <TypeIcon type={t} size={26} />
            <span>{TYPE_META[t].plural}</span>
            <strong>{facets?.types[t] ?? "…"}</strong>
          </Link>
        ))}
      </section>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head"><h2><AlertTriangle size={18} /> Alerting now ({facets?.status.alert ?? 0})</h2><Link to="/search?status=alert">View all <ArrowRight size={14} /></Link></div>
          <ul className="simple-list">
            {alerts.map((r) => (
              <li key={r.id}><Link to={`/search?q=status:alert&sel=${r.id}`}><TypeIcon type={r.type} /> {r.name}</Link><StatusPill status={r.status} group={r.status_group} /></li>
            ))}
            {!alerts.length && <li className="muted">Nothing alerting.</li>}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2><GitCompareArrows size={18} /> What changed (24h): {changes?.total ?? 0}</h2>
            <Link to="/changes?period=24">All changes <ArrowRight size={14} /></Link>
          </div>
          {changes && changes.total > 0 && (
            <div className="row gap small change-mini">
              {(["added", "removed", "status", "tags", "ips"] as const).map((k) => (
                <Link key={k} to={`/changes?period=24&change=${k}`} className={`chg chg-${k}`}>{changes.summary[k] ?? 0} {k}</Link>
              ))}
            </div>
          )}
          <ul className="simple-list">
            {changes?.rows.map((c) => (
              <li key={c.id}><span className="ellipsis"><TypeIcon type={c.type} /> <ChangeLink c={c} /> <span className="muted small">{c.summary}</span></span><span className="muted small nowrap">{relTime(c.at)}</span></li>
            ))}
            {changes && !changes.rows.length && <li className="muted">No changes in the last 24 hours.</li>}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Clock size={18} /> Recent searches</h2><Link to="/history">History <ArrowRight size={14} /></Link></div>
          <ul className="simple-list">
            {hist.map((h) => (
              <li key={h.query + h.scope}><button className="linklike mono" onClick={() => go(h.query)}>{h.query}</button><span className="muted small">{h.last_count} · {relTime(h.last_run)}</span></li>
            ))}
            {!hist.length && <li className="muted">No searches yet.</li>}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Star size={18} /> Favorites</h2><Link to="/favorites">All <ArrowRight size={14} /></Link></div>
          <ul className="simple-list">
            {favs?.resources.filter((f) => f.resource).slice(0, 4).map((f) => (
              <li key={f.ref}><Link to={`/search?q=${encodeURIComponent(`name:"${f.resource!.name}"`)}&sel=${f.ref}`}><TypeIcon type={f.resource!.type} /> {f.resource!.name}</Link><StatusPill status={f.resource!.status} group={f.resource!.status_group} /></li>
            ))}
            {favs?.queries.slice(0, 3).map((f) => (
              <li key={f.ref}><button className="linklike mono" onClick={() => go(f.ref)}>{f.ref}</button></li>
            ))}
            {favs && !favs.resources.length && !favs.queries.length && <li className="muted">Star resources or queries to pin them here.</li>}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Inventory health</h2><Link to="/reports">Reports <ArrowRight size={14} /></Link></div>
          <ul className="simple-list">
            {reports.map((r) => (
              <li key={r.key}><Link to={`/reports/${r.key}`}>{r.title}</Link><span className={r.count && r.key !== "agent-versions" ? "count-badge warn" : "count-badge"}>{r.count}</span></li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
