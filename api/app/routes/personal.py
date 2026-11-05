"""Saved searches, favorites and search history."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db, query, security
from .search import SUMMARY_COLS, _stale_cutoff, summarize

router = APIRouter(prefix="/api/v1", tags=["personal"])


class SavedIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    query: str = Field(max_length=500)
    scope: str = Field("All", max_length=20)
    description: str = Field("", max_length=500)
    shared: bool = False


class SavedPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    query: str | None = Field(None, max_length=500)
    scope: str | None = Field(None, max_length=20)
    description: str | None = Field(None, max_length=500)
    shared: bool | None = None


def _validate(q: str) -> None:
    try:
        query.parse(q)
    except query.QueryError as e:
        raise HTTPException(400, str(e)) from None


@router.get("/saved-searches")
def list_saved(user: dict = Depends(security.require("saved.personal"))):
    with db.conn() as c:
        rows = c.execute(
            """SELECT s.*, u.username AS owner, (s.owner_id=%s) AS mine,
                      EXISTS (SELECT 1 FROM favorites f WHERE f.user_id=%s AND f.kind='query' AND f.ref=s.query) AS favorite
               FROM saved_searches s JOIN users u ON u.id=s.owner_id
               WHERE s.owner_id=%s OR s.shared ORDER BY s.shared, lower(s.name)""",
            (user["id"], user["id"], user["id"]),
        ).fetchall()
    return rows


@router.post("/saved-searches")
def create_saved(body: SavedIn, user: dict = Depends(security.require("saved.personal"))):
    _validate(body.query)
    if body.shared and "saved.shared" not in user["permissions"]:
        raise HTTPException(403, "Your role cannot create shared searches")
    with db.conn() as c:
        row = c.execute(
            "INSERT INTO saved_searches (owner_id, name, query, scope, description, shared) VALUES (%s,%s,%s,%s,%s,%s) RETURNING *",
            (user["id"], body.name, body.query, body.scope, body.description, body.shared),
        ).fetchone()
    db.audit(user["username"], "saved_search.create", body.name, {"shared": body.shared}, user["ip"])
    return row


def _editable(c, sid: int, user: dict) -> dict:
    row = c.execute("SELECT * FROM saved_searches WHERE id=%s", (sid,)).fetchone()
    if not row:
        raise HTTPException(404, "Saved search not found")
    if row["owner_id"] != user["id"] and not (row["shared"] and "saved.shared" in user["permissions"]):
        raise HTTPException(403, "You cannot modify this saved search")
    return row


@router.patch("/saved-searches/{sid}")
def update_saved(sid: int, body: SavedPatch, user: dict = Depends(security.require("saved.personal"))):
    data = body.model_dump(exclude_none=True)
    if "query" in data:
        _validate(data["query"])
    if data.get("shared") and "saved.shared" not in user["permissions"]:
        raise HTTPException(403, "Your role cannot share searches")
    with db.conn() as c:
        _editable(c, sid, user)
        if data:
            sets = ", ".join(f"{k}=%s" for k in data)
            c.execute(f"UPDATE saved_searches SET {sets}, updated_at=now() WHERE id=%s", (*data.values(), sid))
        row = c.execute("SELECT * FROM saved_searches WHERE id=%s", (sid,)).fetchone()
    db.audit(user["username"], "saved_search.update", row["name"], data, user["ip"])
    return row


@router.delete("/saved-searches/{sid}")
def delete_saved(sid: int, user: dict = Depends(security.require("saved.personal"))):
    with db.conn() as c:
        row = _editable(c, sid, user)
        c.execute("DELETE FROM saved_searches WHERE id=%s", (sid,))
    db.audit(user["username"], "saved_search.delete", row["name"], ip=user["ip"])
    return {"ok": True}


@router.post("/saved-searches/{sid}/run")
def run_saved(sid: int, user: dict = Depends(security.require("saved.personal"))):
    with db.conn() as c:
        row = c.execute("UPDATE saved_searches SET run_count=run_count+1, last_run_at=now() WHERE id=%s AND (owner_id=%s OR shared) RETURNING *",
                        (sid, user["id"])).fetchone()
    if not row:
        raise HTTPException(404, "Saved search not found")
    return row


# ---- favorites ---------------------------------------------------------------
class FavoriteIn(BaseModel):
    kind: str = Field(pattern="^(resource|query)$")
    ref: str = Field(min_length=1, max_length=500)
    label: str = Field("", max_length=200)


@router.get("/favorites")
def list_favorites(user: dict = Depends(security.require("search"))):
    cutoff = _stale_cutoff()
    with db.conn() as c:
        favs = c.execute("SELECT * FROM favorites WHERE user_id=%s ORDER BY created_at DESC", (user["id"],)).fetchall()
        ids = [int(f["ref"]) for f in favs if f["kind"] == "resource" and f["ref"].isdigit()]
        res = {r["id"]: summarize(r, cutoff) for r in c.execute(f"SELECT {SUMMARY_COLS} FROM resources r WHERE r.id = ANY(%s)", (ids,))}
    return {
        "resources": [{**f, "resource": res.get(int(f["ref"]))} for f in favs if f["kind"] == "resource"],
        "queries": [f for f in favs if f["kind"] == "query"],
    }


@router.put("/favorites")
def add_favorite(body: FavoriteIn, user: dict = Depends(security.require("search"))):
    if body.kind == "query":
        _validate(body.ref)
    with db.conn() as c:
        c.execute("INSERT INTO favorites (user_id, kind, ref, label) VALUES (%s,%s,%s,%s) ON CONFLICT (user_id, kind, ref) DO UPDATE SET label=EXCLUDED.label",
                  (user["id"], body.kind, body.ref, body.label))
    return {"ok": True}


@router.delete("/favorites")
def remove_favorite(kind: str, ref: str, user: dict = Depends(security.require("search"))):
    with db.conn() as c:
        c.execute("DELETE FROM favorites WHERE user_id=%s AND kind=%s AND ref=%s", (user["id"], kind, ref))
    return {"ok": True}


# ---- history -----------------------------------------------------------------
@router.get("/history")
def history(user: dict = Depends(security.require("search"))):
    with db.conn() as c:
        return c.execute(
            """SELECT query, scope, max(at) AS last_run, count(*) AS runs, (array_agg(result_count ORDER BY at DESC))[1] AS last_count,
                      round(avg(took_ms)) AS avg_ms
               FROM search_audit WHERE user_id=%s GROUP BY query, scope ORDER BY max(at) DESC LIMIT 100""",
            (user["id"],),
        ).fetchall()


@router.delete("/history")
def clear_history(user: dict = Depends(security.require("search"))):
    # The organization-wide search audit is retained; this only hides the entries from the user's own history view.
    with db.conn() as c:
        c.execute("UPDATE search_audit SET user_id=NULL WHERE user_id=%s", (user["id"],))
    db.audit(user["username"], "history.clear", ip=user["ip"])
    return {"ok": True}
