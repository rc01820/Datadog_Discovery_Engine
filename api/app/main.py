"""Datadog Search API entrypoint."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import VERSION, db, demo, security
from .config import settings
from .routes import admin, auth, bulk, changes, personal, reports, resources, search

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("datadog-search")


def bootstrap() -> None:
    if len(settings.session_secret) < 32:
        raise RuntimeError("SESSION_SECRET must be at least 32 characters")
    db.open_pool()
    db.migrate()
    with db.conn() as c, c.transaction():
        c.execute("SELECT pg_advisory_xact_lock(424243)")  # several API workers boot concurrently
        db.default_org_id(c)
        if not c.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            if len(settings.admin_password) < 12:
                raise RuntimeError("ADMIN_PASSWORD must be at least 12 characters to create the first administrator")
            uid = c.execute("INSERT INTO users (username, display_name, password_hash) VALUES (%s,%s,%s) RETURNING id",
                            (settings.admin_username, "Administrator", security.hash_password(settings.admin_password))).fetchone()["id"]
            c.execute("INSERT INTO user_roles (user_id, role) VALUES (%s,'Administrator')", (uid,))
            log.info("created initial administrator '%s'", settings.admin_username)
    db.audit("system", "startup", VERSION)
    with db.conn() as c:
        has_real = c.execute("SELECT 1 FROM resources WHERE source='Datadog' LIMIT 1").fetchone()
    if settings.demo_data and not (has_real and db.get_setting("auto_purge_demo", True)):
        n = demo.seed()
        if n:
            log.info("seeded %s DEMO records", n)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    bootstrap()
    yield
    db.pool.close()


app = FastAPI(title="Datadog Discovery Engine API", version=VERSION, lifespan=lifespan, docs_url="/api/docs", redoc_url=None,
              openapi_url="/api/openapi.json")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/docs"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:])
    return JSONResponse({"detail": f"{field}: {first.get('msg', 'invalid value')}" if field else "Invalid request"}, status_code=422)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/readyz")
def readyz():
    try:
        with db.conn() as c:
            c.execute("SELECT 1")
        db.rds.ping()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=503)


for r in (auth, search, resources, personal, reports, admin, changes, bulk):
    app.include_router(r.router)
