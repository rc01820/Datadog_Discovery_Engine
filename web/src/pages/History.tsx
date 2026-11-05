import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../context";
import { fmtTime } from "../util";

interface Hist { query: string; scope: string; last_run: string; runs: number; last_count: number; avg_ms: number }

export default function History() {
  const { toast } = useApp();
  const nav = useNavigate();
  const [rows, setRows] = useState<Hist[] | null>(null);
  const [filter, setFilter] = useState("");
  const load = () => api<Hist[]>("/history").then(setRows).catch((e) => toast(e.message, "error"));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async () => {
    if (!confirm("Clear your search history? (The organization audit log is retained.)")) return;
    await api("/history", { method: "DELETE" });
    void load();
  };

  const shown = (rows ?? []).filter((r) => r.query.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <h1>History</h1>
        <div className="row gap">
          <input className="input" placeholder="Filter history…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn" onClick={clear} disabled={!rows?.length}>Clear history</button>
        </div>
      </div>
      <section className="panel">
        {rows && !rows.length && <p className="muted">Your searches will appear here.</p>}
        {shown.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Query</th><th>Scope</th><th>Runs</th><th>Last results</th><th>Avg latency</th><th>Last run</th><th /></tr></thead>
            <tbody>
              {shown.map((h) => (
                <tr key={h.query + h.scope}>
                  <td className="mono">{h.query}</td>
                  <td>{h.scope}</td>
                  <td>{h.runs}</td>
                  <td>{h.last_count}</td>
                  <td>{h.avg_ms} ms</td>
                  <td>{fmtTime(h.last_run)}</td>
                  <td className="actions">
                    <button className="icon-btn" title="Run again" onClick={() => nav(`/search?q=${encodeURIComponent(h.query)}${h.scope !== "All" ? `&scope=${h.scope}` : ""}`)}><Play size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
