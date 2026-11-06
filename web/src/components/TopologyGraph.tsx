import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useApp } from "../context";
import { TYPE_META } from "../util";

/* ------------------------------------------------------------------ types */
export interface TopoNode { id: number; type: string; name: string; status: string; status_group: string; ip: string | null; source: string; deep_link: string; stale: boolean; hop: number; tag_compliant?: boolean; blind_spots?: number }
export interface TopoEdge { source: number; target: number; relation: string; evidence: string }
export interface TopoData { center: number; hops: number; nodes: TopoNode[]; edges: TopoEdge[]; truncated: boolean; center_detail: { name: string; type: string; ips: string[]; tags: string[] } }

/** Outline for resources that fail Tag Enforcer's policy (solid when a monitor misses them because of it). */
export const POLICY_COLOR = "#f97316";

export interface TopologyHandle { exportSvg: () => void; exportPng: () => void; fit: () => void }

/* Relation groups: label, colour (mid-tones readable on both themes), dashed edge. */
export const REL: Record<string, { label: string; color: string; dashed?: boolean }> = {
  monitor: { label: "Monitors", color: "#e8735a" },
  synthetic: { label: "Synthetics", color: "#e8735a" },
  backed_by: { label: "Backed by monitor", color: "#e8735a" },
  application: { label: "Same app", color: "#22a883" },
  same_ip: { label: "Shares IP", color: "#d9962b", dashed: true },
  workloads: { label: "Runs here", color: "#4f8ff7" },
  containers: { label: "Containers", color: "#4f8ff7" },
  members: { label: "Members", color: "#4f8ff7" },
  interfaces: { label: "Interfaces", color: "#4f8ff7" },
  child: { label: "Children", color: "#4f8ff7" },
  scoped_to: { label: "Scoped to", color: "#8b7bff" },
  runs_on: { label: "Runs on", color: "#8b7bff" },
  runs_in: { label: "Runs in pod", color: "#8b7bff" },
  member_of: { label: "Member of", color: "#8b7bff" },
  interface_of: { label: "Interface of", color: "#8b7bff" },
};
const relInfo = (r: string) => REL[r] ?? { label: r, color: "#8b93a7" };
const STATUS_COLOR: Record<string, string> = { ok: "#22c55e", alert: "#ef4444", warn: "#f5b015", muted: "#8b93a7", unknown: "#6b7280" };
export const COLLAPSE_AT = 12;

interface LNode { key: string; id: number | null; node?: TopoNode; more?: { group: string; count: number }; x: number; y: number; hop: number; relation: string; evidence: string; parentKey: string | null }
interface LEdge { a: string; b: string; relation: string; evidence: string }
interface Props {
  data: TopoData;
  height: number | string;
  hidden?: Set<string>;
  selected?: number | null;
  onSelect?: (id: number) => void;
  onRecenter?: (id: number) => void;
  compact?: boolean;
}

