import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import { useApp } from "./context";
import Account from "./pages/Account";
import BulkLookup from "./pages/BulkLookup";
import Changes from "./pages/Changes";
import Favorites from "./pages/Favorites";
import History from "./pages/History";
import Help from "./pages/Help";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Reports from "./pages/Reports";
import SavedSearches from "./pages/SavedSearches";
import Search from "./pages/Search";
import AuditLog from "./pages/admin/AuditLog";
import DatadogConfig from "./pages/admin/DatadogConfig";
import Health from "./pages/admin/Health";
import Roles from "./pages/admin/Roles";
import Settings from "./pages/admin/Settings";
import Users from "./pages/admin/Users";

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useApp();
  return can(perm) ? <>{children}</> : <div className="panel empty">You do not have permission to view this page.</div>;
}

export default function App() {
  const { user, loading } = useApp();
  if (loading) return <div className="boot">Loading Datadog Discovery Engine…</div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="bulk" element={<BulkLookup />} />
        <Route path="saved" element={<SavedSearches />} />
        <Route path="favorites" element={<Favorites />} />
        <Route path="history" element={<History />} />
        <Route path="changes" element={<Changes />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:key" element={<Reports />} />
        <Route path="help" element={<Help />} />
        <Route path="account" element={<Account />} />
        <Route path="admin/users" element={<Guard perm="admin.users"><Users /></Guard>} />
        <Route path="admin/roles" element={<Guard perm="admin.users"><Roles /></Guard>} />
        <Route path="admin/settings" element={<Guard perm="admin.settings"><Settings /></Guard>} />
        <Route path="admin/datadog" element={<Guard perm="admin.integrations"><DatadogConfig /></Guard>} />
        <Route path="admin/audit" element={<Guard perm="admin.audit"><AuditLog /></Guard>} />
        <Route path="admin/health" element={<Guard perm="admin.settings"><Health /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
