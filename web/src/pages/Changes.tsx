import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, download, type StatusGroup } from "../api";
import { useApp } from "../context";
import { cx, relTime, StatusPill, TYPE_META, TYPES, TypeIcon } from "../util";

export interface ChangeRow {
  id: number;
  at: string;
  resource_id: number | null;
  resource_key: string;
  source: string;
  type: string;
  name: string;
  change: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  current_status: string | null;
  current_status_group: StatusGroup | null;
}

interface Resp {
  since: string;
  summary: Record<string, number>;
  by_type: Record<string, number>;
  rows: ChangeRow[];
  total: number;
  page: number;
  page_size: number;
}

export const CHANGE_LABEL: Record<string, string> = {
  added: "Added", removed: "Removed", status: "Status changes", tags: "Tag changes", ips: "IP changes",
  aliases: "Alias changes", renamed: "Renamed",
};

const PERIODS: [string, string][] = [["today", "Today"], ["24", "Last 24 hours"], ["168", "Last 7 days"], ["720", "Last 30 days"], ["2160", "Last 90 days"]];

function sinceParams(period: string): { since?: string; hours?: number } {
  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { since: d.toISOString() };
  }
  return { hours: Number(period) };
}

export function ChangeLink({ c }: { c: ChangeRow }) {
  if (c.resource_id && c.change !== "removed") {
    return <Link to={`/search?q=${encodeURIComponent(`name:"${c.name}"`)}&sel=${c.resource_id}`}>{c.name}</Link>;
  }
  return <span className={cx(c.change === "removed" && "struck")}>{c.name}</span>;
}

export default function Changes() {
  const { toast } = useApp();
  const [sp, setSp] = useSearchParams();
  const period = sp.get("period") ?? "today";
  const change = sp.getAll("change");
  const type = sp.get("type") ?? "";
  const q = sp.get("q") ?? "";
  const page = Number(sp.get("page") ?? 1);
  const [draft, setDraft] = useState(q);
  const [data, setData] = useState<Resp | null>(null);

  const set = (patch: Record<string, string | string[] | null>) =>
    setSp((prev) => {
      const n = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        n.delete(k);
        if (Array.isArray(v)) v.forEach((x) => n.append(k, x));
        else if (v) n.set(k, v);
      }
      if (!("page" in patch)) n.delete("page");
      return n;
    });

  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    const t = setTimeout(() => draft !== q && set({ q: draft || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const params = useMemo(() => ({ ...sinceParams(period), change, type: type ? [type] : [], q, page, page_size: 100 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString()]);

  useEffect(() => {
    api<Resp>("/changes", { params }).then(setData).catch((e) => toast(e.message, "error"));
  }, [params, toast]);

  const grouped = useMemo(() => {
    const out: [string, ChangeRow[]][] = [];
    for (const r of data?.rows ?? []) {
      const day = new Date(r.at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
      if (!out.length || out[out.length - 1][0] !== day) out.push([day, []]);
      out[out.length - 1][1].push(r);
    }
    return out;
  }, [data]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const toggleChange = (k: string) => set({ change: change.includes(k) ? change.filter((x) => x !== k) : [...change, k] });

  return (
    <div className="page">
      <div className="page-head">
        <h1>What Changed</h1>
        <div className="row gap">
          <select className="input" value={period} onChange={(e) => set({ period: e.target.value })} aria-label="Time period">
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input" value={type} onChange={(e) => set({ type: e.target.value || null })} aria-label="Resource type">
            <option value="">All types</option>
            {TYPES.filter((t) => t !== "Tag").map((t) => <option key={t} value={t}>{TYPE_META[t].plural}</option>)}
          </select>
          <input className="input" placeholder="Name, IP or text… e.g. when did web-03 disappear?" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 300 }} aria-label="Filter changes" />
          <button className="btn" onClick={() => download("/changes", { ...params, format: "csv" })}><Download size={15} /> CSV</button>
        </div>
      </div>

      <div className="change-tiles">
        {Object.entries(CHANGE_LABEL).map(([k, label]) => (
          <button key={k} className={cx("change-tile panel", `ct-${k}`, change.includes(k) && "active")} onClick={() => toggleChange(k)} aria-pressed={change.includes(k)}>
            <strong>{data?.summary[k] ?? "…"}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>{data?.total ?? 0} change{data?.total === 1 ? "" : "s"} {PERIODS.find(([v]) => v === period)?.[1].toLowerCase()}</h2>
          {(change.length > 0 || type || q) && <button className="linklike" onClick={() => { setDraft(""); set({ change: [], type: null, q: null }); }}>Clear filters</button>}
        </div>
        {data && !data.rows.length && (
          <p className="muted">
            No changes recorded in this period{q && <> matching <code>{q}</code></>}. Changes are captured on every sync; the first sync of each source
            is the baseline, so additions start being reported from the second sync.
          </p>
        )}
        {grouped.map(([day, rows]) => (
          <div key={day} className="change-day">
            <h3>{day}</h3>
            <table className="data-table changes-table">
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap muted" title={new Date(c.at).toLocaleString()}>{new Date(c.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</td>
                    <td><span className={`chg chg-${c.change}`}>{c.change}</span></td>
                    <td className="nowrap"><TypeIcon type={c.type} /> <ChangeLink c={c} />{c.source === "DEMO" && <span className="badge demo">DEMO</span>}</td>
                    <td className="change-summary">{c.summary}</td>
                    <td className="right">{c.current_status && c.current_status_group && c.change !== "removed" ? <StatusPill status={c.current_status} group={c.current_status_group} /> : c.change === "removed" ? <span className="muted small">gone</span> : null}</td>
                    <td className="right muted small nowrap">{relTime(c.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {pages > 1 && (
          <div className="results-foot">
            <span className="muted">Page {page} of {pages}</span>
            <div className="row gap">
              <button className="btn small" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
              <button className="btn small" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