/* ------------------------------------------------------------------ layout */
function buildGraph(data: TopoData, expanded: Set<string>, hidden: Set<string>) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const center = byId.get(data.center)!;
  const nodes = new Map<string, LNode>();
  const edges: LEdge[] = [];
  nodes.set(`n${center.id}`, { key: `n${center.id}`, id: center.id, node: center, x: 0, y: 0, hop: 0, relation: "", evidence: "", parentKey: null });

  // group edges by parent and relation; first-hop parent is the centre
  const childrenOf = new Map<string, { parent: number; relation: string; items: { node: TopoNode; evidence: string }[] }>();
  for (const e of data.edges) {
    if (hidden.has(e.relation)) continue;
    const [parent, child] = byId.get(e.source)!.hop <= byId.get(e.target)!.hop ? [e.source, e.target] : [e.target, e.source];
    const childNode = byId.get(child);
    if (!childNode) continue;
    const gk = `${parent}|${e.relation}`;
    if (!childrenOf.has(gk)) childrenOf.set(gk, { parent, relation: e.relation, items: [] });
    childrenOf.get(gk)!.items.push({ node: childNode, evidence: e.evidence });
  }
  // place hop-1 groups first so hop-2 groups can attach to visible parents
  const groups = [...childrenOf.entries()].sort((a, b) => (byId.get(a[1].parent)!.hop - byId.get(b[1].parent)!.hop));
  for (const [gk, g] of groups) {
    const parentKey = `n${g.parent}`;
    if (!nodes.has(parentKey)) continue; // parent itself collapsed or hidden
    const collapse = g.items.length > COLLAPSE_AT && !expanded.has(gk);
    const shown = collapse ? g.items.slice(0, COLLAPSE_AT - 1) : g.items;
    for (const it of shown) {
      const k = `n${it.node.id}`;
      if (!nodes.has(k)) nodes.set(k, { key: k, id: it.node.id, node: it.node, x: 0, y: 0, hop: it.node.hop, relation: g.relation, evidence: it.evidence, parentKey });
      edges.push({ a: parentKey, b: k, relation: g.relation, evidence: it.evidence });
    }
    if (collapse) {
      const k = `more:${gk}`;
      nodes.set(k, { key: k, id: null, more: { group: gk, count: g.items.length - shown.length }, x: 0, y: 0, hop: byId.get(g.parent)!.hop + 1, relation: g.relation, evidence: "", parentKey });
      edges.push({ a: parentKey, b: k, relation: g.relation, evidence: "" });
    }
  }
  return { nodes, edges };
}

function ringLayout(nodes: Map<string, LNode>) {
  const first = [...nodes.values()].filter((n) => n.hop === 1);
  const groups = new Map<string, LNode[]>();
  first.forEach((n) => { if (!groups.has(n.relation)) groups.set(n.relation, []); groups.get(n.relation)!.push(n); });
  const total = first.length || 1;
  // radius grows with the node count so neighbouring labels (≈150px wide) don't touch
  const r = Math.max(200, total * 26);
  const gap = groups.size > 1 ? 0.22 : 0;
  const usable = Math.PI * 2 - gap * groups.size;
  // each group gets a share proportional to its size (min 0.45 rad), then shares are normalised to fit the circle
  const raw = [...groups.values()].map((items) => Math.max(items.length / total, 0.45 / usable));
  const sum = raw.reduce((a, b) => a + b, 0);
  let angle = -Math.PI / 2 - (usable * (raw[0] / sum)) / 2; // centre the largest group's sector on the top
  [...groups.values()].forEach((items, gi) => {
    const span = usable * (raw[gi] / sum);
    items.forEach((n, i) => {
      const a = angle + (span * (i + 0.5)) / items.length;
      n.x = Math.cos(a) * r * 1.5;
      n.y = Math.sin(a) * r * 0.95;
    });
    angle += span + gap;
  });
}

function forceLayout(nodes: Map<string, LNode>, edges: LEdge[]) {
  ringLayout(nodes); // good starting positions for hop 1
  type SN = SimulationNodeDatum & { key: string; hop: number };
  const sim: SN[] = [...nodes.values()].map((n) => {
    const parent = n.parentKey ? nodes.get(n.parentKey) : null;
    const jitter = () => (Math.random() - 0.5) * 40;
    return { key: n.key, hop: n.hop, x: n.hop === 2 && parent ? parent.x * 1.5 + jitter() : n.x, y: n.hop === 2 && parent ? parent.y * 1.5 + jitter() : n.y,
      fx: n.hop === 0 ? 0 : undefined, fy: n.hop === 0 ? 0 : undefined };
  });
  const idx = new Map(sim.map((s) => [s.key, s]));
  const links = edges.map((e) => ({ source: idx.get(e.a)!, target: idx.get(e.b)! }));
  forceSimulation(sim)
    .force("link", forceLink(links).distance((l) => ((l.target as SN).hop === 2 ? 110 : 220)).strength(0.6))
    .force("charge", forceManyBody().strength(-420))
    .force("collide", forceCollide<SN>((d) => (d.hop === 0 ? 120 : d.hop === 2 ? 70 : 84)).strength(1).iterations(2))
    .force("x", forceX(0).strength(0.03))
    .force("y", forceY(0).strength(0.05))
    .stop()
    .tick(320);
  sim.forEach((s) => { const n = nodes.get(s.key)!; n.x = s.x ?? 0; n.y = s.y ?? 0; });
}

