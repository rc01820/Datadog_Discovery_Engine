import { ExternalLink, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Resource } from "../api";
import { useApp } from "../context";
import { relTime, StatusPill, TypeIcon } from "../util";

interface Fav { kind: string; ref: string; label: string; created_at: string; resource?: Resource | null }

export default function Favorites() {
  const { toast } = useApp();
  const nav = useNavigate();
  const [data, setData] = useState<{ resources: Fav[]; queries: Fav[] } | null>(null);
  const load = () => api<{ resources: Fav[]; queries: Fav[] }>("/favorites").then(setData).catch((e) => toast(e.message, "error"));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (f: Fav) => {
    await api("/favorites", { method: "DELETE", params: { kind: f.kind, ref: f.ref } });
    void load();
  };

  return (
    <div className="page">
      <div className="page-head"><h1>Favorites</h1></div>
      <section className="panel">
        <h2>Resources ({data?.resources.length ?? 0})</h2>
        {data && !data.resources.length && <p className="muted">Use the ☆ in the resource inspector (or press <kbd>f</kbd>) to favorite a resource.</p>}
        <table className="data-table">
          <tbody>
            {data?.resources.map((f) => (
              <tr key={f.ref}>
                {f.resource ? (
                  <>
                    <td><Link to={`/search?q=${encodeURIComponent(`name:"${f.resource.name}"`)}&sel=${f.ref}`}><TypeIcon type={f.resource.type} /> {f.resource.name}</Link></td>
                    <td>{f.resource.type}</td>
                    <td className="mono">{f.resource.ips[0] ?? "—"}</td>
                    <td><StatusPill status={f.resource.status} group={f.resource.status_group} /></td>
                    <td>{relTime(f.resource.last_observed)}</td>
                    <td className="actions">
                      {f.resource.deep_link && <a className="icon-btn" href={f.resource.deep_link} target="_blank" rel="noopener noreferrer" title="Open in Datadog"><ExternalLink size={16} /></a>}
                      <button className="icon-btn danger" onClick={() => remove(f)} title="Remove"><Trash2 size={16} /></button>
                    </td>
                  </>
                ) : (
                  <>
                    <td colSpan={5} className="muted">{f.label} — no longer indexed</td>
                    <td className="actions"><button className="icon-btn danger" onClick={() => remove(f)} title="Remove"><Trash2 size={16} /></button></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Queries ({data?.queries.length ?? 0})</h2>
        {data && !data.queries.length && <p className="muted">Use the Favorite button on the Search page to pin a query.</p>}
        <table className="data-table">
          <tbody>
            {data?.queries.map((f) => (
              <tr key={f.ref}>
                <td><button className="linklike mono" onClick={() => nav(`/search?q=${encodeURIComponent(f.ref)}`)}>{f.ref}</button></td>
                <td className="muted">{f.label !== f.ref ? f.label : ""}</td>
                <td className="actions"><button className="icon-btn danger" onClick={() => remove(f)} title="Remove"><Trash2 size={16} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
