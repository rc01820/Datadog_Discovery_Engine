import {
  Activity, Box, Boxes, Cloud, Container, Database, EthernetPort, Globe, LayoutDashboard, Layers, Network, Server, Ship, Tag as TagIcon,
  type LucideIcon,
} from "lucide-react";
import type { StatusGroup } from "./api";

export const TYPES = ["Host", "Device", "Interface", "Monitor", "Tag", "Service", "Synthetic", "Dashboard", "VMware", "Cloud",
  "Cluster", "Pod", "Container", "Database"] as const;
/** Types always shown as tiles/scopes; the others appear once inventory of that type exists. */
export const CORE_TYPES = new Set(["Host", "Device", "Monitor", "Tag", "Service", "Synthetic", "VMware", "Cloud"]);

export const TYPE_META: Record<string, { label: string; plural: string; icon: LucideIcon; color: string }> = {
  Host: { label: "Host", plural: "Hosts", icon: Server, color: "#60a5fa" },
  Device: { label: "Device", plural: "Devices", icon: Network, color: "#a78bfa" },
  Monitor: { label: "Monitor", plural: "Monitors", icon: Activity, color: "#e879f9" },
  Tag: { label: "Tag", plural: "Tags", icon: TagIcon, color: "#94a3b8" },
  Service: { label: "Service", plural: "Services", icon: Layers, color: "#34d399" },
  Synthetic: { label: "Synthetic", plural: "Synthetics", icon: Globe, color: "#38bdf8" },
  Dashboard: { label: "Dashboard", plural: "Dashboards", icon: LayoutDashboard, color: "#fbbf24" },
  VMware: { label: "VMware", plural: "VMware", icon: Box, color: "#c084fc" },
  Cloud: { label: "Cloud", plural: "Cloud", icon: Cloud, color: "#7dd3fc" },
  Interface: { label: "Interface", plural: "Interfaces", icon: EthernetPort, color: "#c4b5fd" },
  Cluster: { label: "Cluster", plural: "Clusters", icon: Ship, color: "#5eead4" },
  Pod: { label: "Pod", plural: "Pods", icon: Boxes, color: "#2dd4bf" },
  Container: { label: "Container", plural: "Containers", icon: Container, color: "#22d3ee" },
  Database: { label: "Database", plural: "Databases", icon: Database, color: "#f472b6" },
};

export const STATUS_LABEL: Record<StatusGroup, string> = {
  ok: "Up / OK", alert: "Alerting", warn: "Warning", muted: "Muted", unknown: "Unknown",
};

export function TypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const meta = TYPE_META[type] ?? TYPE_META.Host;
  const Icon = meta.icon;
  return <Icon size={size} color={meta.color} aria-hidden />;
}

export function StatusPill({ status, group }: { status: string; group: StatusGroup }) {
  return (
    <span className={`pill pill-${group}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 90) return "Now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
