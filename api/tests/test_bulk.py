from app.routes.bulk import classify, parse_items


def test_parse_items_splits_dedupes_and_strips():
    text = """10.10.50.21, 10.10.50.21
    "eoc-app-xyz-01";i-0a1b2c3d4e5f6g7h8\tweb01.corp.example.com.
    # comment line
    EOC-APP-XYZ-01  (aa:bb:cc:dd:ee:ff)"""
    assert parse_items(text) == ["10.10.50.21", "eoc-app-xyz-01", "i-0a1b2c3d4e5f6g7h8", "web01.corp.example.com",
                                 "comment", "line", "aa:bb:cc:dd:ee:ff"]


def test_classify():
    assert classify("10.10.50.21") == "ip"
    assert classify("fe80::1") == "ip"
    assert classify("10.10.50.0/24") == "cidr"
    assert classify("i-0831170512d0e4fdb") == "instance_id"
    assert classify("00:1A:2b:3c:4d:5e") == "mac"
    assert classify("3f2a9c1b7d0e") == "container_id"
    assert classify("eoc-app-xyz-01.corp.example.com") == "hostname"


def test_record_hash_ignores_list_order_and_timestamps():
    from datetime import datetime, timezone
    from app.inventory import record_hash
    base = {"type": "Host", "external_id": "1", "name": "h1", "status": "Up", "tags": ["a:1", "b:2"], "ips": ["10.0.0.1", "10.0.0.2"],
            "aliases": ["x", "y"], "attributes": {"k": 1}, "last_observed": datetime(2026, 1, 1, tzinfo=timezone.utc)}
    shuffled = {**base, "tags": ["b:2", "a:1"], "ips": ["10.0.0.2", "10.0.0.1"], "aliases": ["y", "x"],
                "last_observed": datetime(2026, 6, 1, tzinfo=timezone.utc)}
    assert record_hash(base) == record_hash(shuffled)
    assert record_hash({**base, "attributes": {"sources": ["agent", "aws"]}}) == record_hash({**base, "attributes": {"sources": ["aws", "agent"]}})
    assert record_hash(base) != record_hash({**base, "status": "Down"})
    assert record_hash(base) != record_hash({**base, "tags": ["a:1"]})
