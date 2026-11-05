import {
  ArrowDown, ArrowUp, ArrowUpDown, Bookmark, ChevronLeft, ChevronRight, Download, HelpCircle, Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, download, type SearchResponse, type StatusGroup } from "../api";
import Inspector from "../components/Inspector";
import Modal from "../components/Modal";
import SearchBar, { type SearchBarHandle } from "../components/SearchBar";
import { useApp } from "../context";
import { CORE_TYPES, cx, relTime, STATUS_LABEL, StatusPill, TYPE_META, TYPES, TypeIcon } from "../util";

const SORTABLE: Record<string, string> = { name: "Name", type: "Type", ip: "IP Address", status: "Status", last_seen: "Last Seen" };

export default function Search() {
  const { can, toast } = useApp();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const scope = sp.get("scope") ?? "All";
  const types = sp.getAll("types");
  const status = sp.getAll("status");
  const env = sp.getAll("env");
  const tags = sp.getAll("tags");
  const sort = sp.get("sort") ?? "name";
  const dir = sp.get("dir") ?? "asc";
  const page = Number(sp.get("page") ?? 1);
  const size = Number(sp.get("size") ?? 10);
  const sel = sp.get("sel") ? Number(sp.get("sel")) : null;

  const [draft, setDraft] = useState(q);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [tagFilter, setTagFilter] = useState("");
  const [modal, setModal] = useState<"" | "save">("");
  const navigate = useNavigate();
  const [favQuery, setFavQuery] = useState(false);
  const [reload, setReload] = useState(0);
  const bar = useRef<SearchBarHandle>(null);
  const recordNext = useRef(true);

  useEffect(() => setDraft(q), [q]);
  const [inventoryTypes, setInventoryTypes] = useState<Record<string, number>>({});
  useEffect(() => { api<{ types: Record<string, number> }>("/facets").then((f) => setInventoryTypes(f.types)).catch(() => {}); }, []);

  const update = useCallback((patch: Record<string, string | string[] | number | null>, resetPage = true) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        next.delete(k);
        if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
        if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
        else next.set(k, String(v));
      }
      if (resetPage && !("page" in patch)) next.delete("page");
      return next;
    });
  }, [setSp]);

  const params = useMemo(() => ({ q, scope, types, status, env, tags, sort, dir, page, page_size: size }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString()]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const record = recordNext.current;
    recordNext.current = false;
    api<SearchResponse>("/search", { params: { ...params, record } })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
        setChecked(new Set());
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [params, reload]);

  useEffect(() => {
    if (!q.trim()) { setFavQuery(false); return; }
    api<{ queries: { ref: string }[] }>("/favorites").then((f) => setFavQuery(f.queries.some((x) => x.ref === q))).catch(() => {});
  }, [q]);

  const submit = (v: string) => {
    recordNext.current = true;
    if (v === q) setReload((n) => n + 1);
    update({ q: v.trim() || null, sel: null });
  };

  const addTerm = (term: string) => {
    const quoted = /\s/.test(term) ? term.replace(/:(.*)$/, ':"$1"') : term;
    const next = q.trim() ? `${q.trim()} AND ${quoted}` : quoted;
    recordNext.current = true;
    update({ q: next });
  };

  const exportCsv = (format: "csv" | "json", ids?: number[]) => {
    if (!can("export")) return toast("Your role cannot export data", "error");
    download("/export", { q, scope, types, status, env, tags, format, ids });
  };

  const toggleFavQuery = async () => {
    if (!q.trim()) return toast("Enter a query first", "info");
    try {
      if (favQuery) await api("/favorites", { method: "DELETE", params: { kind: "query", ref: q } });
      else await api("/favorites", { method: "PUT", body: { kind: "query", ref: q, label: q } });
      setFavQuery(!favQuery);
      toast(favQuery ? "Query removed from favorites" : "Query added to favorites");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  // keyboard navigation over results
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const rows = data?.results ?? [];
      const idx = rows.findIndex((r) => r.id === sel);
      if (e.key === "j" && rows.length) update({ sel: rows[Math.min(rows.length - 1, idx + 1)].id }, false);
      else if (e.key === "k" && rows.length) update({ sel: rows[Math.max(0, idx - 1)].id }, false);
      else if (e.key === "Escape" && sel) update({ sel: null }, false);
      else if (e.key === "o" && idx >= 0 && rows[idx].deep_link) window.open(rows[idx].deep_link, "_blank", "noopener");
      else if (e.key === "s") setModal("save");
      else if (e.key === "e") exportCsv("csv");
      else if (e.key === "f" && sel) void api("/favorites", { method: "PUT", body: { kind: "resource", ref: String(sel), label: rows[idx]?.name ?? "" } }).then(() => toast("Added to favorites"));
      else if (e.key === "]" && data && page < data.pages) update({ page: page + 1 }, false);
      else if (e.key === "[" && page > 1) update({ page: page - 1 }, false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const toggleIn = (key: "types" | "status" | "env" | "tags", list: string[], v: string) =>
    update({ [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] });

  const sortBy = (k: string) => update({ sort: k, dir: sort === k && dir === "asc" ? "desc" : "asc" }, false);
  const rows = data?.results ?? [];
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const visibleTypes = TYPES.filter((t) => CORE_TYPES.has(t) || (inventoryTypes[t] ?? 0) > 0 || scope === t || types.includes(t));
  const scopes = ["All", ...visibleTypes];
  const filtersActive = types.length + status.length + env.length + tags.length > 0;
  const visibleTags = (data?.facets.tags ?? []).filter((t) => t.value.toLowerCase().includes(tagFilter.toLowerCase())).slice(0, tagFilter ? 50 : 12);

  return (
    <div className={cx("search-page", sel !== null && "with-inspector")}>
      <div className="search-top">
        <SearchBar ref={bar} value={draft} onChange={setDraft} onSubmit={submit} autoFocus={!q} />
        <div className="search-tools">
          <button className="btn" onClick={() => setModal("save")}><Bookmark size={17} /> Save Search</button>
          <button className={cx("btn", favQuery && "starred")} onClick={toggleFavQuery} aria-pressed={favQuery}>
            <Star size={17} fill={favQuery ? "currentColor" : "none"} /> Favorite
          </button>
          <button className="btn" onClick={() => navigate("/help")} title="Search syntax help and examples"><HelpCircle size={17} /> Examples</button>
        </div>
      </div>

      <div className="scope-row">
        <span className="muted">Search Scope:</span>
        <div className="scopes" role="tablist" aria-label="Search scope">
          {scopes.map((s) => (
            <button key={s} role="tab" aria-selected={scope === s} className={cx("scope", scope === s && "active")} onClick={() => update({ scope: s === "All" ? null : s })}>
              {s !== "All" && <TypeIcon type={s} />} {s === "All" ? "All" : TYPE_META[s].plural}
            </button>
          ))}
        </div>
      </div>

      <div className="search-grid">
        <aside className="filters panel" aria-label="Filters">
          <div className="filters-head">
            <h2>Filters</h2>
            <button className="linklike" disabled={!filtersActive} onClick={() => update({ types: [], status: [], env: [], tags: [] })}>Clear All</button>
          </div>
          <h3>Type</h3>
          {visibleTypes.map((t) => (
            <label key={t} className="check">
              <input type="checkbox" checked={types.includes(t)} onChange={() => toggleIn("types", types, t)} />
              <span>{TYPE_META[t].plural}</span>
              <span className="count">({data?.type_counts[t] ?? 0})</span>
            </label>
          ))}
          <h3>Status</h3>
          {(Object.keys(STATUS_LABEL) as StatusGroup[]).map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={status.includes(s)} onChange={() => toggleIn("status", status, s)} />
              <span className={`sdot sdot-${s}`} />
              <span>{STATUS_LABEL[s]}</span>
              <span className="count">({data?.facets.status[s] ?? 0})</span>
            </label>
          ))}
          <h3>Environment</h3>
          {(data?.facets.env ?? []).map((f) => (
            <label key={f.value} className="check">
              <input type="checkbox" checked={env.includes(f.value)} onChange={() => toggleIn("env", env, f.value)} />
              <span>{f.value}</span>
              <span className="count">({f.count})</span>
            </label>
          ))}
          {data && !data.facets.env.length && <div className="muted small">No environments</div>}
          <h3>Tags</h3>
          <input className="input small-input" placeholder="Filter tags…" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter tags" />
          {tags.filter((t) => !visibleTags.some((v) => v.value === t)).map((t) => (
            <label key={t} className="check">
              <input type="checkbox" checked onChange={() => toggleIn("tags", tags, t)} />
              <span>{t}</span>
            </label>
          ))}
          {visibleTags.map((f) => (
            <label key={f.value} className="check">
              <input type="checkbox" checked={tags.includes(f.value)} onChange={() => toggleIn("tags", tags, f.value)} />
              <span className="ellipsis" title={f.value}>{f.value}</span>
              <span className="count">({f.count})</span>
            </label>
          ))}
        </aside>

        <section className="results panel" aria-label="Search results">
          <div className="results-head">
            <h2>Search Results ({data?.total ?? 0})</h2>
            <div className="muted small query-meta">
              {data?.query.normalized && <span title="Parsed expression">Query: {q}</span>}
              {data && <span className="sep">{data.took_ms} ms{data.cached && " · cached"}</span>}
              {loading && <span className="sep">searching…</span>}
            </div>
          </div>
          {error && <div className="error-box" role="alert">{error}</div>}

          <div className="tiles">
            {visibleTypes.map((t) => (
              <button key={t} className={cx("tile", (scope === t) && "active", !(data?.type_counts[t]) && "zero")} onClick={() => update({ scope: scope === t ? null : t })}>
                <TypeIcon type={t} size={24} />
                <span>{TYPE_META[t].plural}</span>
                <strong>{data?.type_counts[t] ?? 0}</strong>
              </button>
            ))}
          </div>

          {checked.size > 0 && (
            <div className="bulkbar">
              <span>{checked.size} selected</span>
              <button className="btn small" onClick={() => exportCsv("csv", [...checked])}><Download size={14} /> Export selected (CSV)</button>
              <button className="btn small" onClick={() => exportCsv("json", [...checked])}>JSON</button>
              <button className="linklike small" onClick={() => setChecked(new Set())}>Clear selection</button>
            </div>
          )}

          <div className="table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th className="cb">
                    <input type="checkbox" aria-label="Select all on page" checked={allChecked}
                      onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} />
                  </th>
                  {Object.entries(SORTABLE).map(([k, label]) => (
                    <th key={k} className={cx(k === "last_seen" && "right")} aria-sort={sort === k ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button className="th-sort" onClick={() => sortBy(k)}>
                        {label} {sort === k ? (dir === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} className="muted" />}
                      </button>
                    </th>
                  )).flatMap((el, i) => (i === 3 ? [el, <th key="tags">Key Tags</th>] : [el]))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cx(sel === r.id && "selected", r.stale && "stale")} onClick={() => update({ sel: sel === r.id ? null : r.id }, false)}>
                    <td className="cb" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.has(r.id)}
                        onChange={() => setChecked((c) => { const n = new Set(c); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
                    </td>
                    <td className="name-cell">
                      <TypeIcon type={r.type} />
                      <span className="name-stack">
                        <span className="ellipsis" title={r.aliases.length ? `${r.name}\nAliases: ${r.aliases.join(", ")}` : r.name}>{r.name}</span>
                        {r.matched_alias && <span className="alias-hit" title="Matched on this alias">alias: {r.matched_alias}</span>}
                      </span>
                      {r.source === "DEMO" && <span className="badge demo">DEMO</span>}
                    </td>
                    <td>{TYPE_META[r.type]?.label ?? r.type}</td>
                    <td className="mono">{r.ips[0] ?? "—"}{r.ips.length > 1 && <span className="muted small"> +{r.ips.length - 1}</span>}</td>
                    <td><StatusPill status={r.status} group={r.status_group} /></td>
                    <td className="tags-cell">
                      {r.tags.slice(0, 3).map((t) => (
                        <button key={t} className="chip" onClick={(e) => { e.stopPropagation(); addTerm(`tag:${t}`); }} title="Add to search">{t}</button>
                      ))}
                    </td>
                    <td className={cx("right", r.stale && "warn-text")} title={r.last_observed ?? ""}>{relTime(r.last_observed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && !rows.length && !error && q && <PreviouslySeen q={q} />}
            {data && !rows.length && !error && (
              <div className="empty">
                No results{q && <> for <code>{q}</code></>}. Try a wildcard such as <code>{q ? `${q.split(/\s/)[0]}*` : "eoc-*"}</code> or see the <Link to="/help#recipes">search examples</Link>.
              </div>
            )}
          </div>

          <div className="results-foot">
            <span className="muted">
              {data && data.total > 0 ? `Showing ${(page - 1) * size + 1}–${Math.min(data.total, page * size)} of ${data.total} results` : ""}
            </span>
            <div className="row gap">
              <button className="btn small" onClick={() => exportCsv("csv")} disabled={!data?.total} title="Export all matching results (e)">
                <Download size={14} /> CSV
              </button>
              <button className="btn small" onClick={() => exportCsv("json")} disabled={!data?.total}>JSON</button>
            </div>
            <Pager page={page} pages={data?.pages ?? 1} onPage={(p) => update({ page: p }, false)} />
            <select className="input page-size" value={size} onChange={(e) => update({ size: e.target.value })} aria-label="Results per page">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
          </div>
        </section>

        {sel && (
          <Inspector
            id={sel}
            onClose={() => update({ sel: null }, false)}
            onAddTerm={addTerm}
            onSelect={(id) => update({ sel: id }, false)}
            onChanged={() => setReload((n) => n + 1)}
          />
        )}
      </div>

      {modal === "save" && <SaveModal query={q} scope={scope} onClose={() => setModal("")} />}
    </div>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const nums: number[] = [];
  const start = Math.max(1, Math.min(page - 2, pages - 5));
  for (let i = start; i <= Math.min(pages, start + 5); i++) nums.push(i);
  return (
    <nav className="pager" aria-label="Pagination">
      <button className="pg" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
      {nums.map((n) => (
        <button key={n} className={cx("pg", n === page && "active")} onClick={() => onPage(n)} aria-current={n === page ? "page" : undefined}>{n}</button>
      ))}
      <button className="pg" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
    </nav>
  );
}

function SaveModal({ query, scope, onClose }: { query: string; scope: string; onClose: () => void }) {
  const { can, toast } = useApp();
  const [name, setName] = useState(query.slice(0, 60));
  const [desc, setDesc] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/saved-searches", { method: "POST", body: { name, query, scope, description: desc, shared } });
      toast("Search saved");
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Save search" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>Query<input className="input mono" value={query} readOnly /></label>
        <label>Scope<input className="input" value={scope} readOnly /></label>
        <label>Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus /></label>
        <label>Description<textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} rows={2} /></label>
        {can("saved.shared") && (
          <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with all users</label>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !name.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function PreviouslySeen({ q }: { q: string }) {
  const term = q.replace(/^[-\w]+:/, "").replace(/["*?]/g, "").trim();
  const [rows, setRows] = useState<{ id: number; at: string; name: string; type: string; change: string; summary: string }[] | null>(null);
  useEffect(() => {
    if (term.length < 2 || /\s(AND|OR)\s/i.test(q)) { setRows([]); return; }
    api<{ rows: typeof rows }>("/changes", { params: { q: term, hours: 24 * 400, change: ["removed", "renamed"], page_size: 5 } })
      .then((r) => setRows(r.rows ?? [])).catch(() => setRows([]));
  }, [term, q]);
  if (!rows?.length) return null;
  return (
    <div className="previously">
      <strong>Not in the current inventory, but previously seen:</strong>
      <ul>
        {rows.map((r) => (
          <li key={r.id}><TypeIcon type={r.type} /> <b>{r.name}</b>: <span className={`chg chg-${r.change}`}>{r.change}</span> {relTime(r.at)} <span className="muted small">({new Date(r.at).toLocaleString()}) {r.summary}</span></li>
        ))}
      </ul>
      <Link to={`/changes?period=2160&q=${encodeURIComponent(term)}`}>Full change history for “{term}” →</Link>
    </div>
  );
}
