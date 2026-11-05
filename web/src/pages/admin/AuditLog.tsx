import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download } from "../../api";
import { useApp } from "../../context";
import { cx, fmtTime } from "../../util";

type Kind = "events" | "searches";
interface Resp { rows: Record<string, unknown>[]; total: number; page: number; page_size: number }

export default function AuditLog() {
  const { toast } = useApp();
  const [kind, setKind] = useState<Kind>("events");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<Resp>("/admin/audit", { params: { kind, q, page, page_size: 50 } }).then(setData).catch((e) => toast(e.message, "error"));
    }, 200);
    return () => clearTimeout(t);
  }, [kind, q, page, toast]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Audit Log</h1>
        <div className="row gap">
          <div className="seg">
            {(["events", "searches"] as Kind[]).map((k) => (
              <button key={k} className={cx(kind === k && "active")} onClick={() => { setKind(k); setPage(1); }}>{k === "events" ? "Admin & auth events" : "Search queries"}</button>
            ))}
          </div>
          <input className="input" placeholder="Filter…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <button className="btn" onClick={() => download("/admin/audit", { kind, q, format: "csv" })}><Download size={15} /> CSV</button>
        </div>
      </div>
      <section className="panel">
        <table className="data-table">
          <thead>
            {kind === "events"
              ? <tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr>
              : <tr><th>Time</th><th>User</th><th>Query</th><th>Scope</th><th>Results</th><th>Latency</th></tr>}
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="nowrap">{fmtTime(String(r.at))}</td>
                <td>{String(r.username)}</td>
                {kind === "events" ? (
                  <>
                    <td><code>{String(r.action)}</code></td>
                    <td>{String(r.target)}</td>
                    <td className="small mono">{r.detail && Object.keys(r.detail as object).length ? JSON.stringify(r.detail) : ""}</td>
                    <td className="mono small">{String(r.ip)}</td>
                  </>
                ) : (
                  <>
                    <td className="mono">{String(r.query)}</td>
                    <td>{String(r.scope)}</td>
                    <td>{String(r.result_count)}</td>
                    <td>{String(r.took_ms)} ms</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="results-foot">
          <span className="muted">{data?.total ?? 0} entries</span>
          <div className="row gap">
            <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted">Page {page} / {pages}</span>
            <button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      </section>
    </div>
  );
}
