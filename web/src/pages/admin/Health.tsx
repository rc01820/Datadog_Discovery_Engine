import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../context";
import { fmtTime } from "../../util";

type H = Record<string, unknown> & {
  database: Record<string, unknown> & { ok: boolean };
  redis: Record<string, unknown> & { ok: boolean };
  worker: Record<string, unknown> & { ok: boolean };
  datadog: Record<string, unknown>;
  tag_enforcer?: Record<string, unknown> & { ok: boolean; configured: boolean };
  version: string;
};

function Card({ title, ok, data }: { title: string; ok: boolean; data: Record<string, unknown> }) {
  return (
    <section className="panel health-card">
      <h2>{ok ? <CheckCircle2 className="ok-text" size={20} /> : <XCircle className="alert-text" size={20} />} {title}</h2>
      <table className="kv-table">
        <tbody>
          {Object.entries(data).filter(([k]) => k !== "ok").map(([k, v]) => (
            <tr key={k}>
              <td className="muted">{k.replace(/_/g, " ")}</td>
              <td>{typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? fmtTime(v) : String(v ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function Health() {
  const { toast } = useApp();
  const [h, setH] = useState<H | null>(null);
  const [importing, setImporting] = useState(false);
  const load = () => api<H>("/admin/health").then(setH).catch(() => {});
  const importNow = async () => {
    setImporting(true);
    try {
      const r = await api<{ status: string; matched?: number; blind_spots?: number; message?: string }>("/admin/tag-enforcer/import", { method: "POST" });
      toast(r.status === "success" ? `Imported: ${r.matched} resources matched, ${r.blind_spots} with blind spots` : r.message ?? r.status,
        r.status === "success" ? "ok" : "info");
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setImporting(false);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  if (!h) return <div className="page"><div className="muted">Loading…</div></div>;
  return (
    <div className="page">
      <div className="page-head"><h1>System Health</h1><span className="muted">v{h.version} · refreshes every 10s</span></div>
      <div className="health-grid">
        <Card title="PostgreSQL (datadog-search-db)" ok={h.database.ok} data={h.database} />
        <Card title="Redis (datadog-search-redis)" ok={h.redis.ok} data={h.redis} />
        <Card title="Sync worker (datadog-search-worker)" ok={h.worker.ok} data={h.worker} />
        <Card title="Datadog connection" ok={Boolean(h.datadog.configured)} data={h.datadog} />
        {h.tag_enforcer && (
          <div>
            <Card title="Tag Enforcer (tag policy verdicts)" ok={h.tag_enforcer.ok} data={h.tag_enforcer} />
            {h.tag_enforcer.configured ? (
              <div className="health-actions">
                <button className="btn small" onClick={importNow} disabled={importing}>{importing ? "Importing…" : "Import now"}</button>
                <span className="muted small">Also runs after every sync and every 15 minutes.</span>
              </div>
            ) : (
              <p className="muted small">Set <code>TAG_ENFORCER_URL</code> and <code>TAG_ENFORCER_TOKEN</code> to import tag-policy verdicts.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
