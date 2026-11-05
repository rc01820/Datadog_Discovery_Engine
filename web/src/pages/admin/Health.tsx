import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { fmtTime } from "../../util";

type H = Record<string, unknown> & {
  database: Record<string, unknown> & { ok: boolean };
  redis: Record<string, unknown> & { ok: boolean };
  worker: Record<string, unknown> & { ok: boolean };
  datadog: Record<string, unknown>;
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
  const [h, setH] = useState<H | null>(null);
  useEffect(() => {
    const load = () => api<H>("/admin/health").then(setH).catch(() => {});
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
      </div>
    </div>
  );
}
