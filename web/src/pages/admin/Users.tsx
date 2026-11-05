import { KeyRound, LogOut, Pencil, Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import Modal from "../../components/Modal";
import { useApp } from "../../context";
import { cx, fmtTime } from "../../util";

interface Row { id: number; username: string; display_name: string; email: string; enabled: boolean; role: string; created_at: string; last_login: string | null; active_sessions: number }
const ROLES = ["Viewer", "Operator", "Administrator"];

export default function Users() {
  const { user, toast } = useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<null | { mode: "add" | "edit" | "reset"; row?: Row; username: string; display_name: string; email: string; role: string; password: string }>(null);

  const load = () => api<Row[]>("/admin/users").then(setRows).catch((e) => toast(e.message, "error"));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      void load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const { mode, row, ...f } = form;
    if (mode === "add") await act(() => api("/admin/users", { method: "POST", body: f }), `User ${f.username} created`);
    else if (mode === "edit") await act(() => api(`/admin/users/${row!.id}`, { method: "PATCH", body: { role: f.role, display_name: f.display_name, email: f.email } }), "User updated");
    else await act(() => api(`/admin/users/${row!.id}`, { method: "PATCH", body: { password: f.password } }), "Password reset; sessions revoked");
    setForm(null);
  };

  const shown = rows.filter((r) => `${r.username} ${r.display_name} ${r.email} ${r.role}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <h1>Users</h1>
        <div className="row gap">
          <input className="input" placeholder="Filter users…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn-primary" onClick={() => setForm({ mode: "add", username: "", display_name: "", email: "", role: "Viewer", password: "" })}>
            <UserPlus size={16} /> Add user
          </button>
        </div>
      </div>
      <section className="panel">
        <table className="data-table">
          <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Sessions</th><th>Last sign-in</th><th>Created</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={cx(!r.enabled && "dim")}>
                <td><strong>{r.username}</strong>{r.id === user?.id && <span className="badge">you</span>}<div className="muted small">{r.email}</div></td>
                <td>{r.display_name}</td>
                <td>
                  <select className="input inline" value={r.role} disabled={r.id === user?.id}
                    onChange={(e) => act(() => api(`/admin/users/${r.id}`, { method: "PATCH", body: { role: e.target.value } }), "Role updated")}>
                    {ROLES.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </td>
                <td><span className={cx("pill", r.enabled ? "pill-ok" : "pill-muted")}><span className="dot" />{r.enabled ? "Active" : "Disabled"}</span></td>
                <td>{r.active_sessions}</td>
                <td>{fmtTime(r.last_login)}</td>
                <td>{fmtTime(r.created_at)}</td>
                <td className="actions">
                  <button className="icon-btn" title="Edit" onClick={() => setForm({ mode: "edit", row: r, username: r.username, display_name: r.display_name, email: r.email, role: r.role, password: "" })}><Pencil size={16} /></button>
                  <button className="icon-btn" title="Reset password" onClick={() => setForm({ mode: "reset", row: r, username: r.username, display_name: "", email: "", role: r.role, password: "" })}><KeyRound size={16} /></button>
                  <button className="icon-btn" title="Sign out all sessions" disabled={!r.active_sessions} onClick={() => act(() => api(`/admin/users/${r.id}/revoke-sessions`, { method: "POST" }), "Sessions revoked")}><LogOut size={16} /></button>
                  <button className="btn small" disabled={r.id === user?.id} onClick={() => act(() => api(`/admin/users/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } }), r.enabled ? "User disabled" : "User enabled")}>
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="icon-btn danger" title="Delete" disabled={r.id === user?.id}
                    onClick={() => confirm(`Delete user ${r.username}? This cannot be undone.`) && act(() => api(`/admin/users/${r.id}`, { method: "DELETE" }), "User deleted")}>
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {form && (
        <Modal title={form.mode === "add" ? "Add user" : form.mode === "edit" ? `Edit ${form.username}` : `Reset password for ${form.username}`} onClose={() => setForm(null)}>
          <form className="form" onSubmit={submit}>
            {form.mode === "add" && <label>Username<input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9_.@\-]{3,64}" required autoFocus /></label>}
            {form.mode !== "reset" && (
              <>
                <label>Display name<input className="input" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
                <label>Email<input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                <label>Role<select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={form.row?.id === user?.id}>{ROLES.map((x) => <option key={x}>{x}</option>)}</select></label>
              </>
            )}
            {form.mode !== "edit" && (
              <label>{form.mode === "add" ? "Initial password" : "New password"} (12+ characters)
                <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} required autoComplete="new-password" />
              </label>
            )}
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
