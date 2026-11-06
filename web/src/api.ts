export type StatusGroup = "ok" | "alert" | "warn" | "muted" | "unknown";

export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: string;
  roles: string[];
  permissions: string[];
  last_login: string | null;
}

export interface Resource {
  id: number;
  type: string;
  name: string;
  status: string;
  status_group: StatusGroup;
  ips: string[];
  tags: string[];
  aliases: string[];
  matched_alias?: string | null;
  env: string;
  os: string;
  vendor: string;
  model: string;
  source: string;
  external_id: string;
  deep_link: string;
  agent_version: string;
  last_observed: string | null;
  last_indexed: string;
  stale: boolean;
}

export interface ResourceDetail extends Resource {
  attributes: Record<string, unknown>;
  created_at: string | null;
  first_indexed: string;
  org_name: string;
  monitor_type: string | null;
  monitor_query: string | null;
  monitor_message: string | null;
  muted: boolean | null;
  favorite: boolean;
  freshness: { mode: string; label: string; last_indexed: string; last_observed: string | null; inferred_type: boolean };
  links: Record<string, string>;
  scope_monitor_count: number;
  tag_policy: TagPolicy;
}

export interface Related extends Resource {
  relation: string;
  evidence: string;
}

export interface Facet {
  value: string;
  count: number;
}

export interface SearchResponse {
  results: Resource[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  type_counts: Record<string, number>;
  facets: { status: Record<StatusGroup, number>; env: Facet[]; tags: Facet[] };
  query: { raw: string; normalized: string; terms: number };
  took_ms: number;
  cached: boolean;
}

export interface AppStatus {
  mode: "connected" | "demo" | "not_configured";
  site: string;
  site_label: string;
  org: string;
  last_sync: string | null;
  last_sync_status: string | null;
  resources: Record<string, number>;
  worker: boolean;
  version: string;
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  scope: string;
  description: string;
  shared: boolean;
  owner: string;
  mine: boolean;
  favorite: boolean;
  run_count: number;
  last_run_at: string | null;
  updated_at: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)ds_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

type Params = Record<string, string | number | boolean | string[] | number[] | undefined | null>;

export function qs(params: Params): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; params?: Params } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
  const res = await fetch(`/api/v1${path}${opts.params ? qs(opts.params) : ""}`, {
    method,
    headers,
    credentials: "same-origin",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export function download(path: string, params: Params) {
  const a = document.createElement("a");
  a.href = `/api/v1${path}${qs(params)}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface PolicyFinding {
  severity: "error" | "warning" | "info"; category: string; tier: string; tag_key: string; tag_value: string;
  suggestion: string; auto_fixable: boolean; message: string; waived: boolean;
}
export interface BlindSpot { monitor_id: number; monitor_name: string; expected_tag: string; actual_tag: string; evidence: string }
/** Tag Enforcer's verdict for one resource (absent fields when not evaluated). */
export interface TagPolicy {
  available: boolean;
  evaluated: boolean;
  imported_at?: string | null;
  te_scan_id?: number;
  compliant?: boolean;
  error_count?: number;
  warning_count?: number;
  remediable?: boolean;
  teams?: string[];
  issues?: string[];
  findings?: PolicyFinding[];
  blind_spots?: BlindSpot[];
  link?: string;
}
