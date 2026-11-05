import pytest

from app.query import QueryError, Term, compile_sql, parse, terms_of


def sql(q):
    params = []
    return compile_sql(parse(q), params), params


def test_free_text_contains():
    s, p = sql("eoc-app")
    assert "search_blob LIKE" in s and p == ["%eoc-app%"]


def test_or_and_precedence():
    node = parse("ip:10.10.50.* OR name:eoc* AND tag:app:xyz")
    assert node.op == "OR" and node.children[1].op == "AND"


def test_implicit_and_and_negation():
    node = parse("tag:app:xyz -tag:env:dev")
    assert node.op == "AND"
    s, p = sql("tag:app:xyz -tag:env:dev")
    assert "NOT (" in s and p == ["app:xyz", "env:dev"]


def test_hyphen_inside_term_is_not_negation():
    assert terms_of(parse("eoc-app-xyz-01"))[0].value == "eoc-app-xyz-01"


def test_wildcard_ip():
    t = terms_of(parse("ip:10.10.50.*"))[0]
    assert t.op == "wildcard"
    s, p = sql("ip:10.10.50.*")
    assert p == ["10.10.50.%"]


def test_cidr():
    t = terms_of(parse("10.10.50.0/24"))[0]
    assert t.op == "cidr"
    _, p = sql("ip:10.10.50.7/24")
    assert p == ["10.10.50.0/24"]


def test_regex_forms():
    assert terms_of(parse("regex:name:^RTR-[A-Z]{3}-\\d{2}$"))[0].op == "regex"
    t = terms_of(parse("name:/^eoc-(app|db)/"))[0]
    assert t.op == "regex" and t.value == "^eoc-(app|db)"


def test_regex_parentheses_inside_group():
    node = parse("(regex:name:^(a|b)$ OR tag:x:y)")
    assert node.op == "OR"


def test_invalid_regex():
    with pytest.raises(QueryError):
        parse("regex:name:([")


def test_quoted_exact():
    t = terms_of(parse('name:"XYZ URL Availability"'))[0]
    assert t == Term("XYZ URL Availability", "name", "exact")


def test_unknown_key_is_tag():
    t = terms_of(parse("costcenter:eoc"))[0]
    assert t.field == "tag" and t.value == "costcenter:eoc"


def test_type_alias_and_status_group():
    s, p = sql("type:monitor AND status:alert")
    assert "Monitor" in p and "alert" in p


def test_presence():
    s, _ = sql("missing:env")
    assert s.startswith("NOT")


def test_errors():
    for bad in ["(a OR b", "a OR", "()", '"unterminated', "x" * 600]:
        with pytest.raises(QueryError):
            parse(bad)


def test_empty():
    assert parse("   ") is None


def test_alias_field_and_synonyms():
    from app.query import matching_alias
    for q in ("alias:i-0a1b*", "aliases:i-0a1b*", "aws:i-0a1b*"):
        t = terms_of(parse(q))[0]
        assert t.field == "alias" and t.op == "wildcard"
    s, p = sql("alias:ip-10-10-50-21.ec2.internal")
    assert "r.aliases" in s and p == ["%ip-10-10-50-21.ec2.internal%"]
    assert sql("has:alias")[0] == "(cardinality(r.aliases) > 0)"
    # free-text wildcard/regex also search aliases
    assert "r.aliases" in sql("i-0a1b*")[0]
    aliases = ["i-0a1b2c3d", "ip-10-10-50-21.ec2.internal"]
    assert matching_alias(parse("i-0a1b*"), aliases) == "i-0a1b2c3d"
    assert matching_alias(parse("alias:/ec2\\.internal$/"), aliases) == "ip-10-10-50-21.ec2.internal"
    assert matching_alias(parse("name:eoc*"), aliases) is None


def test_new_types_and_mac():
    _, p = sql("type:pod")
    assert p == ["Pod"]
    assert sql("type:k8s")[1] == ["Cluster"]
    assert sql("type:interface")[1] == ["Interface"]
    t = terms_of(parse("aa:bb:cc:dd:ee:ff"))[0]
    assert t.field is None and t.op == "contains"
    t = terms_of(parse("mac:aa:bb:*"))[0]
    assert t.field == "alias" and t.op == "wildcard"
    assert terms_of(parse("app:xyz"))[0].field == "tag"  # still a tag
