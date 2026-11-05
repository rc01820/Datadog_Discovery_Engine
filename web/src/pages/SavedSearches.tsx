import { Pencil, Play, Share2, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type SavedSearch } from "../api";
import Modal from "../components/Modal";
import { useApp } from "../context";
import { cx, relTime } from "../util";

const TEMPLATES: [string, string, string][] = [
  ["All alerting monitors", "type:monitor AND status:alert", "Monitors currently in Alert"],
  ["Devices in Boston", "type:device AND geolocation:boston", "Network devices tagged geolocation:boston"],
  ["Hosts missing required tags", "type:host AND (missing:env OR missing:app OR missing:costcenter)", "Tag hygiene"],
  ["IP collision investigation", "ip:10.10.50.40", "Replace with the IP under investigation"],
  ["Production web tier", "tag:env:prod AND tag:role:web", "Web servers in prod"],
  ["Muted or unknown", "status:muted OR status:unknown", "Monitors/hosts that may hide problems"],
];

export default function SavedSearches() {
  const { can, toast } = useApp();
  const nav = useNavigate();
  const [items, setItems] = useState<SavedSearch[]>([]);
  const [edit, setEdit] = useState<Partial<SavedSearch> | null>(null);

  const load = () => api<SavedSearch[]>("/saved-searches").then(setItems).catch((e) => toast(e.message, "error"));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (s: SavedSearch) => {
    await api(`/saved-searches/${s.id}/run`, { method: "POST" }).catch(() => {});
    nav(`/search?q=${encodeURIComponent(s.query)}${s.scope !== "All" ? `&scope=${s.scope}` : ""}`);
  };

  const remove = async (s: SavedSearch) => {
    if (!confirm(`Delete saved search "${s.name}"?`)) return;
    try {
      await api(`/saved-searches/${s.id}`, { method: "DELETE" });
      toast("Deleted");
      void load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const fav = async (s: SavedSearch) => {
    if (s.favorite) await api("/favorites", { method: "DELETE", params: { kind: "query", ref: s.query } });
    else await api("/favorites", { method: "PUT", body: { kind: "query", ref: s.query, label: s.name } });
    void load();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    try {
      const body = { name: edit.name, query: edit.query, scope: edit.scope ?? "All", description: edit.description ?? "", shared: !!edit.shared };
      if (edit.id) await api(`/saved-searches/${edit.id}`, { method: "PATCH", body });
      else await api("/saved-searches", { method: "POST", body });
      toast("Saved");
      setEdit(null);
      void load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const section = (title: string, list: SavedSearch[]) => (
    <section className="panel">
      <h2>{title} ({list.length})</h2>
      {!list.length && <p className="muted">None yet. Save a search from the Search page or start from a template below.</p>}
      {list.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Name</th><th>Query</th><th>Owner</th><th>Runs</th><th>Last run</th><th /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.shared && <span className="badge"><Share2 size={11} /> shared</span>}<div className="muted small">{s.description}</div></td>
                <td className="mono">{s.query}{s.scope !== "All" && <span className="muted"> · {s.scope}</span>}</td>
                <td>{s.owner}</td>
                <td>{s.run_count}</td>
                <td>{relTime(s.last_run_at)}</td>
                <td className="actions">
                  <button className="icon-btn" title="Run" onClick={() => run(s)}><Play size={16} /></button>
                  <button className={cx("icon-btn", s.favorite && "starred")} title="Favorite" onClick={() => fav(s)}><Star size={16} fill={s.favorite ? "currentColor" : "none"} /></button>
                  {(s.mine || (s.shared && can("saved.shared"))) && (
                    <>
                      <button className="icon-btn" title="Edit" onClick={() => setEdit(s)}><Pencil size={16} /></button>
                      <button className="icon-btn danger" title="Delete" onClick={() => remove(s)}><Trash2 size={16} /></button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );

  return (
    <div className="page">
      <div className="page-head">
        <h1>Saved Searches</h1>
        <button className="btn-primary" onClick={() => setEdit({ name: "", query: "", scope: "All", shared: false })}>New saved search</button>
      </div>
      {section("My searches", items.filter((s) => s.mine && !s.shared))}
      {section("Shared searches", items.filter((s) => s.shared))}
      <section className="panel">
        <h2>Templates</h2>
        <div className="template-grid">
          {TEMPLATES.map(([name, q, d]) => (
            <div key={name} className="template">
              <strong>{name}</strong>
              <code>{q}</code>
              <span className="muted small">{d}</span>
              <div className="row gap">
                <button className="btn small" onClick={() => nav(`/search?q=${encodeURIComponent(q)}`)}>Run</button>
                <button className="btn small" onClick={() => setEdit({ name, query: q, scope: "All", description: d, shared: false })}>Save as…</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      {edit && (
        <Modal title={edit.id ? "Edit saved search" : "New saved search"} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={save}>
            <label>Name<input className="input" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required autoFocus /></label>
            <label>Query<input className="input mono" value={edit.query ?? ""} onChange={(e) => setEdit({ ...edit, query: e.target.value })} required /></label>
            <label>Scope
              <select className="input" value={edit.scope ?? "All"} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}>
                {["All", "Host", "Device", "Monitor", "Tag", "Service", "Synthetic", "Dashboard", "VMware", "Cloud"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label>Description<textarea className="input" rows={2} value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label>
            {can("saved.shared") && <label className="check"><input type="checkbox" checked={!!edit.shared} onChange={(e) => setEdit({ ...edit, shared: e.target.checked })} /> Share with all users</label>}
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
