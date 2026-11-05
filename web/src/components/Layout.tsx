import {
  BarChart3, Bookmark, CircleHelp, GitCompareArrows, ListChecks, ChevronDown, ChevronUp, ClipboardList, Cog, Database, HeartPulse, History, Home, KeyRound,
  LogOut, Monitor as MonitorIcon, Moon, Search, ShieldCheck, Star, Sun, UserCircle2, Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../context";
import { cx, fmtTime } from "../util";
import MeshMountain from "./MeshMountain";
import ShortcutsHelp from "./ShortcutsHelp";

export function Logo({ withText = false, size = 40 }: { withText?: boolean; size?: number }) {
  return (
    <div className={cx("logo", !withText && "icon-only")} role="img" aria-label="Datadog Discovery Engine">
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <circle cx="27" cy="27" r="15" fill="none" stroke="url(#lg)" strokeWidth="6" />
        <path d="M38 38l15 15" stroke="url(#lg)" strokeWidth="7" strokeLinecap="round" />
        <path d="M19 30l5-7 5 5 6-9" fill="none" style={{ stroke: "var(--logo-line)" }} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {withText && (
        <div className="logo-text">
          <span>DATADOG</span>
          <small>DISCOVERY ENGINE</small>
        </div>
      )}
    </div>
  );
}

function StatusBlock() {
  const { status } = useApp();
  if (!status) return null;
  const label =
    status.mode === "connected" ? `Connected to Datadog (${status.site_label})`
      : status.mode === "demo" ? "Demo mode · synthetic data" : "Datadog not configured";
  return (
    <div className="conn">
      <span className={cx("conn-dot", status.mode === "connected" ? "ok" : status.mode === "demo" ? "demo" : "off")} />
      <div>
        <div className="conn-title">{label}</div>
        <div className="muted small">org: {status.org}</div>
        <div className="muted small">Last Sync: {status.last_sync ? fmtTime(status.last_sync) : "never"}{!status.worker && " · worker offline"}</div>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const { theme, setThemePref } = useApp();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button className="icon-btn theme-btn" onClick={() => setThemePref(next)} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}>
      {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}

function UserMenu() {
  const { user, logout, themePref, setThemePref } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  if (!user) return null;
  return (
    <div className="usermenu" ref={ref}>
      <button className="usermenu-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <UserCircle2 size={38} strokeWidth={1.4} />
        <div className="usermenu-name">
          <strong>{user.username}</strong>
          <span className="muted">{user.role}</span>
        </div>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); nav("/account"); }}><KeyRound size={15} /> Account &amp; password</button>
          <div className="menu-sep" />
          <div className="menu-label">Theme</div>
          {([["dark", Moon, "Dark"], ["light", Sun, "Light"], ["system", MonitorIcon, "Match system"]] as const).map(([v, Icon, label]) => (
            <button key={v} role="menuitemradio" aria-checked={themePref === v} className={cx(themePref === v && "on")} onClick={() => setThemePref(v)}>
              <Icon size={15} /> {label}
            </button>
          ))}
          <div className="menu-sep" />
          <button role="menuitem" onClick={() => void logout()}><LogOut size={15} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { can, status } = useApp();
  const loc = useLocation();
  const [adminOpen, setAdminOpen] = useState(true);
  const [help, setHelp] = useState(false);
  const isAdmin = can("admin.users") || can("admin.settings") || can("admin.integrations") || can("admin.audit");

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "?") setHelp(true);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const link = (to: string, Icon: typeof Home, label: string, sub = false) => (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => cx("nav", sub && "sub", isActive && "active")}>
      <Icon size={sub ? 16 : 20} strokeWidth={1.7} />
      <span>{label}</span>
    </NavLink>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <Logo size={48} />
        <div className="title">
          <h1>Datadog <span className="accent">Discovery Engine</span></h1>
          <p>Unified Search for Hosts, Devices, Monitors, Tags, and More</p>
        </div>
        <MeshMountain className="mesh" />
        <div className="topbar-right">
          <StatusBlock />
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <aside className="sidebar">
        <nav>
          {link("/", Home, "Home")}
          {link("/search", Search, "Search")}
          {link("/bulk", ListChecks, "Bulk Lookup")}
          {link("/saved", Bookmark, "Saved Searches")}
          {link("/favorites", Star, "Favorites")}
          {link("/history", History, "History")}
          {link("/changes", GitCompareArrows, "What Changed")}
          {link("/reports", BarChart3, "Reports")}
          {link("/help", CircleHelp, "Search Help")}
          {isAdmin && (
            <>
              <button className={cx("nav", "nav-group", loc.pathname.startsWith("/admin") && "within")} onClick={() => setAdminOpen(!adminOpen)} aria-expanded={adminOpen}>
                <Cog size={20} strokeWidth={1.7} />
                <span>Admin</span>
                {adminOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {adminOpen && (
                <div className="subnav">
                  {can("admin.users") && link("/admin/users", Users, "Users", true)}
                  {can("admin.users") && link("/admin/roles", ShieldCheck, "Roles", true)}
                  {can("admin.settings") && link("/admin/settings", Cog, "Settings", true)}
                  {can("admin.integrations") && link("/admin/datadog", Database, "Datadog Config", true)}
                  {can("admin.audit") && link("/admin/audit", ClipboardList, "Audit Log", true)}
                  {can("admin.settings") && link("/admin/health", HeartPulse, "System Health", true)}
                </div>
              )}
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="integration">
            <svg viewBox="0 0 48 48" width="34" height="34" aria-hidden>
              <rect x="4" y="4" width="40" height="40" rx="10" fill="#632ca6" />
              <path d="M14 30l6-8 5 5 9-12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <strong>DATADOG</strong>
              <span>Integration</span>
            </div>
          </div>
          <button className="linklike small" onClick={() => setHelp(true)}>Keyboard shortcuts (?)</button>
          <div className="muted small">v{status?.version ?? "1.0.0"} (Docker)</div>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
