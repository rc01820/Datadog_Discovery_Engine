import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, setUnauthorizedHandler, type AppStatus, type User } from "./api";

interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
}

export type ThemePref = "dark" | "light" | "system";

function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return pref;
}

interface AppCtx {
  theme: "dark" | "light";
  themePref: ThemePref;
  setThemePref: (t: ThemePref) => void;
  user: User | null;
  status: AppStatus | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  refreshStatus: () => void;
  can: (perm: string) => boolean;
  toast: (text: string, kind?: Toast["kind"]) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const [themePref, setThemePrefState] = useState<ThemePref>(() => (localStorage.getItem("dde-theme") as ThemePref) || "dark");
  const [theme, setTheme] = useState<"dark" | "light">(() => resolveTheme((localStorage.getItem("dde-theme") as ThemePref) || "dark"));
  const setThemePref = useCallback((t: ThemePref) => {
    localStorage.setItem("dde-theme", t);
    setThemePrefState(t);
  }, []);
  useEffect(() => {
    const apply = () => {
      const t = resolveTheme(themePref);
      setTheme(t);
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (themePref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themePref]);

  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);

  const refreshStatus = useCallback(() => {
    api<AppStatus>("/status").then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api<User>("/auth/me")
      .then((u) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshStatus();
    const t = setInterval(refreshStatus, 30000);
    return () => clearInterval(t);
  }, [user, refreshStatus]);

  const can = useCallback((perm: string) => !!user?.permissions.includes(perm), [user]);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <Ctx.Provider value={{ theme, themePref, setThemePref, user, status, loading, setUser, refreshStatus, can, toast, logout }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}
