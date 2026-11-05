"""Administration: users, roles, settings, Datadog integration, sync jobs, audit and system health."""
import csv
import io
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .. import VERSION, datadog, db, demo, history, security, sync

router = APIRouter(prefix="/api/v1", tags=["admin"])
ROLES = ("Administrator", "Operator", "Viewer")


# ---- public status (any signed-in user) ---------------------------------------
@router.get("/status")
def status(user: dict = Depends(security.current_user)):
    conn = datadog.connection()
    with db.conn() as c:
        counts = c.execute("SELECT source, count(*) AS n FROM resources GROUP BY source").fetchall()
        last = c.execute("SELECT status, finished_at FROM sync_jobs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").fetchone()
    by_source = {r["source"]: r["n"] for r in counts}
    try:
        worker = bool(db.rds.exists("ds:worker_heartbeat"))
    except Exception:  # noqa: BLE001
        worker = False
    # Connected = keys configured and Datadog data present (or the scheduled sync is on); otherwise demo / not configured.
    connected = conn["configured"] and (conn["enabled"] or by_source.get("Datadog", 0) > 0)
    mode = "connected" if connected else "demo" if by_source.get("DEMO") else "not_configured"
    return {
        "mode": mode, "site": conn["site"], "site_label": datadog.site_label(conn["site"]), "org": conn["org_name"],
        "last_sync": last["finished_at"] if last else None, "last_sync_status": last["status"] if last else None,
        "resources": by_source, "worker": worker, "version": VERSION,
    }


# ---- users ---------------------------------------------------------------------
class UserIn(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.@-]{3,64}$")
    password: str
    role: str = "Viewer"
    display_name: str = Field("", max_length=120)
    email: str = Field("", max_length=200)


class UserPatch(BaseModel):
    role: str | None = None
    enabled: bool | None = None
    display_name: str | None = Field(None, max_length=120)
    email: str | None = Field(None, max_length=200)
    password: str | None = None


@router.get("/admin/users")
def list_users(user: dict = Depends(security.require("admin.users"))):
    with db.conn() as c:
        return c.execute(
            """SELECT u.id, u.username, u.display_name, u.email, u.enabled, u.created_at, u.last_login,
                      COALESCE((SELECT min(role) FROM user_roles WHERE user_id=u.id), 'Viewer') AS role,
                      (SELECT count(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at > now()) AS active_sessions
               FROM users u ORDER BY lower(u.username)""").fetchall()


@router.post("/admin/users")
def create_user(body: UserIn, user: dict = Depends(security.require("admin.users"))):
    if body.role not in ROLES:
        raise HTTPException(400, "Invalid role")
    security.validate_password(body.password)
    with db.conn() as c:
        if c.execute("SELECT 1 FROM users WHERE lower(username)=lower(%s)", (body.username,)).fetchone():
            raise HTTPException(409, "User already exists")
        uid = c.execute("INSERT INTO users (username, display_name, email, password_hash) VALUES (%s,%s,%s,%s) RETURNING id",
                        (body.username, body.display_name, body.email, security.hash_password(body.password))).fetchone()["id"]
        c.execute("INSERT INTO user_roles (user_id, role) VALUES (%s,%s)", (uid, body.role))
    db.audit(user["username"], "user.create", body.username, {"role": body.role}, user["ip"])
    return {"id": uid}


def _admin_count(c, excluding: int | None = None) -> int:
    return c.execute("""SELECT count(*) AS n FROM users u JOIN user_roles r ON r.user_id=u.id
                        WHERE r.role='Administrator' AND u.enabled AND u.id <> COALESCE(%s, -1)""", (excluding,)).fetchone()["n"]


@router.patch("/admin/users/{uid}")
def update_user(uid: int, body: UserPatch, user: dict = Depends(security.require("admin.users"))):
    with db.conn() as c, c.transaction():
        target = c.execute("SELECT id, username FROM users WHERE id=%s", (uid,)).fetchone()
        if not target:
            raise HTTPException(404, "User not found")
        demoting = (body.role and body.role != "Administrator") or body.enabled is False
        if demoting and _admin_count(c, excluding=uid) == 0:
            raise HTTPException(400, "At least one enabled administrator must remain")
        if uid == user["id"] and demoting:
            raise HTTPException(400, "You cannot remove your own administrator access")
        if body.role:
            if body.role not in ROLES:
                raise HTTPException(400, "Invalid role")
            c.execute("DELETE FROM user_roles WHERE user_id=%s", (uid,))
            c.execute("INSERT INTO user_roles (user_id, role) VALUES (%s,%s)", (uid, body.role))
        if body.enabled is not None:
            c.execute("UPDATE users SET enabled=%s WHERE id=%s", (body.enabled, uid))
            if not body.enabled:
                c.execute("DELETE FROM sessions WHERE user_id=%s", (uid,))
        if body.display_name is not None:
            c.execute("UPDATE users SET display_name=%s WHERE id=%s", (body.display_name, uid))
        if body.email is not None:
            c.execute("UPDATE users SET email=%s WHERE id=%s", (body.email, uid))
        if body.password:
            security.validate_password(body.password)
            c.execute("UPDATE users SET password_hash=%s WHERE id=%s", (security.hash_password(body.password), uid))
            c.execute("DELETE FROM sessions WHERE user_id=%s", (uid,))
    changes = body.model_dump(exclude_none=True)
    if "password" in changes:
        changes["password"] = "reset"
    db.audit(user["username"], "user.update", target["username"], changes, user["ip"])
    return {"ok": True}


