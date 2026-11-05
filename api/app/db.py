"""PostgreSQL pool, schema migrations, Redis client and app-settings helpers."""
import json
import logging
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
import redis
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger("datadog-search.db")
MIGRATIONS = Path(__file__).parent / "migrations"

pool = ConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},
    open=False,
)
rds = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=5)


def open_pool(retries: int = 30) -> None:
    """Open the pool, waiting for PostgreSQL to accept connections."""
    for attempt in range(retries):
        try:
            with psycopg.connect(settings.database_url, connect_timeout=3):
                pass
            pool.open(wait=True, timeout=10)
            return
        except psycopg.OperationalError as exc:
            log.warning("database not ready (%s/%s): %s", attempt + 1, retries, exc)
            time.sleep(2)
    raise RuntimeError("database unavailable")


@contextmanager
def conn():
    with pool.connection() as c:
        yield c


def migrate() -> None:
    """Apply numbered SQL migrations exactly once, serialized by an advisory lock."""
    with conn() as c:
        c.execute("SELECT pg_advisory_lock(424242)")
        try:
            c.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
            c.commit()
            applied = {r["version"] for r in c.execute("SELECT version FROM schema_migrations")}
            for path in sorted(MIGRATIONS.glob("*.sql")):
                if path.stem in applied:
                    continue
                log.info("applying migration %s", path.name)
                with c.transaction():
                    c.execute(path.read_text())
                    c.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.stem,))
        finally:
            c.execute("SELECT pg_advisory_unlock(424242)")
            c.commit()


def wait_for_schema(timeout: int = 120) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with conn() as c:
                if c.execute("SELECT 1 FROM schema_migrations WHERE version='001_init'").fetchone():
                    return
        except psycopg.Error:
            pass
        time.sleep(2)
    raise RuntimeError("schema not ready")


def get_setting(key: str, default=None):
    with conn() as c:
        row = c.execute("SELECT value FROM app_settings WHERE key=%s", (key,)).fetchone()
    return row["value"] if row else default


def all_settings() -> dict:
    with conn() as c:
        return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM app_settings")}


def set_setting(key: str, value) -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO app_settings (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
            (key, Jsonb(value)),
        )


def bump_data_version() -> None:
    try:
        rds.incr("ds:data_version")
    except redis.RedisError:
        pass


def data_version() -> str:
    try:
        return rds.get("ds:data_version") or "0"
    except redis.RedisError:
        return str(time.time())


def audit(username: str, action: str, target: str = "", detail: dict | None = None, ip: str = "") -> None:
    with conn() as c:
        c.execute(
            "INSERT INTO audit_events (username, action, target, detail, ip) VALUES (%s,%s,%s,%s,%s)",
            (username, action, target, Jsonb(detail or {}), ip),
        )


def default_org_id(c) -> int:
    row = c.execute("SELECT id FROM organizations ORDER BY id LIMIT 1").fetchone()
    if row:
        return row["id"]
    return c.execute(
        "INSERT INTO organizations (name) VALUES (%s) RETURNING id", (settings.datadog_org,)
    ).fetchone()["id"]


def dumps(obj) -> str:
    return json.dumps(obj, default=str)