/* ------------------------------------------------------------------ component */
function cssVar(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const TopologyGraph = forwardRef<TopologyHandle, Props>(function TopologyGraph({ data, height, hidden, selected, onSelect, onRecenter, compact }, ref) {
  const { theme } = useApp();
  const svgRef = useRef<SVGSVGElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const hiddenKey = [...(hidden ?? [])].sort().join(",");

  useEffect(() => { setExpanded(new Set()); setView({ x: 0, y: 0, k: 1 }); }, [data.center, data.hops]);

  const palette = useMemo(() => ({
    bg: cssVar("--panel-solid", "#0f162e"), text: cssVar("--text", "#e6eaf6"), muted: cssVar("--muted", "#8c97b8"),
    border: cssVar("--border-2", "#2d3d6e"), accent: cssVar("--accent-2", "#a78bfa"),
  }), [theme]);  // eslint-disable-line react-hooks/exhaustive-deps

  const graph = useMemo(() => {
    const g = buildGraph(data, expanded, hidden ?? new Set());
    if (data.hops === 2) forceLayout(g.nodes, g.edges);
    else ringLayout(g.nodes);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    g.nodes.forEach((n) => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
    const pad = 110;
    return { ...g, box: { x: minX - pad, y: minY - 60, w: maxX - minX + pad * 2, h: maxY - minY + 120 } };
  }, [data, expanded, hiddenKey]);  // eslint-disable-line react-hooks/exhaustive-deps

  const download = useCallback((blob: Blob, ext: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `topology-${data.center_detail.name.replace(/[^\w.-]+/g, "_")}-${data.hops}hop.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [data]);

  const serialize = useCallback(() => {
    const svg = svgRef.current!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.querySelector("[data-viewport]")?.setAttribute("transform", "");
    return new XMLSerializer().serializeToString(svg);
  }, []);

  useImperativeHandle(ref, () => ({
    fit: () => setView({ x: 0, y: 0, k: 1 }),
    exportSvg: () => download(new Blob([serialize()], { type: "image/svg+xml" }), "svg"),
    exportPng: () => {
      const { w, h } = graph.box;
      const scale = 2;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = palette.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => b && download(b, "png"), "image/png");
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(serialize());
    },
  }), [download, serialize, graph.box, palette.bg]);

  const onWheel = (e: React.WheelEvent) => {
    if (compact && !e.ctrlKey && !e.metaKey) return; // let the inspector scroll
    e.preventDefault();
    const k = Math.min(4, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setView({ ...view, k });
  };
  const onDown = (e: React.MouseEvent) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current || !svgRef.current) return;
    const ratio = graph.box.w / svgRef.current.clientWidth / view.k;
    setView({ ...view, x: drag.current.vx + (e.clientX - drag.current.x) * ratio, y: drag.current.vy + (e.clientY - drag.current.y) * ratio });
  };

  const { box } = graph;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const font = "Inter, 'Segoe UI', system-ui, -apple-system, sans-serif";

  return (
    <svg
      ref={svgRef}
      className="topo-svg"
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      width="100%"
      height={height}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Topology graph for ${data.center_detail.name}`}
      onWheel={onWheel}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
      style={{ fontFamily: font, cursor: drag.current ? "grabbing" : "grab" }}
    >
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={palette.bg} />
      <g data-viewport transform={`translate(${cx} ${cy}) scale(${view.k}) translate(${-cx + view.x} ${-cy + view.y})`}>
        {graph.edges.map((e, i) => {
          const a = graph.nodes.get(e.a)!, b = graph.nodes.get(e.b)!;
          const info = relInfo(e.relation);
          const active = selected != null && (a.id === selected || b.id === selected);
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={info.color} strokeWidth={active ? 2.2 : 1.2}
              strokeOpacity={active ? 0.95 : 0.5} strokeDasharray={info.dashed ? "5 4" : undefined}>
              <title>{`${info.label}${e.evidence ? `: ${e.evidence}` : ""}`}</title>
            </line>
          );
        })}
        {[...graph.nodes.values()].map((n) => {
          const info = relInfo(n.relation);
          if (n.more) {
            const w = 118, h = 30;
            return (
              <g key={n.key} data-node transform={`translate(${n.x} ${n.y})`} style={{ cursor: "pointer" }}
                onClick={() => setExpanded((s) => new Set(s).add(n.more!.group))}>
                <title>{`Show ${n.more.count} more (${info.label})`}</title>
                <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={15} fill={palette.bg} stroke={info.color} strokeDasharray="4 3" />
                <text x={0} y={4} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={info.color}>+{n.more.count} more</text>
              </g>
            );
          }
          const node = n.node!;
          const center = n.hop === 0;
          const w = center ? 210 : n.hop === 2 ? 132 : 150;
          const h = center ? 48 : n.hop === 2 ? 28 : 32;
          const meta = TYPE_META[node.type] ?? TYPE_META.Host;
          const Icon = meta.icon;
          const isSel = selected === node.id;
          return (
            <g key={n.key} data-node transform={`translate(${n.x} ${n.y})`} style={{ cursor: "pointer" }}
              onClick={() => onSelect?.(node.id)} onDoubleClick={() => onRecenter?.(node.id)}>
              <title>{`${node.name}\n${node.type} · ${node.status}${node.ip ? ` · ${node.ip}` : ""}${node.tag_compliant === false ? `\nFails tag policy${node.blind_spots ? ` · missed by ${node.blind_spots} monitor(s)` : ""}` : ""}${n.evidence ? `\n${info.label}: ${n.evidence}` : ""}\nClick to inspect · double-click to recenter`}</title>
              {node.tag_compliant === false && (
                <rect x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} rx={11} fill="none"
                  stroke={POLICY_COLOR} strokeWidth={1.6} strokeDasharray={node.blind_spots ? undefined : "3 3"} data-policy="fail" />
              )}
              <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={8} fill={palette.bg}
                stroke={center ? palette.accent : isSel ? palette.text : info.color} strokeWidth={center || isSel ? 2.2 : 1.1}
                strokeOpacity={n.hop === 2 && !isSel ? 0.7 : 1} />
              <circle cx={-w / 2 + 10} cy={center ? -8 : 0} r={4} fill={STATUS_COLOR[node.status_group] ?? STATUS_COLOR.unknown} />
              <Icon x={-w / 2 + 18} y={center ? -16 : -7} width={center ? 16 : 14} height={center ? 16 : 14} color={meta.color} />
              <text x={-w / 2 + (center ? 39 : 36)} y={center ? -3 : 4} fontSize={center ? 14 : n.hop === 2 ? 11 : 12} fontWeight={center ? 700 : 500} fill={palette.text}>
                {truncate(node.name, center ? 22 : n.hop === 2 ? 15 : 17)}
              </text>
              {center && (
                <text x={-w / 2 + 39} y={14} fontSize={11.5} fill={palette.muted}>
                  {truncate(`${node.type}${node.ip ? ` · ${node.ip}` : ""}`, 30)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
});

export default TopologyGraph;

/** Relation groups present around the centre, with counts (for legends / layer toggles). */
export function relationCounts(data: TopoData): [string, number][] {
  const m = new Map<string, number>();
  for (const e of data.edges) if (e.source === data.center || e.target === data.center) m.set(e.relation, (m.get(e.relation) ?? 0) + 1);
  for (const e of data.edges) if (!(e.source === data.center || e.target === data.center) && !m.has(e.relation)) m.set(e.relation, 0);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
