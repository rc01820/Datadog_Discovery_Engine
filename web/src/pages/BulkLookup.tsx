import { ClipboardCopy, Download, FileUp, ListChecks, Search as SearchIcon, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type StatusGroup } from "../api";
import { useApp } from "../context";
import { copy, cx, fmtTime, relTime, StatusPill, TypeIcon } from "../util";

type Result = "found" | "multiple" | "not_found" | "removed";

interface Match { id: number; type: string; name: string; status: string; status_group: StatusGroup; ips: string[]; source: string; deep_link: string; matched_on: string }
interface Row { input: string; kind: string; result: Result; matches: Match[]; truncated: boolean; previously: { at: string; type: string; name: string; summary: string } | null }
interface Resp { items: number; summary: Record<Result, number>; took_ms: number; results: Row[] }

const RESULT_LABEL: Record<Result, string> = { found: "Found", multiple: "Multiple matches", not_found: "Not found", removed: "Previously seen" };
const KIND_LABEL: Record<string, string> = { ip: "IP", cidr: "CIDR", instance_id: "Instance ID", mac: "MAC", container_id: "Container ID", hostname: "Name" };
const STORE = "dde-bulk-input";
const EXAMPLE = `# Paste anything: one per line, or separated by commas, spaces or semicolons
10.10.50.21
10.10.50.40
eoc-app-xyz-01
eoc-web-01.corp.example.com
i-0a1b2c3d4e5f6g7h8
ip-10-10-50-22.ec2.internal
10.10.51.0/24
old-host-that-was-removed
not-a-real-host-99`;

