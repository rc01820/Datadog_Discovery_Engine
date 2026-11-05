import { Check, Minus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useApp } from "../../context";

interface Role { name: string; description: string; permissions: string[]; users: number }

const CAPS: [string, string][] = [
  ["search", "Search permitted resources"],
  ["inspect", "Inspect details / deep links"],
  ["saved.personal", "Personal saved searches"],
  ["export", "Export data"],
  ["saved.shared", "Manage shared searches"],
  ["admin.users", "Manage users / roles"],
  ["admin.integrations", "Manage Datadog integration & API keys"],
  ["admin.settings", "Settings & system health"],
  ["admin.audit", "Audit access"],
];

export default function Roles() {
  const { toast } = useApp();
  const [roles, setRoles] = useState<Role[]>([]);
  const [viewerExport, setViewerExport] = useState(false);
  const load = () => api<{ roles: Role[]; viewer_can_export: boolean }>("/admin/roles").then((r) => { setRoles(r.roles); setViewerExport(r.viewer_can_export); });
  useEffect(() => { void load(); }, []);

  const toggleExport = async () => {
    try {
      await api("/admin/settings", { method: "PATCH", body: { viewer_can_export: !viewerExport } });
      setViewerExport(!viewerExport);
      toast(`Viewer export ${!viewerExport ? "enabled" : "disabled"}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head"><h1>Roles &amp; Permissions</h1></div>
      <section className="panel">
        <table className="data-table matrix">
          <thead>
            <tr><th>Capability</th>{roles.map((r) => <th key={r.name}>{r.name}<div className="muted small">{r.users} user{r.users === 1 ? "" : "s"}</div></th>)}</tr>
          </thead>
          <tbody>
            {CAPS.map(([perm, label]) => (
              <tr key={perm}>
                <td>{label}<div className="muted small mono">{perm}</div></td>
                {roles.map((r) => {
                  const has = r.permissions.includes(perm);
                  const configurable = r.name === "Viewer" && perm === "export";
                  return (
                    <td key={r.name} className="center">
                      {configurable ? (
                        <label className="check center"><input type="checkbox" checked={viewerExport} onChange={toggleExport} /> Configurable</label>
                      ) : has ? <Check size={18} className="ok-text" /> : <Minus size={18} className="muted" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Roles are enforced server-side on every search, detail, export and admin endpoint. Note: a shared Datadog API key does not inherit each
          user's own Datadog permissions — restrict access to this application accordingly.
        </p>
      </section>
    </div>
  );
}
