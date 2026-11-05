import { useState } from "react";
import { api, type User } from "../api";
import { Logo } from "../components/Layout";
import { useApp } from "../context";

export default function Login() {
  const { setUser } = useApp();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: User }>("/auth/login", { method: "POST", body: { username, password } });
      setUser(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login panel" onSubmit={submit}>
        <Logo withText />
        <h1>Sign in to Datadog <span className="accent">Discovery Engine</span></h1>
        <p className="muted">Unified search for hosts, devices, monitors, tags and more.</p>
        <label>Username<input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required /></label>
        <label>Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="error-box" role="alert">{error}</div>}
        <button className="btn-primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted small">Authorized use only. Activity is audited.</p>
      </form>
    </div>
  );
}
