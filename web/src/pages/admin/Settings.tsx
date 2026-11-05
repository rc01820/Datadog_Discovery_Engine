import { Archive, Download, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import Modal from "../../components/Modal";
import { useApp } from "../../context";
import { fmtTime, relTime } from "../../util";

interface S { viewer_can_export: boolean; auto_purge_demo: boolean; history_retention_days: number; ephemeral_history_retention_days: number; track_ephemeral_changes: boolean; history_archive_enabled: boolean; session_hours: number; required_tags: string[]; stale_after_hours: number; audit_retention_days: number; default_page_size: number }

export default function Settings() {
  const { toast } = useApp();
  const [s, setS] = useState<S | null>(null);
  const [tags, setTags] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api<S>("/admin/settings").then((x) => { setS(x); setTags(x.required_tags.join(", ")); }).catch((e) => toast(e.message, "error"));
  }, [toast]);
  if (!s) return <div className="page"><div className="muted">Loading…</div></div>;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { ...s, required_tags: tags.split(",").map((t) => t.trim()).filter(Boolean) };
      const x = await api<S>("/admin/settings", { method: "PATCH", body });
      setS(x);
      setTags(x.required_tags.join(", "));
      toast("Settings saved");
      setReload((n) => n + 1);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };
  const num = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Settings</h1></div>
      <form className="panel form" onSubmit={save}>
        <h2>Sessions &amp; access</h2>
        <label>Session lifetime (hours)<input className="input" type="number" min={1} max={72} value={s.session_hours} onChange={num("session_hours")} /></label>
        <label className="check"><input type="checkbox" checked={s.viewer_can_export} onChange={(e) => setS({ ...s, viewer_can_export: e.target.checked })} /> Viewers may export data</label>
        <h2>Demo data</h2>
        <label className="check"><input type="checkbox" checked={s.auto_purge_demo !== false} onChange={(e) => setS({ ...s, auto_purge_demo: e.target.checked })} /> Remove DEMO data automatically once real Datadog data has synced</label>
        <h2>Inventory hygiene</h2>
        <label>Required tag keys (comma separated)<input className="input mono" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="env, app, costcenter" /></label>
        <label>Mark infrastructure stale after (hours)<input className="input" type="number" min={1} value={s.stale_after_hours} onChange={num("stale_after_hours")} /></label>
        <h2>Change history</h2>
        <RetentionField
          label="Keep change history for infrastructure, monitors and other resources"
          value={s.history_retention_days ?? 365} fallback={365}
          onChange={(v) => setS({ ...s, history_retention_days: v })}
        />
        <label className="check"><input type="checkbox" checked={s.track_ephemeral_changes !== false} onChange={(e) => setS({ ...s, track_ephemeral_changes: e.target.checked })} /> Record changes for containers and pods (turn off to stop tracking deploy churn)</label>
        <RetentionField
          label="Keep container and pod change history"
          value={s.ephemeral_history_retention_days ?? 14} fallback={14}
          hint="Containers and pods are replaced on every deploy, so their history grows fastest. A short window keeps the database small."
          onChange={(v) => setS({ ...s, ephemeral_history_retention_days: v })}
        />
        <label className="check"><input type="checkbox" checked={!!s.history_archive_enabled} onChange={(e) => setS({ ...s, history_archive_enabled: e.target.checked })} /> Archive entries to a gzip CSV file before they roll off</label>
        <p className="muted small" style={{ margin: 0 }}>Roll-off runs hourly. Use the <b>Change history storage</b> panel below to see usage or purge now. Save settings first.</p>
        <h2>Retention</h2>
        <label>Audit log and search history retention (days)<input className="input" type="number" min={7} max={3650} value={s.audit_retention_days} onChange={num("audit_retention_days")} /></label>
        <div className="form-actions"><button className="btn-primary">Save settings</button></div>
      </form>
      <HistoryStorage reload={reload} />
    </div>
  );
}

function RetentionField({ label, value, fallback, hint, onChange }: { label: string; value: number; fallback: number; hint?: string; onChange: (v: number) => void }) {
  const forever = value === 0;
  return (
    <div className="retention-field">
      <label>{label} (days)
        <div className="row gap">
          <input className="input" type="number" min={1} max={36500} value={forever ? "" : value} placeholder={forever ? "forever" : ""}
            disabled={forever} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))} style={{ width: 140 }} />
          <label className="check"><input type="checkbox" checked={forever} onChange={(e) => onChange(e.target.checked ? 0 : fallback)} /> Keep forever</label>
        </div>
        {hint && <span className="muted small">{hint}</span>}
      </label>
    </div>
  );
}

