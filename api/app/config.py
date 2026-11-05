"""Runtime configuration read from the environment (secrets are injected by compose)."""
import os
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _secret(name: str) -> str:
    """Read NAME, or the file at NAME_FILE (Docker secrets convention)."""
    path = os.environ.get(f"{name}_FILE")
    if path and os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    return os.environ.get(name, "").strip()


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    session_secret: str
    encryption_key: str
    admin_username: str
    admin_password: str
    cookie_secure: bool
    demo_data: bool
    datadog_site: str
    datadog_api_key: str
    datadog_app_key: str
    datadog_org: str


def load() -> Settings:
    return Settings(
        database_url=_secret("DATABASE_URL") or "postgresql://search:search@db:5432/search",
        redis_url=os.environ.get("REDIS_URL", "redis://redis:6379/0"),
        session_secret=_secret("SESSION_SECRET"),
        encryption_key=_secret("DATA_ENCRYPTION_KEY") or _secret("SESSION_SECRET"),
        admin_username=os.environ.get("ADMIN_USERNAME", "admin"),
        admin_password=_secret("ADMIN_PASSWORD"),
        cookie_secure=_bool("COOKIE_SECURE", False),
        demo_data=_bool("DEMO_DATA", True),
        datadog_site=os.environ.get("DATADOG_SITE", "datadoghq.com").strip() or "datadoghq.com",
        datadog_api_key=_secret("DATADOG_API_KEY"),
        datadog_app_key=_secret("DATADOG_APP_KEY"),
        datadog_org=os.environ.get("DATADOG_ORG", "default"),
    )


settings = load()