function parseCount(text: string): number {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;|]+/)) {
    const t = raw.trim().replace(/^["'`[(<]+|["'`\])>]+$/g, "").replace(/\.$/, "");
    if (t && !t.startsWith("#")) seen.add(t.toLowerCase());
  }
  return seen.size;
}

export default function BulkLookup() {
  const { can, toast } = useApp();
  const nav = useNavigate();
  const [text, setText] = useState(() => sessionStorage.getItem(STORE) ?? "");
  const [shortNames, setShortNames] = useState(true);
  const [includeTags, setIncludeTags] = useState(false);
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Result | "">("");
  const file = useRef<HTMLInputElement>(null);
  const count = useMemo(() => parseCount(text), [text]);

  const update = (t: string) => {
    setText(t);
    sessionStorage.setItem(STORE, t);
    setError("");
  };

  const run = async () => {
    if (!count) { setError("Paste at least one IP, hostname or ID first."); return; }
    setBusy(true);
    setError("");
    try {
      const r = await api<Resp>("/bulk-lookup", { method: "POST", body: { text, short_names: shortNames, include_tags: includeTags } });
      setData(r);
      setFilter("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      const csv = await api<string>("/bulk-lookup", { method: "POST", body: { text, short_names: shortNames, include_tags: includeTags, format: "csv" } });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `bulk-lookup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 1_000_000) { toast("File is larger than 1 MB", "error"); return; }
    f.text().then((t) => { update(t); toast(`Loaded ${f.name}`); });
  };

  const rows = (data?.results ?? []).filter((r) => !filter || r.result === filter);
  const notFound = (data?.results ?? []).filter((r) => r.result === "not_found" || r.result === "removed").map((r) => r.input);
  const foundNames = [...new Set((data?.results ?? []).flatMap((r) => r.matches.map((m) => m.name)))];

  const openInSearch = () => {
    const names = foundNames.slice(0, 30);
    nav(`/search?q=${encodeURIComponent(names.map((n) => `name:"${n}"`).join(" OR "))}`);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1><ListChecks size={22} style={{ verticalAlign: -3 }} /> Bulk Lookup</h1>
        <span className="muted">Paste IPs, hostnames, FQDNs, AWS instance IDs, MAC addresses, container IDs or CIDR ranges. Up to 2,000 at once.</span>
      </div>

      <section className="panel bulk-input">
        <textarea
          className="input mono"
          rows={10}
          value={text}
          onChange={(e) => update(e.target.value)}
          placeholder={"10.10.50.21\neoc-app-xyz-01\ni-0a1b2c3d4e5f6g7h8\n…"}
          aria-label="Items to look up"
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run(); }}
        />
        <div className="bulk-controls">
          <span className="muted small">{count} unique item{count === 1 ? "" : "s"} detected</span>
          <label className="check small"><input type="checkbox" checked={shortNames} onChange={(e) => setShortNames(e.target.checked)} /> Match short names (web01 ↔ web01.corp.example.com)</label>
          <label className="check small"><input type="checkbox" checked={includeTags} onChange={(e) => setIncludeTags(e.target.checked)} /> Include Tag entities</label>
          <span className="grow" />
          <input ref={file} type="file" accept=".txt,.csv,.log,text/plain,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="btn small" onClick={() => file.current?.click()}><FileUp size={14} /> Load file</button>
          <button className="btn small" onClick={() => update(EXAMPLE)}>Load example</button>
          <button className="btn small" onClick={() => { update(""); setData(null); }} disabled={!text}><X size={14} /> Clear</button>
          <button className="btn-primary" onClick={run} disabled={busy}><SearchIcon size={16} /> {busy ? "Looking up…" : "Look up"}</button>
        </div>
        {error && <div className="error-box" role="alert">{error}</div>}
        <p className="muted small">
          Each item is matched exactly (case-insensitive) against names, aliases (AWS instance ID, EC2/RDS DNS, AWS Name tag, MAC, container ID) and
          Datadog IDs. IPs match any address of a resource, and CIDR ranges match every IP inside them. Items that no longer exist are checked against
          the change history. Tip: <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> runs the lookup.
        </p>
      </section>

      {data && (
        <>
          <div className="bulk-tiles">
            <button className={cx("change-tile panel", !filter && "active")} onClick={() => setFilter("")}>
              <strong>{data.items}</strong><span>All items</span>
            </button>
            {(Object.keys(RESULT_LABEL) as Result[]).map((k) => (
              <button key={k} className={cx("change-tile panel", `bt-${k}`, filter === k && "active")} onClick={() => setFilter(filter === k ? "" : k)} aria-pressed={filter === k}>
                <strong>{data.summary[k]}</strong><span>{RESULT_LABEL[k]}</span>
              </button>
            ))}
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>{rows.length} of {data.items} items {filter && `· ${RESULT_LABEL[filter]}`} <span className="muted small">({data.took_ms} ms)</span></h2>
              <div className="row gap">
                <button className="btn small" disabled={!notFound.length} onClick={() => { copy(notFound.join("\n")); toast(`Copied ${notFound.length} items`); }}>
                  <ClipboardCopy size={14} /> Copy not found ({notFound.length})
                </button>
                <button className="btn small" disabled={!foundNames.length} onClick={openInSearch} title={foundNames.length > 30 ? "Opens the first 30 matches" : undefined}>
                  <SearchIcon size={14} /> Open matches in Search{foundNames.length > 30 ? " (first 30)" : ""}
                </button>
                {can("export") && <button className="btn small" onClick={exportCsv}><Download size={14} /> Export CSV</button>}
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table bulk-table">
                <thead><tr><th>#</th><th>Input</th><th>Kind</th><th>Result</th><th>Matches</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.input} className={`br-${r.result}`}>
                      <td className="muted small">{data.results.indexOf(r) + 1}</td>
                      <td className="mono">{r.input}</td>
                      <td><span className="badge">{KIND_LABEL[r.kind] ?? r.kind}</span></td>
                      <td><span className={`res res-${r.result}`}>{RESULT_LABEL[r.result]}{r.matches.length > 1 && ` (${r.matches.length}${r.truncated ? "+" : ""})`}</span></td>
                      <td>
                        {r.matches.map((m) => (
                          <div key={m.id} className="bulk-match">
                            <TypeIcon type={m.type} />
                            <Link to={`/search?q=${encodeURIComponent(`name:"${m.name}"`)}&sel=${m.id}`}>{m.name}</Link>
                            <span className="muted small">{m.type}</span>
                            <StatusPill status={m.status} group={m.status_group} />
                            <span className="badge" title="Which field matched">{m.matched_on}</span>
                            {m.ips[0] && <span className="mono small muted">{m.ips[0]}{m.ips.length > 1 ? ` +${m.ips.length - 1}` : ""}</span>}
                          </div>
                        ))}
                        {r.previously && (
                          <div className="small">
                            <span className="chg chg-removed">removed</span> <b>{r.previously.name}</b> ({r.previously.type}) {relTime(r.previously.at)}
                            <span className="muted"> · {fmtTime(r.previously.at)} · {r.previously.summary}</span>{" "}
                            <Link to={`/changes?period=2160&q=${encodeURIComponent(r.input)}`}>history →</Link>
                          </div>
                        )}
                        {r.result === "not_found" && <span className="muted small">No current or past resource matches{r.kind === "hostname" && shortNames ? ", including short names" : ""}.</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
