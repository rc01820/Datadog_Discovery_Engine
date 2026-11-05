import { useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { fmtTime } from "../util";

export default function Account() {
  const { user, toast } = useApp();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirmPw) return toast("New passwords do not match", "error");
    try {
      await api("/auth/password", { method: "POST", body: { current_password: cur, new_password: next } });
      toast("Password changed; other sessions were signed out");
      setCur(""); setNext(""); setConfirmPw("");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head"><h1>Account</h1></div>
      <section className="panel">
        <table className="kv-table">
          <tbody>
            <tr><td className="muted">Username</td><td>{user?.username}</td></tr>
            <tr><td className="muted">Role</td><td>{user?.role}</td></tr>
            <tr><td className="muted">Permissions</td><td>{user?.permissions.join(", ")}</td></tr>
            <tr><td className="muted">Last sign-in</td><td>{fmtTime(user?.last_login)}</td></tr>
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Change password</h2>
        <form className="form" onSubmit={submit}>
          <label>Current password<input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></label>
          <label>New password (12+ characters)<input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={12} autoComplete="new-password" required /></label>
          <label>Confirm new password<input className="input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} minLength={12} autoComplete="new-password" required /></label>
          <div className="form-actions"><button className="btn-primary">Change password</button></div>
        </form>
      </section>
    </div>
  );
}
