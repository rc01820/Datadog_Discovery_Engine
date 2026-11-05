import { Download, Link2, Maximize, Search as SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import Inspector from "../components/Inspector";
import TopologyGraph, { REL, relationCounts, type TopoData, type TopologyHandle } from "../components/TopologyGraph";
import { useApp } from "../context";
import { copy, cx, TypeIcon } from "../util";

export default function Topology() {
  const { id } = useParams();
  const rid = Number(id);
  const [sp, setSp] = useSearchParams();
  const hops = sp.get("hops") === "2" ? 2 : 1;
  const nav = useNavigate();
  const { toast } = useApp();
  const [data, setData] = useState<TopoData | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const graph = useRef<TopologyHandle>(null);

  useEffect(() => {
    setData(null);
    setError("");
    setSelected(null);
    api<TopoData>(`/resources/${rid}/topology`, { params: { hops } }).then(setData).catch((e) => setError(e.message));
  }, [rid, hops]);

  const recenter = (target: number) => nav(`/topology/${target}${hops === 2 ? "?hops=2" : ""}`);
  const toggle = (rel: string) => setHidden((h) => { const n = new Set(h); if (n.has(rel)) n.delete(rel); else n.add(rel); return n; });

  if (error) return <div className="page"><div className="panel empty">{error}</div></div>;
  if (!data) return <div className="page"><div className="panel empty">Building topology…</div></div>;
  const c = data.center_detail;
  const counts = relationCounts(data);

  return (
    <div className={cx("topo-page", selected !== null && "with-inspector")}>
      <div className="page-head">
        <div className="row gap">
          <TypeIcon type={c.type} size={26} />
          <div>
            <h1>Topology: {c.name}</h1>
            <div className="muted small">{c.type}{c.ips[0] ? ` · ${c.ips[0]}` : ""} · {data.nodes.length - 1} related · {hops} hop{hops === 2 ? "s" : ""}{data.truncated && " · large graph trimmed"}</div>
          </div>
        </div>
        <div className="row gap">
          <div className="seg" role="group" aria-label="Hops">
            {[1, 2].map((h) => (
              <button key={h} className={cx(hops === h && "active")} onClick={() => setSp(h === 2 ? { hops: "2" } : {})} aria-pressed={hops === h}>{h} hop{h === 2 ? "s" : ""}</button>
            ))}
          </div>
          <button className="btn small" onClick={() => graph.current?.fit()} title="Reset zoom and pan"><Maximize size={14} /> Fit</button>
          <button className="btn small" onClick={() => graph.current?.exportPng()}><Download size={14} /> PNG</button>
          <button className="btn small" onClick={() => graph.current?.exportSvg()}><Download size={14} /> SVG</button>
          <button className="btn small" onClick={() => { copy(location.href); toast("Link copied"); }}><Link2 size={14} /> Copy link</button>
          <Link className="btn small" to={`/search?q=${encodeURIComponent(`name:"${c.name}"`)}&sel=${data.center}`}><SearchIcon size={14} /> Open in Search</Link>
        </div>
      </div>

      <div className="topo-layers">
        {counts.map(([rel, n]) => (
          <button key={rel} className={cx("topo-chip", !hidden.has(rel) && "on")} onClick={() => toggle(rel)} aria-pressed={!hidden.has(rel)}>
            <span className="topo-swatch" style={{ borderTopColor: (REL[rel] ?? { color: "#8b93a7" }).color, borderTopStyle: REL[rel]?.dashed ? "dashed" : "solid" }} />
            {(REL[rel] ?? { label: rel }).label}{n ? ` (${n})` : ""}
          </button>
        ))}
        <span className="muted small topo-hint">Click a node to inspect · double-click to recenter · scroll to zoom · drag to pan · groups over 12 collapse to “+N more”</span>
      </div>

      <div className="topo-body">
        <div className="panel topo-canvas">
          {data.nodes.length === 1 ? (
            <div className="empty">No relationships found for this resource yet. Relationships come from monitor scopes, hosts, pods, clusters, interfaces, shared <code>app:</code> tags and shared IPs.</div>
          ) : (
            <TopologyGraph ref={graph} data={data} height="calc(100vh - 250px)" hidden={hidden} selected={selected}
              onSelect={(n) => setSelected(n === selected ? null : n)} onRecenter={recenter} />
          )}
        </div>
        {selected !== null && (
          <Inspector id={selected} onClose={() => setSelected(null)}
            onAddTerm={(t) => nav(`/search?q=${encodeURIComponent(t)}`)} onSelect={(n) => setSelected(n)} />
        )}
      </div>
    </div>
  );
}