interface Usage {
  total: number; containers_pods: number; other: number; oldest: string | null; newest: string | null; bytes: number;
  by_change: Record<string, number>;
  due: { other: number; containers_pods: number; total: number };
  settings: { history_retention_days: number; ephemeral_history_retention_days: number; history_archive_enabled: boolean };
  last_rolloff: { trigger: string; deleted: number; at: string; archive: { file: string; bytes: number } | null; note?: string } | null;
  archive: { enabled: boolean; dir: string; writable: boolean };
}
interface ArchiveFile { file: string; bytes: number; created: string }

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function HistoryStorage({ reload }: { reload: number }) {
  const { toast } = useApp();
  const [u, setU] = useState<Usage | null>(null);
  const [archives, setArchives] = useState<ArchiveFile[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Usage>("/admin/history").then(setU).catch((e) => toast(e.message, "error"));
    api<{ archives: ArchiveFile[] }>("/admin/history/archives").then((r) => setArchives(r.archives)).catch(() => {});
  }, [toast]);
  useEffect(() => { load(); }, [load, reload]);

  const purge = async () => {
    setBusy(true);
    try {
      const r = await api<{ deleted: number; archive: { file: string } | null }>("/admin/history/purge", { method: "POST" });
      toast(r.deleted ? `Rolled off ${r.deleted.toLocaleString()} entries${r.archive ? `; archived to ${r.archive.file}` : ""}` : "Nothing was due to roll off", r.deleted ? "ok" : "info");
      setConfirm(false);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!u) return <section className="panel"><div className="muted">Loading change history usage…</div></section>;
  const keep = (d: number) => (d === 0 ? "forever" : `${d} days`);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Change history storage</h2>
        <button className="btn danger" onClick={() => setConfirm(true)} disabled={!u.due.total}><Trash2 size={15} /> Purge now{u.due.total ? ` (${u.due.total.toLocaleString()})` : ""}</button>
      </div>
      <div className="usage-grid">
        <div className="usage"><span className="muted small">Entries</span><strong>{u.total.toLocaleString()}</strong><span className="muted small">{u.other.toLocaleString()} resources · {u.containers_pods.toLocaleString()} containers/pods</span></div>
        <div className="usage"><span className="muted small">Space used</span><strong>{bytes(u.bytes)}</strong><span className="muted small">table + indexes</span></div>
        <div className="usage"><span className="muted small">Oldest entry</span><strong>{u.oldest ? relTime(u.oldest) : "—"}</strong><span className="muted small">{u.oldest ? fmtTime(u.oldest) : "no history yet"}</span></div>
        <div className="usage"><span className="muted small">Due to roll off</span><strong className={u.due.total ? "warn-text" : ""}>{u.due.total.toLocaleString()}</strong><span className="muted small">{u.due.other.toLocaleString()} resources · {u.due.containers_pods.toLocaleString()} containers/pods</span></div>
      </div>
      <table className="kv-table">
        <tbody>
          <tr><td className="muted">Saved retention</td><td>resources: <b>{keep(u.settings.history_retention_days)}</b> · containers/pods: <b>{keep(u.settings.ephemeral_history_retention_days)}</b></td></tr>
          <tr><td className="muted">Archiving</td><td>{u.archive.enabled ? (u.archive.writable ? <span className="ok-text">On: gzip CSV written to {u.archive.dir} before deletion</span> : <span className="alert-text">On, but {u.archive.dir} is not writable, so roll-off is paused (nothing is deleted)</span>) : <span className="muted">Off: entries are deleted without a copy</span>}</td></tr>
          <tr><td className="muted">Last roll-off</td><td>{u.last_rolloff ? <>{relTime(u.last_rolloff.at)} ({u.last_rolloff.trigger}) · {u.last_rolloff.deleted.toLocaleString()} removed{u.last_rolloff.archive && <> · archived to <span className="mono small">{u.last_rolloff.archive.file}</span></>}{u.last_rolloff.note && <> · {u.last_rolloff.note}</>}</> : "not run yet"}</td></tr>
        </tbody>
      </table>
      <h3><Archive size={15} style={{ verticalAlign: -2 }} /> Archives ({archives.length})</h3>
      {!archives.length && <p className="muted small">No archives yet. Turn on archiving above to keep a copy of every entry that rolls off.</p>}
      {archives.length > 0 && (
        <table className="data-table">
          <thead><tr><th>File</th><th>Size</th><th>Created</th><th /></tr></thead>
          <tbody>
            {archives.map((a) => (
              <tr key={a.file}>
                <td className="mono small">{a.file}</td>
                <td>{bytes(a.bytes)}</td>
                <td>{fmtTime(a.created)}</td>
                <td className="actions"><a className="btn small" href={`/api/v1/admin/history/archives/${encodeURIComponent(a.file)}`} download><Download size={14} /> Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirm && (
        <Modal title="Purge change history now" onClose={() => setConfirm(false)}>
          <p>This applies the <b>saved</b> retention settings immediately:</p>
          <ul>
            <li><b>{u.due.other.toLocaleString()}</b> resource entries older than {keep(u.settings.history_retention_days)}</li>
            <li><b>{u.due.containers_pods.toLocaleString()}</b> container/pod entries older than {keep(u.settings.ephemeral_history_retention_days)}</li>
          </ul>
          <p className={u.archive.enabled ? "ok-text" : "warn-text"}>
            {u.archive.enabled ? "They will be archived to a gzip CSV first." : "Archiving is off, so the entries are deleted permanently."}
          </p>
          <div className="form-actions">
            <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn danger" onClick={purge} disabled={busy}><Trash2 size={15} /> {busy ? "Purging…" : `Purge ${u.due.total.toLocaleString()} entries`}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
