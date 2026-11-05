import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../context";
import { cx, fmtTime } from "../util";

interface Summary { key: string; title: string; description: string; count: number }
interface Report { key: string; title: string; description: string; query: string; columns: string[]; rows: Record<string, unknown>[] }

function cell(v: unknown, col: string) {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length > 6 ? `${v.slice(0, 6).join(", ")} +${v.length - 6}` : v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (col.includes("observed") || col.endsWith("_at")) return fmtTime(String(v));
  return String(v);
}

export default function Reports() {
  const { key } = useParams();
  const { toast } = useApp();
  const nav = useNavigate();
  const [list, setList] = useState<Summary[]>([]);
  const [rep, setRep] = useState<Report | null>(null);

  useEffect(() => { api<Summary[]>("/reports").then(setList).catch((e) => toast(e.message, "error")); }, [toast]);
  useEffect(() => {
    setRep(null);
    if (key) api<Report>(`/reports/${key}`).then(setRep).catch((e) => toast(e.message, "error"));
  }, [key, toast]);

  const open = (row: Record<string, unknown>) => {
    if (typeof row.query === "string") nav(`/search?q=${encodeURIComponent(row.query)}`);
    else if (row.id) nav(`/search?q=${encodeURIComponent(`name:"${row.name}"`)}&sel=${row.id}`);
  };

  return (
    <div className="page">
      <div className="page-head"><h1>Reports</h1></div>
      <div className="report-cards">
        {list.map((r) => (
          <Link key={r.key} to={`/reports/${r.key}`} className={cx("report-card panel", key === r.key && "active")}>
            <strong className={cx("big-num", r.count > 0 && r.key !== "agent-versions" && "warn-text")}>{r.count}</strong>
            <span>{r.title}</span>
            <span className="muted small">{r.description}</span>
          </Link>
        ))}
      </div>
      {!key && <p className="muted">Select a report. Every row links back to search so the evidence is traceable.</p>}
      {rep && (
        <section className="panel">
          <div className="panel-head">
            <h2>{rep.title} ({rep.rows.length})</h2>
            {rep.query && <button className="btn small" onClick={() => nav(`/search?q=${encodeURIComponent(rep.query)}`)}>Open as search</button>}
          </div>
          <p className="muted">{rep.description}</p>
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead><tr>{rep.columns.map((c) => <th key={c}>{c.replace(/_/g, " ")}</th>)}</tr></thead>
              <tbody>
                {rep.rows.map((r, i) => (
                  <tr key={i} onClick={() => open(r)}>
                    {rep.columns.map((c) => <td key={c} className={cx(c === "ip" && "mono", c === "outdated" && r[c] === true && "warn-text")}>{cell(r[c], c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rep.rows.length && <p className="muted">Nothing to report. 🎉</p>}
        </section>
      )}
    </div>
  );
}
