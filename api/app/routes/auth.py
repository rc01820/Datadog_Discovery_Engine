from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import db, security
from ..config import settings

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


def _public(user: dict) -> dict:
    return {k: user[k] for k in ("id", "username", "display_name", "email", "role", "roles", "permissions", "last_login")}


@router.post("/login")
def login(body: LoginIn, request: Request):
    ip = security.client_ip(request)
    security.check_throttle(body.username, ip)
    with db.conn() as c:
        row = c.execute("SELECT id, password_hash, enabled FROM users WHERE lower(username)=lower(%s)", (body.username,)).fetchone()
    ok = security.verify_password(body.password, row["password_hash"] if row else None)
    if not row or not ok or not row["enabled"]:
        security.record_failure(body.username, ip)
        db.audit(body.username[:64], "auth.login_failed", ip=ip)
        raise HTTPException(401, "Invalid username or password")
    security.clear_failures(body.username, ip)
    token, csrf, max_age = security.create_session(row["id"], request)
    with db.conn() as c:
        c.execute("UPDATE users SET last_login=now() WHERE id=%s", (row["id"],))
    user = security.load_user(row["id"])
    db.audit(user["username"], "auth.login", ip=ip)
    res = JSONResponse(jsonable_encoder({"user": _public(user), "csrf": csrf}))
    res.set_cookie(security.COOKIE, token, httponly=True, samesite="strict", secure=settings.cookie_secure, max_age=max_age, path="/")
    res.set_cookie(security.CSRF_COOKIE, csrf, httponly=False, samesite="strict", secure=settings.cookie_secure, max_age=max_age, path="/")
    return res


@router.post("/logout")
def logout(request: Request, user: dict = Depends(security.current_user)):
    security.destroy_session(request.cookies.get(security.COOKIE, ""))
    db.audit(user["username"], "auth.logout", ip=user["ip"])
    res = JSONResponse({"ok": True})
    res.delete_cookie(security.COOKIE, path="/")
    res.delete_cookie(security.CSRF_COOKIE, path="/")
    return res


@router.get("/me")
def me(user: dict = Depends(security.current_user)):
    return _public(user)


@router.post("/password")
def change_password(body: PasswordIn, request: Request, user: dict = Depends(security.current_user)):
    with db.conn() as c:
        row = c.execute("SELECT password_hash FROM users WHERE id=%s", (user["id"],)).fetchone()
    if not security.verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(400, "Current password is incorrect")
    security.validate_password(body.new_password)
    token_hash = security._hash_token(request.cookies.get(security.COOKIE, ""))
    with db.conn() as c:
        c.execute("UPDATE users SET password_hash=%s WHERE id=%s", (security.hash_password(body.new_password), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id=%s AND token_hash<>%s", (user["id"], token_hash))
    db.audit(user["username"], "auth.password_changed", ip=user["ip"])
    return {"ok": True}
