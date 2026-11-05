"""Tag Enforcer integration: matching, issue tokens, monitor scopes and blind spots."""
import pytest

from app.query import QueryError, compile_sql, parse
from app.tagpolicy import blind_spots, issues_from, match_ids, monitor_scopes


def sql(q):
    params = []
    return compile_sql(parse(q), params), params


# ---- monitor scopes ---------------------------------------------------------
def test_scope_parses_comma_and_and():
    assert monitor_scopes("avg(last_5m):avg:system.cpu.user{env:prod,service:checkout} by {host} > 90") == [
        (frozenset({"env:prod", "service:checkout"}), frozenset()),
        (frozenset({"host"}), frozenset()),
    ]
    assert monitor_scopes("avg:x{env:prod AND team:payments}") == [(frozenset({"env:prod", "team:payments"}), frozenset())]


def test_scope_negation_and_wildcard():
    assert monitor_scopes("avg:x{env:prod,!role:db}") == [(frozenset({"env:prod"}), frozenset({"role:db"}))]
    assert monitor_scopes("avg:x{*}") == []


def test_complex_scopes_are_skipped_not_guessed():
    assert monitor_scopes("avg:x{env:prod OR env:staging}") == []
    assert monitor_scopes("avg:x{env IN (prod, staging)}") == []
    assert monitor_scopes('logs("service:x").index("*").rollup("count").last("5m") > 1') == []


# ---- blind spots ------------------------------------------------------------
MON = [
    {"id": 1, "name": "checkout cpu", "scopes": monitor_scopes("avg:cpu{env:prod,service:checkout} > 90")},
    {"id": 2, "name": "orders cpu", "scopes": monitor_scopes("avg:cpu{env:prod,service:orders} > 90")},
    {"id": 3, "name": "prod disk", "scopes": monitor_scopes("avg:disk{env:prod,!role:web} > 90")},
    {"id": 4, "name": "east anything", "scopes": monitor_scopes("avg:x{datacenter:dc-east}")},
]
ALIAS_ENV = {"severity": "error", "category": "alias_remap", "tag_key": "env", "tag_value": "Production",
             "suggestion": "env:prod", "auto_fixable": True, "waived": False}


def test_misspelled_tag_makes_matching_monitor_a_blind_spot():
    spots = blind_spots(["env:Production", "service:checkout", "role:web"], [ALIAS_ENV], MON)
    assert [s["monitor_id"] for s in spots] == [1]
    assert spots[0]["expected_tag"] == "env:prod" and spots[0]["actual_tag"] == "env:Production"


def test_monitor_that_still_would_not_cover_is_not_a_blind_spot():
    # service:orders and !role:web keep monitors 2 and 3 away even after the fix.
    spots = blind_spots(["env:Production", "service:checkout", "role:web"], [ALIAS_ENV], MON)
    assert {s["monitor_id"] for s in spots} == {1}


def test_already_covered_or_unrelated_is_not_a_blind_spot():
    assert blind_spots(["env:prod", "env:Production", "service:checkout"], [ALIAS_ENV], MON) == []
    assert blind_spots(["env:Production"], [{**ALIAS_ENV, "waived": True}], MON) == []
    missing = {"severity": "error", "category": "missing_required", "tag_key": "team", "suggestion": "", "waived": False}
    assert blind_spots(["env:prod"], [missing], MON) == []


def test_each_monitor_reported_once():
    dc = {"severity": "error", "category": "alias_remap", "tag_key": "datacenter", "tag_value": "east",
          "suggestion": "datacenter:dc-east", "waived": False}
    spots = blind_spots(["env:Production", "datacenter:east", "service:checkout", "role:web"], [ALIAS_ENV, dc], MON)
    assert sorted(s["monitor_id"] for s in spots) == [1, 4]


# ---- issues and matching ----------------------------------------------------
def test_issue_tokens_skip_waived_and_info():
    findings = [
        {"severity": "error", "category": "missing_required", "tag_key": "Service", "waived": False},
        {"severity": "warning", "category": "ust_incomplete", "tag_key": "", "waived": False},
        {"severity": "info", "category": "undefined_key", "tag_key": "x", "waived": False},
        {"severity": "error", "category": "forbidden", "tag_key": "owner-email", "waived": True},
    ]
    assert issues_from(findings) == ["missing_required:service", "ust_incomplete"]


def test_match_hosts_by_name_then_alias_and_others_by_id():
    by_ext = {("Monitor", "101"): 7, ("Service", "checkout"): 9, ("Host", "12345"): 3}
    names, aliases = {"web-prod-02": [3]}, {"i-0abc": [3]}
    assert match_ids("host", "WEB-PROD-02", by_ext, names, aliases) == [3]
    assert match_ids("host", "i-0abc", by_ext, names, aliases) == [3]
    assert match_ids("host", "12345", by_ext, {}, {}) == []      # never by Datadog host id
    assert match_ids("monitor", "101", by_ext, names, aliases) == [7]
    assert match_ids("apm_service", "checkout", by_ext, names, aliases) == [9]
    assert match_ids("slo", "slo-1", by_ext, names, aliases) == []


# ---- query language ---------------------------------------------------------
def test_compliant_and_flags_compile_to_tag_compliance():
    s, p = sql("compliant:no")
    assert "tag_compliance tc" in s and "NOT (tc.compliant)" in s and p == []
    assert "tc.remediable" in sql("fixable:yes")[0]
    assert "jsonb_array_length(tc.blind_spots) > 0" in sql("blindspot:true")[0]


def test_flag_values_are_validated():
    with pytest.raises(QueryError):
        sql("compliant:maybe")
    with pytest.raises(QueryError):
        sql("fixable:y*")


def test_tagissue_category_and_exact():
    s, p = sql("tagissue:missing_required")
    assert "unnest(tc.issues)" in s and p == ["missing_required", "missing\\_required:%"]
    s, p = sql("tagissue:missing_required:Service")
    assert p == ["missing_required:service"]


def test_tagpolicy_presence_and_combination():
    assert "tag_compliance" in sql("has:tagpolicy")[0]
    assert sql("missing:tagpolicy")[0].startswith("NOT (")
    s, p = sql("type:host env:prod compliant:no")
    assert "r.type = %s" in s and "tc.compliant" in s and p[0] == "Host"