@router.delete("/admin/users/{uid}")
def delete_user(uid: int, user: dict = Depends(security.require("admin.users"))):
    if uid == user["id"]:
        raise HTTPException(400, "You cannot delete your own account")
    with db.conn() as c:
        target = c.execute("SELECT username FROM users WHERE id=%s", (uid,)).fetchone()
        if not target:
            raise HTTPException(404, "User not found")
        if _admin_count(c, excluding=uid) == 0:
            raise HTTPException(400, "At least one enabled administrator must remain")
        c.execute("DELETE FROM users WHERE id=%s", (uid,))
    db.audit(user["username"], "user.delete", target["username"], ip=user["ip"])
    return {"ok": True}


@router.post("/admin/users/{uid}/revoke-sessions")
def revoke(uid: int, user: dict = Depends(security.require("admin.users"))):
    with db.conn() as c:
        n = c.execute("DELETE FROM sessions WHERE user_id=%s", (uid,)).rowcount
    db.audit(user["username"], "user.revoke_sessions", str(uid), {"sessions": n}, user["ip"])
    return {"revoked": n}


@router.get("/admin/roles")
def roles(user: dict = Depends(security.require("admin.users"))):
    with db.conn() as c:
        rows = c.execute("""SELECT r.name, r.description, r.permissions, (SELECT count(*) FROM user_roles ur WHERE ur.role=r.name) AS users
                            FROM roles r ORDER BY array_length(r.permissions,1) DESC""").fetchall()
    return {"roles": rows, "viewer_can_export": bool(db.get_setting("viewer_can_export", False))}


# ---- settings --------------------------------------------------------------------
class SettingsPatch(BaseModel):
    viewer_can_export: bool | None = None
    auto_purge_demo: bool | None = None
    history_retention_days: int | None = Field(None, ge=0, le=36500)            # 0 = keep forever
    ephemeral_history_retention_days: int | None = Field(None, ge=0, le=36500)  # 0 = keep forever
    history_archive_enabled: bool | None = None
    track_ephemeral_changes: bool | None = None
    session_hours: int | None = Field(None, ge=1, le=72)
    required_tags: list[str] | None = None
    stale_after_hours: int | None = Field(None, ge=1, le=24 * 90)
    audit_retention_days: int | None = Field(None, ge=7, le=3650)
    default_page_size: int | None = Field(None, ge=10, le=100)


@router.get("/admin/settings")
def get_settings(user: dict = Depends(security.require("admin.settings"))):
    return db.all_settings()


@router.patch("/admin/settings")
def patch_settings(body: SettingsPatch, user: dict = Depends(security.require("admin.settings"))):
    data = body.model_dump(exclude_none=True)
    if "required_tags" in data:
        tags = [t.strip().lower() for t in data["required_tags"] if t.strip()]
        if any(not re.fullmatch(r"[a-z][\w.\-/]{0,60}", t) for t in tags):
            raise HTTPException(400, "Tag keys must be simple identifiers")
        data["required_tags"] = tags
    for k, v in data.items():
        db.set_setting(k, v)
    db.audit(user["username"], "settings.update", "", data, user["ip"])
    return db.all_settings()


# ---- Datadog integration ------------------------------------------------------------
class IntegrationPatch(BaseModel):
    org_name: str | None = Field(None, min_length=1, max_length=100)
    site: str | None = None
    api_key: str | None = Field(None, max_length=200)
    app_key: str | None = Field(None, max_length=200)
    enabled: bool | None = None
    sync_interval_minutes: int | None = Field(None, ge=5, le=1440)
    sources: list[str] | None = None


def _mask(v: str) -> str:
    return ("•" * 8 + v[-4:]) if v else ""


