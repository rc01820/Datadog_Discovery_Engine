"""Tag Enforcer verdicts, as Discovery understands them. Pure functions, no I/O.

Tag Enforcer decides whether a resource is tagged correctly. Discovery knows
what the resource is connected to: in particular, which monitors are scoped
by tag. Put together, they answer a question neither can alone:

    "web-prod-02 is tagged env:Production. These monitors are scoped to
     env:prod, so they are not watching it."

That is a *blind spot*: a monitor that would cover the resource if one tag
were spelled the way the policy says, and doesn't because it isn't.
"""
from __future__ import annotations

import re

# Tag Enforcer resource type -> the Discovery types it can correspond to.
# Hosts match by name (Discovery keys hosts on Datadog's numeric host ID);
# the rest share the Datadog ID both tools read.
TE_TO_DISCOVERY: dict[str, tuple[str, ...]] = {
    "host": ("Host", "VMware", "Cloud"),
    "monitor": ("Monitor",),
    "synthetic": ("Synthetic",),
    "dashboard": ("Dashboard",),
    "apm_service": ("Service",),
}
# Tag Enforcer evaluates these, Discovery doesn't index them.
NOT_INDEXED = ("slo", "log_pipeline")

# Findings where the policy already knows the right spelling. Only these can
# produce a blind spot: for a missing tag there is no "right value" to test.
SPELLING_FIXES = {"alias_remap", "not_normalized", "fragmentation"}

_SCOPE = re.compile(r"\{([^{}]*)\}")
_SPLIT = re.compile(r"\s*,\s*|\s+AND\s+", re.IGNORECASE)
_COMPLEX = re.compile(r"\s(OR|IN|NOT IN)\s|[()]", re.IGNORECASE)


def issues_from(findings: list[dict]) -> list[str]:
    """Searchable 'category:key' tokens for the active error and warning findings."""
    out: set[str] = set()
    for f in findings:
        if f.get("waived") or f.get("severity") not in ("error", "warning"):
            continue
        cat = (f.get("category") or "").lower()
        key = (f.get("tag_key") or "").lower()
        if cat:
            out.add(f"{cat}:{key}" if key else cat)
    return sorted(out)


def monitor_scopes(query: str) -> list[tuple[frozenset, frozenset]]:
    """Each `{...}` scope in a monitor query as (required tags, excluded tags).

    Comma and AND mean "all of these". A scope using OR, IN or parentheses is
    skipped rather than guessed at: a wrong blind spot sends someone to fix a
    monitor that was never broken. `*` (everything) is no constraint.
    """
    out = []
    for block in _SCOPE.findall(query or ""):
        block = block.strip()
        if not block or _COMPLEX.search(f" {block} "):
            continue
        required, excluded = set(), set()
        for tok in _SPLIT.split(block):
            tok = tok.strip()
            if not tok or tok == "*":
                continue
            if tok.startswith("!"):
                excluded.add(tok[1:])
            else:
                required.add(tok)
        if required:
            out.append((frozenset(required), frozenset(excluded)))
    return out


def _covers(scope: tuple[frozenset, frozenset], tags: set[str]) -> bool:
    required, excluded = scope
    return required <= tags and not (excluded & tags)


def _without(tags: set[str], key: str, value: str) -> set[str]:
    """tags minus the misspelled `key:value` (key and value compared case-insensitively)."""
    k, v = key.lower(), value.lower()
    return {t for t in tags if not (":" in t and t.split(":", 1)[0].lower() == k
                                    and t.split(":", 1)[1].lower() == v)}


def blind_spots(resource_tags: list[str], findings: list[dict], monitors: list[dict]) -> list[dict]:
    """Monitors that would cover this resource if a tag were spelled as policy says.

    monitors: [{"id", "name", "scopes": monitor_scopes(query)}]. A monitor is a
    blind spot only if it misses the resource now *and* covers it once the
    suggested fix is applied -- so fixing the tag is exactly what's needed.
    """
    tags = set(resource_tags or [])
    out: list[dict] = []
    seen: set = set()
    for f in findings:
        if f.get("waived") or f.get("category") not in SPELLING_FIXES:
            continue
        expected = f.get("suggestion") or ""
        if ":" not in expected or expected in tags:
            continue
        actual = f"{f.get('tag_key', '')}:{f.get('tag_value', '')}"
        fixed = _without(tags, f.get("tag_key", ""), f.get("tag_value", "")) | {expected}
        for m in monitors:
            if m["id"] in seen:
                continue
            for scope in m["scopes"]:
                if expected in scope[0] and not _covers(scope, tags) and _covers(scope, fixed):
                    seen.add(m["id"])
                    out.append({
                        "monitor_id": m["id"], "monitor_name": m["name"],
                        "expected_tag": expected, "actual_tag": actual,
                        "evidence": f"monitor scope requires {expected}; this resource has {actual}",
                    })
                    break
    return out


def match_ids(te_type: str, te_id: str, by_ext: dict, hosts_by_name: dict, hosts_by_alias: dict) -> list[int]:
    """Discovery resource ids for one Tag Enforcer resource. Hosts: exact name first, then alias."""
    types = TE_TO_DISCOVERY.get(te_type)
    if not types:
        return []
    if te_type == "host":
        key = (te_id or "").lower()
        return list(hosts_by_name.get(key) or hosts_by_alias.get(key) or [])
    return [by_ext[(t, te_id)] for t in types if (t, te_id) in by_ext]
