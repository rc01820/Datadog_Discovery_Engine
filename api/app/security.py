"""Passwords (Argon2id), sessions, CSRF, login throttling, RBAC and secret encryption."""
import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import redis
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException, Request

from . import db
from .config import settings

COOKIE = "ds_session"
CSRF_COOKIE = "ds_csrf"
CSRF_HEADER = "x-csrf-token"
_ph = PasswordHasher()  # Argon2id with library defaults
_DUMMY_HASH = _ph.hash(secrets.token_urlsafe(16))


# ---- passwords -------------------------------------------------------------
def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    try:
        return _ph.verify(hashed or _DUMMY_HASH, password) and hashed is not None
    except (VerificationError, InvalidHashError):
        return False


def validate_password(password: str) -> None:
    if len(password) < 12:
        raise HTTPException(400, "Password must be at least 12 characters")
    if len(password) > 256:
        raise HTTPException(400, "Password is too long")


# ---- secret encryption -----------------------------------------------------
def _fernet() -> Fernet:
    key = hashlib.sha256(("datadog-search:" + settings.encryption_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode() if value else ""


def decrypt(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        return ""


# ---- login throttling ------------------------------------------------------
MAX_FAILURES = 5
LOCK_SECONDS = 300


def _throttle_keys(username: str, ip: str) -> list[str]:
    return [f"ds:login_fail:u:{username.lower()}", f"ds:login_fail:ip:{ip}"]


def check_throttle(username: str, ip: str) -> None:
    try:
        for key in _throttle_keys(username, ip):
            count = int(db.rds.get(key) or 0)
            limit = MAX_FAILURES if ":u:" in key else MAX_FAILURES * 4
            if count >= limit:
                ttl = db.rds.ttl(key)
                raise HTTPException(429, f"Too many failed sign-in attempts. Try again in {max(ttl, 1)} seconds.")
    except redis.RedisError:
        pass


def record_failure(username: str, ip: str) -> None:
    try:
        for key in _throttle_keys(username, ip):
            pipe = db.rds.pipeline()
            pipe.incr(key)
            pipe.expire(key, LOCK_SECONDS)
            pipe.execute()
    except redis.RedisError:
        pass


def clear_failures(username: str, ip: str) -> None:
    try:
        db.rds.delete(*_throttle_keys(username, ip))
    except redis.RedisError:
        pass


# ---- sessions --------------------------------------------------------------
def _hash_token(token: str) -> str:
    return hmac.new(settings.session_secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def client_ip(request: Request) -> str:
    # nginx overwrites X-Real-IP with the connecting address, so it cannot be spoofed by clients.
    real = request.headers.get("x-real-ip", "")
    return (real.strip() or (request.client.host if request.client else ""))[:64]


def create_session(user_id: int, request: Request) -> tuple[str, str, int]:
    hours = int(db.get_setting("session_hours", 8) or 8)
    token = secrets.token_urlsafe(48)
    csrf = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=hours)
    with db.conn() as c:
        c.execute(
            "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, ip, user_agent) VALUES (%s,%s,%s,%s,%s,%s)",
            (_hash_token(token), user_id, csrf, expires, client_ip(request), request.headers.get("user-agent", "")[:200]),
        )
        c.execute("DELETE FROM sessions WHERE expires_at < now()")
    return token, csrf, hours * 3600


def destroy_session(token: str) -> None:
    with db.conn() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=%s", (_hash_token(token),))


def load_user(user_id: int) -> dict | None:
    with db.conn() as c:
        user = c.execute(
            "SELECT id, username, display_name, email, enabled, created_at, last_login FROM users WHERE id=%s", (user_id,)
        ).fetchone()
        if not user:
            return None
        rows = c.execute(
            "SELECT r.name, r.permissions FROM user_roles ur JOIN roles r ON r.name=ur.role WHERE ur.user_id=%s", (user_id,)
        ).fetchall()
    perms: set[str] = set()
    for r in rows:
        perms.update(r["permissions"])
    roles = [r["name"] for r in rows]
    if "Viewer" in roles and not perms.intersection({"export"}) and db.get_setting("viewer_can_export", False):
        perms.add("export")
    user["roles"] = roles
    user["role"] = next((r for r in ("Administrator", "Operator", "Viewer") if r in roles), "Viewer")
    user["permissions"] = sorted(perms)
    return user


def current_user(request: Request) -> dict:
    token = request.cookies.get(COOKIE, "")
    if not token:
        raise HTTPException(401, "Sign in required")
    with db.conn() as c:
        row = c.execute(
            "SELECT s.user_id, s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=%s AND s.expires_at > now() AND u.enabled",
            (_hash_token(token),),
        ).fetchone()
        if not row:
            raise HTTPException(401, "Session expired")
        c.execute("UPDATE sessions SET last_seen=now() WHERE token_hash=%s", (_hash_token(token),))
    # CSRF: every state-changing request must echo the per-session token in a header.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not hmac.compare_digest(sent, row["csrf_token"]):
            raise HTTPException(403, "CSRF validation failed")
    user = load_user(row["user_id"])
    if not user:
        raise HTTPException(401, "Session expired")
    user["ip"] = client_ip(request)
    return user


def require(permission: str):
    def dep(user: dict = Depends(current_user)) -> dict:
        if permission not in user["permissions"]:
            raise HTTPException(403, f"Permission '{permission}' required")
        return user

    return dep