@router.get("/admin/integrations")
def integrations(user: dict = Depends(security.require("admin.integrations"))):
    conn = datadog.connection()
    with db.conn() as c:
        sources = c.execute("SELECT * FROM source_status WHERE org_id=%s ORDER BY source", (conn["org_id"],)).fetchall()
        type_counts = c.execute(
            """SELECT CASE WHEN type='Tag' THEN 'tags' ELSE collector END AS collector, type, count(*) AS n
               FROM resources WHERE org_id=%s AND source='Datadog' GROUP BY 1, 2""", (conn["org_id"],)).fetchall()
    per_source: dict[str, dict[str, int]] = {}
    for r in type_counts:
        per_source.setdefault(r["collector"] or "", {})[r["type"]] = r["n"]
    return {
        "org_name": conn["org_name"], "site": conn["site"], "site_label": datadog.site_label(conn["site"]),
        "sites": [{"value": k, "label": f"{v[0]} ({k})"} for k, v in datadog.SITES.items()],
        "api_key": _mask(conn["api_key"]), "app_key": _mask(conn["app_key"]), "configured": conn["configured"],
        "env_keys": conn["env_keys"], "enabled": conn["enabled"], "sync_interval_minutes": conn["sync_interval_minutes"],
        "sources": conn["sources"], "available_sources": [s["key"] for s in datadog.SOURCE_CATALOG], "source_status": sources,
        "catalog": datadog.SOURCE_CATALOG, "type_counts": per_source,
    }


@router.patch("/admin/integrations")
def patch_integration(body: IntegrationPatch, user: dict = Depends(security.require("admin.integrations"))):
    if body.site and body.site not in datadog.SITES:
        raise HTTPException(400, "Unsupported Datadog site")
    if body.sources is not None and any(s not in datadog.CATALOG_KEYS for s in body.sources):
        raise HTTPException(400, "Unknown source")
    with db.conn() as c, c.transaction():
        org_id = db.default_org_id(c)
        if body.org_name:
            c.execute("UPDATE organizations SET name=%s WHERE id=%s", (body.org_name, org_id))
        cur = c.execute("SELECT * FROM datadog_connections WHERE org_id=%s", (org_id,)).fetchone()
        if not cur:
            c.execute("INSERT INTO datadog_connections (org_id, site) VALUES (%s,%s)", (org_id, datadog.connection(org_id)["site"]))
        fields = {}
        if body.site:
            fields["site"] = body.site
        if body.api_key:
            fields["api_key_enc"] = security.encrypt(body.api_key.strip())
        if body.app_key:
            fields["app_key_enc"] = security.encrypt(body.app_key.strip())
        for k in ("enabled", "sync_interval_minutes", "sources"):
            if getattr(body, k) is not None:
                fields[k] = getattr(body, k)
        if fields:
            sets = ", ".join(f"{k}=%s" for k in fields)
            c.execute(f"UPDATE datadog_connections SET {sets}, updated_at=now() WHERE org_id=%s", (*fields.values(), org_id))
    detail = {k: ("updated" if k in ("api_key", "app_key") else v) for k, v in body.model_dump(exclude_none=True).items()}
    db.audit(user["username"], "integration.update", "datadog", detail, user["ip"])
    return integrations(user)


@router.post("/admin/integrations/test")
def test_integration(user: dict = Depends(security.require("admin.integrations"))):
    conn = datadog.connection()
    if not conn["configured"]:
        raise HTTPException(400, "Enter an API key and application key first")
    with datadog.Client(conn, timeout=15) as client:
        result = client.validate()
    db.audit(user["username"], "integration.test", "datadog", {"api_key": result["api_key"], "app_key": result["app_key"]}, user["ip"])
    return result


@router.post("/admin/sync-jobs")
def start_sync(user: dict = Depends(security.require("admin.integrations"))):
    if not datadog.connection()["configured"]:
        raise HTTPException(400, "Configure Datadog API and application keys first")
    job_id = sync.enqueue("manual", user["username"])
    db.audit(user["username"], "sync.requested", f"job {job_id}", ip=user["ip"])
    return {"job_id": job_id}


@router.get("/admin/sync-jobs")
def sync_jobs(user: dict = Depends(security.require("admin.integrations"))):
    with db.conn() as c:
        jobs = c.execute("SELECT * FROM sync_jobs ORDER BY id DESC LIMIT 25").fetchall()
        errs = c.execute("SELECT * FROM sync_errors WHERE job_id = ANY(%s) ORDER BY id", ([j["id"] for j in jobs],)).fetchall()
    for j in jobs:
        j["errors"] = [e for e in errs if e["job_id"] == j["id"]]
    return jobs


