import { CheckCircle2, PlugZap, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../context";
import { cx, fmtTime, relTime, TYPE_META, TypeIcon } from "../../util";

interface SourceStatus { source: string; last_success: string | null; last_attempt: string | null; last_error: string; category: string; record_count: number }
interface CatalogEntry { key: string; label: string; description: string; types: string[]; api: string; derived?: boolean }
interface Integ {
  org_name: string; site: string; site_label: string; sites: { value: string; label: string }[]; api_key: string; app_key: string;
  configured: boolean; env_keys: boolean; enabled: boolean; sync_interval_minutes: number; sources: string[]; available_sources: string[];
  catalog: CatalogEntry[]; type_counts: Record<string, Record<string, number>>;
  source_status: SourceStatus[];
}
interface Job { id: number; trigger: string; requested_by: string; status: string; queued_at: string; started_at: string | null; finished_at: string | null; counts: Record<string, number>; errors: { source: string; category: string; message: string }[] }

const CATEGORY: Record<string, string> = {
  permission_denied: "Permission denied", not_available: "Not available for org/site", source_unavailable: "Source unavailable",
  rate_limited: "Rate limited", error: "Error",
};

export default function DatadogConfig() {
  const { toast, refreshStatus, status } = useApp();
  const [d, setD] = useState<Integ | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [appKey, setAppKey] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [test, setTest] = useState<{ api_key: boolean; app_key: boolean; errors: string[] } | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    api<Integ>("/admin/integrations").then(setD).catch((e) => toast(e.message, "error"));
    api<Job[]>("/admin/sync-jobs").then(setJobs).catch(() => {});
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === "queued" || j.status === "running")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [jobs, load]);

  if (!d) return <div className="page"><div className="muted">Loading…</div></div>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      const body: Record<string, unknown> = { org_name: d.org_name, site: d.site, enabled: d.enabled, sync_interval_minutes: d.sync_interval_minutes, sources: d.sources };
      if (apiKey) body.api_key = apiKey;
      if (appKey) body.app_key = appKey;
      setD(await api<Integ>("/admin/integrations", { method: "PATCH", body }));
      setApiKey(""); setAppKey("");
      toast("Datadog configuration saved");
      refreshStatus();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const run = async (what: "test" | "sync" | "seed" | "purge") => {
    setBusy(what);
    try {
      if (what === "test") setTest(await api("/admin/integrations/test", { method: "POST" }));
      if (what === "sync") { const r = await api<{ job_id: number }>("/admin/sync-jobs", { method: "POST" }); toast(`Sync job ${r.job_id} queued`); }
      if (what === "seed" || what === "purge") {
        if (what === "purge" && !confirm("Remove all DEMO records?")) return;
        const r = await api<{ records: number }>("/admin/demo", { method: "POST", body: { action: what } });
        toast(`${what === "seed" ? "Seeded" : "Removed"} ${r.records} demo records`);
      }
      load();
      refreshStatus();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const toggleSourceNow = async (key: string) => {
    const sources = d.sources.includes(key) ? d.sources.filter((x) => x !== key) : [...d.sources, key];
    setBusy("src");
    try {
      setD(await api<Integ>("/admin/integrations", { method: "PATCH", body: { sources } }));
      const label = d.catalog.find((c) => c.key === key)?.label ?? key;
      toast(`${label} ${sources.includes(key) ? "enabled" : "disabled"}; applies at the next sync`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };
  const statusOf = (s: string) => d.source_status.find((x) => x.source === s);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Datadog Config</h1>
        <div className="row gap">
          <button className="btn" onClick={() => run("test")} disabled={!d.configured || !!busy}><PlugZap size={16} /> Test connection</button>
          <button className="btn-primary" onClick={() => run("sync")} disabled={!d.configured || !!busy}><RefreshCw size={16} className={cx(busy === "sync" && "spin")} /> Sync now</button>
        </div>
      </div>
      <div className="two-col">
        <form className="panel form" onSubmit={save}>
          <h2>Connection</h2>
          <label>Organization label<input className="input" value={d.org_name} onChange={(e) => setD({ ...d, org_name: e.target.value })} /></label>
          <label>Datadog site
            <select className="input" value={d.site} onChange={(e) => setD({ ...d, site: e.target.value })}>
              {d.sites.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <span className="muted small">Confirm your organization's site; API and deep links use it. Keys never leave the server.</span>
          </label>
          {d.env_keys ? (
            <p className="muted">API and application keys are supplied by environment variables and cannot be edited here.</p>
          ) : (
            <>
              <label>API key {d.api_key && <span className="muted small mono">current {d.api_key}</span>}
                <input className="input mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={d.api_key ? "Leave blank to keep" : "Enter API key"} autoComplete="off" />
              </label>
              <label>Application key {d.app_key && <span className="muted small mono">current {d.app_key}</span>}
                <input className="input mono" type="password" value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder={d.app_key ? "Leave blank to keep" : "Enter application key (read-only scopes)"} autoComplete="off" />
              </label>
            </>
          )}
          <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> Scheduled sync enabled</label>
          <label>Sync interval (minutes)<input className="input" type="number" min={5} max={1440} value={d.sync_interval_minutes} onChange={(e) => setD({ ...d, sync_interval_minutes: Number(e.target.value) })} /></label>
          <div className="form-actions"><button className="btn-primary" disabled={busy === "save"}>Save configuration</button></div>
          {test && (
            <div className={cx("test-result", test.api_key && test.app_key ? "ok" : "bad")}>
              <div>{test.api_key ? <CheckCircle2 size={16} /> : <XCircle size={16} />} API key {test.api_key ? "valid" : "invalid"}</div>
              <div>{test.app_key ? <CheckCircle2 size={16} /> : <XCircle size={16} />} Application key {test.app_key ? "valid" : "invalid"}</div>
              {test.errors.map((e) => <div key={e} className="small">{e}</div>)}
            </div>
          )}
        </form>

        <div className="col">
          <section className="panel">
            <h2>Sync status</h2>
            <table className="kv-table">
              <tbody>
                <tr><td className="muted">Scheduled sync</td><td>{d.enabled ? <span className="ok-text">On, every {d.sync_interval_minutes} min</span> : <span className="warn-text">Off (manual Sync now only)</span>}</td></tr>
                <tr><td className="muted">Last sync</td><td>{jobs[0] ? <>{fmtTime(jobs[0].finished_at ?? jobs[0].queued_at)} · <span className={jobs[0].status === "success" ? "ok-text" : jobs[0].status === "failed" ? "alert-text" : "warn-text"}>{jobs[0].status}</span></> : "never"}</td></tr>
                <tr><td className="muted">Sources enabled</td><td>{d.sources.filter((x) => d.catalog.some((c) => c.key === x)).length} of {d.catalog.length}</td></tr>
                <tr><td className="muted">Indexed from Datadog</td><td>{Object.values(d.type_counts).reduce((n, t) => n + Object.values(t).reduce((a, b) => a + b, 0), 0)} records</td></tr>
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>Demo data</h2>
            <p className="muted small">Currently {status?.resources.DEMO ?? 0} DEMO records. Remove them once Datadog is connected.</p>
            <div className="row gap">
              <button className="btn" onClick={() => run("seed")} disabled={!!busy}>Seed demo data</button>
              <button className="btn danger" onClick={() => run("purge")} disabled={!!busy || !status?.resources.DEMO}>Remove demo data</button>
            </div>
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Data sources &amp; freshness</h2>
          <span className="muted small">Toggle a source to include or exclude it from the next sync. Disabling a source removes its records at the next sync.</span>
        </div>
        <div className="table-wrap">
          <table className="data-table sources-table">
            <thead>
              <tr><th className="cb">On</th><th>Source</th><th>Resource types (indexed)</th><th>Records</th><th>Last success</th><th>Last attempt</th><th>State</th></tr>
            </thead>
            <tbody>
              {d.catalog.map((src) => {
                const st = statusOf(src.key);
                const on = d.sources.includes(src.key);
                const counts = d.type_counts[src.key] ?? {};
                return (
                  <tr key={src.key} className={cx(!on && "dim")}>
                    <td className="cb">
                      <input type="checkbox" checked={on} disabled={busy === "src"} aria-label={`Enable ${src.label}`} onChange={() => toggleSourceNow(src.key)} />
                    </td>
                    <td className="src-cell">
                      <strong>{src.label}</strong>{src.derived && <span className="badge">derived</span>}
                      <div className="muted small">{src.description}</div>
                      <div className="muted small mono">{src.api}</div>
                    </td>
                    <td>
                      <div className="type-counts">
                        {src.types.map((t) => (
                          <span key={t} className="type-count"><TypeIcon type={t} /> {TYPE_META[t]?.plural ?? t} <b>{counts[t] ?? 0}</b></span>
                        ))}
                      </div>
                    </td>
                    <td>{st?.record_count ?? "—"}</td>
                    <td title={fmtTime(st?.last_success)}>{relTime(st?.last_success)}</td>
                    <td title={fmtTime(st?.last_attempt)}>{relTime(st?.last_attempt)}</td>
                    <td>
                      {!on ? <span className="muted">disabled</span>
                        : st?.category ? <span className="warn-text" title={st.last_error}>{CATEGORY[st.category] ?? st.category}<div className="small muted">{st.last_error.slice(0, 120)}</div></span>
                        : st ? <span className="ok-text">OK</span> : <span className="muted">not synced yet</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Sync jobs</h2>
        {!jobs.length && <p className="muted">No sync jobs yet.</p>}
        {jobs.length > 0 && (
          <table className="data-table">
            <thead><tr><th>#</th><th>Trigger</th><th>Status</th><th>Queued</th><th>Duration</th><th>Records</th><th>Errors</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.id}</td>
                  <td>{j.trigger}{j.requested_by && <span className="muted small"> · {j.requested_by}</span>}</td>
                  <td><span className={cx("pill", j.status === "success" ? "pill-ok" : j.status === "failed" ? "pill-alert" : j.status === "partial" ? "pill-warn" : "pill-unknown")}><span className="dot" />{j.status}</span></td>
                  <td>{fmtTime(j.queued_at)}</td>
                  <td>{j.started_at && j.finished_at ? `${Math.round((+new Date(j.finished_at) - +new Date(j.started_at)) / 1000)}s` : "—"}</td>
                  <td className="small">{Object.entries(j.counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</td>
                  <td className="small">{j.errors.map((e) => <div key={e.source + e.message}><strong>{e.source}</strong> {CATEGORY[e.category] ?? e.category}: {e.message}</div>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