class DemoAction(BaseModel):
    action: str = Field(pattern="^(seed|purge)$")


@router.post("/admin/demo")
def demo_data(body: DemoAction, user: dict = Depends(security.require("admin.integrations"))):
    n = demo.seed(force=True) if body.action == "seed" else demo.purge()
    db.audit(user["username"], f"demo.{body.action}", "", {"records": n}, user["ip"])
    return {"records": n}


# ---- audit -------------------------------------------------------------------------
@router.get("/admin/audit")
def audit_log(kind: str = Query("events", pattern="^(events|searches)$"), q: str = Query("", max_length=100),
              page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500), format: str = "json",
              user: dict = Depends(security.require("admin.audit"))):
    like = f"%{q.lower()}%"
    with db.conn() as c:
        if kind == "events":
            sql = """SELECT id, at, username, action, target, detail, ip, count(*) OVER() AS total FROM audit_events
                     WHERE lower(username || ' ' || action || ' ' || target) LIKE %s ORDER BY id DESC LIMIT %s OFFSET %s"""
        else:
            sql = """SELECT id, at, username, query, scope, result_count, took_ms, count(*) OVER() AS total FROM search_audit
                     WHERE lower(username || ' ' || query) LIKE %s ORDER BY id DESC LIMIT %s OFFSET %s"""
        limit = 10000 if format == "csv" else page_size
        rows = c.execute(sql, (like, limit, 0 if format == "csv" else (page - 1) * page_size)).fetchall()
    total = rows[0]["total"] if rows else 0
    for r in rows:
        r.pop("total", None)
    if format == "csv":
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow({k: (("'" + str(v)) if str(v)[:1] in "=+-@" else v) for k, v in r.items()})
        db.audit(user["username"], "audit.export", kind, {"rows": len(rows)}, user["ip"])
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="audit-{kind}.csv"'})
    return {"rows": rows, "total": total, "page": page, "page_size": page_size}


# ---- health -------------------------------------------------------------------------
@router.get("/admin/health")
def health(user: dict = Depends(security.require("admin.settings"))):
    out = {"version": VERSION, "time": datetime.now(timezone.utc)}
    try:
        with db.conn() as c:
            out["database"] = {"ok": True, "version": c.execute("SHOW server_version").fetchone()["server_version"],
                               "size": c.execute("SELECT pg_size_pretty(pg_database_size(current_database())) AS s").fetchone()["s"],
                               "resources": c.execute("SELECT count(*) AS n FROM resources").fetchone()["n"],
                               "users": c.execute("SELECT count(*) AS n FROM users").fetchone()["n"],
                               "active_sessions": c.execute("SELECT count(*) AS n FROM sessions WHERE expires_at > now()").fetchone()["n"]}
    except Exception as e:  # noqa: BLE001
        out["database"] = {"ok": False, "error": str(e)[:200]}
    try:
        info = db.rds.info("server")
        hb = db.rds.get("ds:worker_heartbeat")
        out["redis"] = {"ok": True, "version": info.get("redis_version"), "queue_depth": db.rds.llen("ds:jobs")}
        out["worker"] = {"ok": bool(hb), "last_heartbeat": hb, "next_scheduled": db.rds.get("ds:next_scheduled_sync")}
    except Exception as e:  # noqa: BLE001
        out["redis"] = {"ok": False, "error": str(e)[:200]}
        out["worker"] = {"ok": False}
    conn = datadog.connection()
    out["datadog"] = {"configured": conn["configured"], "enabled": conn["enabled"], "site": conn["site"]}
    return out


# ---- change-history retention ----------------------------------------------------------
@router.get("/admin/history")
def history_usage(user: dict = Depends(security.require("admin.settings"))):
    """Entry counts, size, oldest entry, what the next roll-off would delete, last roll-off, archive status."""
    return history.usage()


@router.post("/admin/history/purge")
def history_purge(user: dict = Depends(security.require("admin.settings"))):
    """Apply the saved retention settings immediately (archiving first when enabled)."""
    try:
        return history.purge("manual", user["username"])
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from None


@router.get("/admin/history/archives")
def history_archives(user: dict = Depends(security.require("admin.settings"))):
    return {"dir": str(history.ARCHIVE_DIR), "archives": history.list_archives()}


@router.get("/admin/history/archives/{name}")
def history_archive_download(name: str, user: dict = Depends(security.require("admin.settings"))):
    path = history.archive_path(name)
    if not path:
        raise HTTPException(404, "Archive not found")
    db.audit(user["username"], "history.archive_download", name, ip=user["ip"])
    return FileResponse(path, media_type="application/gzip", filename=name)
