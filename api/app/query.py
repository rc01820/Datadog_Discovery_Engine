"""Datadog Search query language: tokenizer -> AST -> parameterized SQL.

Syntax (Datadog Search specific, not native Datadog syntax):
  free text            eoc-app            substring over every indexed field
  field prefix         name:eoc-*  ip:10.10.50.0/24  tag:app:xyz  type:monitor  status:alert
  unknown key:value    costcenter:eoc     treated as an exact tag match
  wildcard             * and ?            anchored glob match
  exact                "quoted value"     case-insensitive equality
  regex                regex:name:^eoc-.*   or   name:/^eoc-\\d+$/
  alias                alias:i-0abc*  alias:ip-10-0-1-5.ec2.internal   (AWS instance IDs, EC2/RDS DNS names, Name tags)
  presence             has:ip  missing:env  has:costcenter  has:alias
  boolean              AND, OR, NOT, -term, parentheses; adjacent terms are ANDed
"""
from __future__ import annotations

import fnmatch
import ipaddress
import re
from dataclasses import dataclass, field

MAX_QUERY_LEN = 500
MAX_TERMS = 30
MAX_DEPTH = 12
MAX_REGEX_LEN = 200

FIELDS = {"name", "ip", "tag", "type", "status", "env", "os", "vendor", "model", "id", "source", "agent", "has", "missing",
          "alias", "aliases", "aws", "mac"}
FIELD_SYNONYMS = {"aliases": "alias", "aws": "alias", "mac": "alias"}
MAC_RE = re.compile(r"^(?:[0-9A-Fa-f*?]{1,2}[:-]){2,5}[0-9A-Fa-f*?]{0,2}$")
COLUMN = {"name": "r.name", "env": "r.env", "os": "r.os", "vendor": "r.vendor", "model": "r.model",
          "id": "r.external_id", "source": "r.source", "agent": "r.agent_version", "type": "r.type", "status": "r.status"}
TYPE_ALIASES = {
    "host": "Host", "hosts": "Host", "server": "Host",
    "device": "Device", "devices": "Device", "network": "Device", "network device": "Device", "ndm": "Device",
    "monitor": "Monitor", "monitors": "Monitor",
    "tag": "Tag", "tags": "Tag",
    "service": "Service", "services": "Service", "apm": "Service",
    "synthetic": "Synthetic", "synthetics": "Synthetic",
    "dashboard": "Dashboard", "dashboards": "Dashboard",
    "vmware": "VMware", "vm": "VMware", "vsphere": "VMware",
    "cloud": "Cloud", "aws": "Cloud",
    "interface": "Interface", "interfaces": "Interface", "port": "Interface", "nic": "Interface",
    "cluster": "Cluster", "clusters": "Cluster", "k8s": "Cluster", "kubernetes": "Cluster",
    "pod": "Pod", "pods": "Pod",
    "container": "Container", "containers": "Container", "docker": "Container",
}
STATUS_GROUPS = {"ok": "ok", "up": "ok", "alert": "alert", "alerting": "alert", "critical": "alert", "down": "alert",
                 "warn": "warn", "warning": "warn", "muted": "muted", "unknown": "unknown", "nodata": "unknown", "no data": "unknown"}
PRESENCE_COLUMNS = {"ip": "cardinality(r.ips) > 0", "alias": "cardinality(r.aliases) > 0", "aliases": "cardinality(r.aliases) > 0", "os": "r.os <> ''", "env": "r.env <> ''", "vendor": "r.vendor <> ''",
                    "agent": "r.agent_version <> ''", "tags": "cardinality(r.tags) > 0", "model": "r.model <> ''"}
KEY_RE = re.compile(r"^[A-Za-z][\w.\-/]*$")


class QueryError(ValueError):
    pass


# ---- AST -------------------------------------------------------------------
@dataclass
class Term:
    value: str
    field: str | None = None
    op: str = "contains"  # contains | exact | wildcard | regex | cidr | presence

    def __str__(self) -> str:
        prefix = f"{self.field}:" if self.field else ""
        if self.op == "regex":
            return f"regex:{prefix}{self.value}"
        if self.op == "exact":
            return f'{prefix}"{self.value}"'
        return f"{prefix}{self.value}"


@dataclass
class Not:
    child: object

    def __str__(self) -> str:
        return f"NOT {self.child}"


@dataclass
class BoolOp:
    op: str  # AND | OR
    children: list = field(default_factory=list)

    def __str__(self) -> str:
        return "(" + f" {self.op} ".join(str(c) for c in self.children) + ")"


# ---- tokenizer -------------------------------------------------------------
@dataclass
class Tok:
    kind: str  # LP RP AND OR NOT TERM
    text: str = ""
    quoted: bool = False
    pos: int = 0


def tokenize(q: str) -> list[Tok]:
    toks: list[Tok] = []
    i, n = 0, len(q)
    while i < n:
        ch = q[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "(":
            toks.append(Tok("LP", "(", pos=i)); i += 1; continue
        if ch == ")":
            toks.append(Tok("RP", ")", pos=i)); i += 1; continue
        if ch == "-" and i + 1 < n and not q[i + 1].isspace() and (not toks or toks[-1].kind != "TERM" or q[i - 1].isspace()):
            toks.append(Tok("NOT", "-", pos=i)); i += 1; continue
        start = i
        buf: list[str] = []
        quoted = False
        depth = 0
        while i < n:
            ch = q[i]
            if ch == '"':
                end = i + 1
                chunk: list[str] = []
                while end < n and q[end] != '"':
                    if q[end] == "\\" and end + 1 < n:
                        end += 1
                    chunk.append(q[end]); end += 1
                if end >= n:
                    raise QueryError(f"Unterminated quote at position {i + 1}")
                buf.append("\x00" + "".join(chunk) + "\x00")
                quoted = True
                i = end + 1
                continue
            if ch == "/" and buf and "".join(buf).endswith(":"):
                end = i + 1
                while end < n and q[end] != "/":
                    if q[end] == "\\":
                        end += 1
                    end += 1
                if end >= n:
                    raise QueryError(f"Unterminated /regex/ at position {i + 1}")
                buf.append(q[i:end + 1]); i = end + 1
                continue
            if ch.isspace():
                break
            if ch == "(":
                depth += 1
            elif ch == ")":
                if depth == 0:
                    break
                depth -= 1
            buf.append(ch); i += 1
        text = "".join(buf)
        upper = text.upper()
        if not quoted and upper in ("AND", "&&"):
            toks.append(Tok("AND", pos=start))
        elif not quoted and upper in ("OR", "||"):
            toks.append(Tok("OR", pos=start))
        elif not quoted and upper == "NOT":
            toks.append(Tok("NOT", pos=start))
        else:
            toks.append(Tok("TERM", text, quoted, start))
    return toks


# ---- parser ----------------------------------------------------------------
class Parser:
    def __init__(self, toks: list[Tok]):
        self.toks, self.i, self.terms = toks, 0, 0

    def peek(self) -> Tok | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self) -> Tok:
        t = self.toks[self.i]; self.i += 1; return t

    def parse(self):
        if not self.toks:
            return None
        node = self.or_expr(0)
        if self.peek():
            t = self.peek()
            raise QueryError(f"Unexpected '{t.text or t.kind}' at position {t.pos + 1}")
        return node

    def or_expr(self, depth):
        children = [self.and_expr(depth)]
        while self.peek() and self.peek().kind == "OR":
            self.take()
            children.append(self.and_expr(depth))
        return children[0] if len(children) == 1 else BoolOp("OR", children)

    def and_expr(self, depth):
        children = [self.unary(depth)]
        while self.peek() and self.peek().kind in ("AND", "NOT", "LP", "TERM"):
            if self.peek().kind == "AND":
                self.take()
            children.append(self.unary(depth))
        return children[0] if len(children) == 1 else BoolOp("AND", children)

    def unary(self, depth):
        if depth > MAX_DEPTH:
            raise QueryError("Query is nested too deeply")
        t = self.peek()
        if t is None:
            raise QueryError("Query ends unexpectedly; expected a term")
        if t.kind == "NOT":
            self.take()
            return Not(self.unary(depth + 1))
        if t.kind == "LP":
            self.take()
            if self.peek() and self.peek().kind == "RP":
                raise QueryError(f"Empty parentheses at position {t.pos + 1}")
            node = self.or_expr(depth + 1)
            if not self.peek() or self.peek().kind != "RP":
                raise QueryError(f"Missing ')' for '(' at position {t.pos + 1}")
            self.take()
            return node
        if t.kind == "TERM":
            self.take()
            self.terms += 1
            if self.terms > MAX_TERMS:
                raise QueryError(f"Too many terms (maximum {MAX_TERMS})")
            return make_term(t.text, t.quoted)
        raise QueryError(f"Unexpected '{t.text or t.kind}' at position {t.pos + 1}")


def _unquote(s: str) -> tuple[str, bool]:
    if "\x00" in s:
        return s.replace("\x00", ""), True
    return s, False


def make_term(raw: str, quoted: bool) -> Term:
    regex = False
    low = raw.lower()
    for p in ("regex:", "re:"):
        if low.startswith(p):
            regex, raw = True, raw[len(p):]
            break
    fld = None
    if MAC_RE.match(raw):  # bare MAC address: search it as text, not as a key:value tag
        return Term(raw, None, "wildcard" if ("*" in raw or "?" in raw) else "contains")
    if ":" in raw and not raw.startswith("\x00"):
        key, rest = raw.split(":", 1)
        if key.lower() in FIELDS and rest:
            fld, raw = FIELD_SYNONYMS.get(key.lower(), key.lower()), rest
        elif not regex and KEY_RE.match(key) and rest and not _looks_like_ipv6(raw):
            fld = "tag"  # unknown key:value -> tag match, e.g. costcenter:eoc
    value, was_quoted = _unquote(raw)
    if not value:
        raise QueryError(f"Empty value in term '{raw}'")
    if fld in ("has", "missing"):
        return Term(value.lower(), fld, "presence")
    if len(value) > 2 and value.startswith("/") and value.endswith("/"):
        regex, value = True, value[1:-1]
    if regex:
        if len(value) > MAX_REGEX_LEN:
            raise QueryError(f"Regular expression too long (maximum {MAX_REGEX_LEN})")
        try:
            re.compile(value)
        except re.error as e:
            raise QueryError(f"Invalid regular expression '{value}': {e}") from None
        return Term(value, fld, "regex")
    if was_quoted:
        return Term(value, fld, "exact")
    if "*" in value or "?" in value:
        return Term(value, fld, "wildcard")
    if fld in (None, "ip") and "/" in value and _is_cidr(value):
        return Term(value, "ip", "cidr")
    return Term(value, fld, "contains")


def _looks_like_ipv6(s: str) -> bool:
    try:
        ipaddress.ip_network(s, strict=False)
        return ":" in s
    except ValueError:
        return False


def _is_cidr(s: str) -> bool:
    try:
        ipaddress.ip_network(s, strict=False)
        return True
    except ValueError:
        return False


def parse(q: str):
    q = (q or "").strip()
    if len(q) > MAX_QUERY_LEN:
        raise QueryError(f"Query too long (maximum {MAX_QUERY_LEN} characters)")
    return Parser(tokenize(q)).parse()


def terms_of(node) -> list[Term]:
    if node is None:
        return []
    if isinstance(node, Term):
        return [node]
    if isinstance(node, Not):
        return terms_of(node.child)
    return [t for c in node.children for t in terms_of(c)]


# ---- SQL compilation -------------------------------------------------------
def like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def glob_to_like(s: str) -> str:
    return like_escape(s.lower()).replace("*", "%").replace("?", "_")


def _array_any(column: str, cond: str) -> str:
    return f"EXISTS (SELECT 1 FROM unnest({column}) AS x(v) WHERE {cond})"


def _match(expr: str, op: str, value: str, params: list) -> str:
    """Compare a scalar SQL expression to value using the given operator."""
    if op == "exact":
        params.append(value.lower()); return f"lower({expr}) = %s"
    if op == "wildcard":
        params.append(glob_to_like(value)); return f"lower({expr}) LIKE %s ESCAPE '\\'"
    if op == "regex":
        params.append(value); return f"{expr} ~* %s"
    params.append("%" + like_escape(value.lower()) + "%"); return f"lower({expr}) LIKE %s ESCAPE '\\'"


def compile_term(t: Term, params: list) -> str:
    f, op, v = t.field, t.op, t.value
    if op == "presence":
        if v in PRESENCE_COLUMNS:
            sql = PRESENCE_COLUMNS[v]
        else:
            params.extend([v.lower(), like_escape(v.lower()) + ":%"])
            sql = _array_any("r.tags", "lower(x.v) = %s OR lower(x.v) LIKE %s ESCAPE '\\'")
        return f"NOT ({sql})" if f == "missing" else f"({sql})"
    if op == "cidr":
        net = str(ipaddress.ip_network(v, strict=False))
        params.append(net)
        return _array_any("r.ips", "x.v::inet <<= %s::inet")
    if f == "ip":
        return _array_any("r.ips", _match("x.v", op, v, params))
    if f == "alias":
        return _array_any("r.aliases", _match("x.v", op, v, params))
    if f == "tag":
        if op == "contains":
            low = v.lower()
            if ":" in low:
                params.append(low); return _array_any("r.tags", "lower(x.v) = %s")
            params.extend([low, like_escape(low) + ":%"])
            return _array_any("r.tags", "lower(x.v) = %s OR lower(x.v) LIKE %s ESCAPE '\\'")
        return _array_any("r.tags", _match("x.v", op, v, params))
    if f == "type" and op in ("contains", "exact"):
        canonical = TYPE_ALIASES.get(v.lower())
        if canonical:
            params.append(canonical); return "r.type = %s"
        params.append(f"type:{v.lower()}")
        return _array_any("r.tags", "lower(x.v) = %s")
    if f == "status" and op in ("contains", "exact"):
        group = STATUS_GROUPS.get(v.lower())
        if group:
            params.extend([group, v.lower()]); return "(r.status_group = %s OR lower(r.status) = %s)"
        params.append(v.lower()); return "lower(r.status) = %s"
    if f in COLUMN:
        return _match(COLUMN[f], op, v, params)
    # free text
    if op == "contains":
        params.append("%" + like_escape(v.lower()) + "%")
        return "r.search_blob LIKE %s ESCAPE '\\'"
    parts = [_match(c, op, v, params) for c in ("r.name", "r.external_id", "r.type", "r.status", "r.os", "r.vendor")]
    parts.append(_array_any("r.ips", _match("x.v", op, v, params)))
    parts.append(_array_any("r.aliases", _match("x.v", op, v, params)))
    parts.append(_array_any("r.tags", _match("x.v", op, v, params)))
    return "(" + " OR ".join(parts) + ")"


def compile_sql(node, params: list) -> str:
    if node is None:
        return "TRUE"
    if isinstance(node, Term):
        return compile_term(node, params)
    if isinstance(node, Not):
        return f"NOT ({compile_sql(node.child, params)})"
    joiner = f" {node.op} "
    return "(" + joiner.join(compile_sql(c, params) for c in node.children) + ")"


def build_search_blob(name: str, external_id: str, type_: str, status: str, ips, tags, env: str, os_: str,
                      vendor: str, model: str, extra: str = "") -> str:
    return " ".join([name, external_id, type_, status, env, os_, vendor, model, *ips, *tags, extra]).lower()


def _value_matches(t: Term, value: str) -> bool:
    v, low = t.value, value.lower()
    if t.op == "exact":
        return low == v.lower()
    if t.op == "wildcard":
        return fnmatch.fnmatchcase(low, v.lower())
    if t.op == "regex":
        try:
            return re.search(v, value, re.IGNORECASE) is not None
        except re.error:
            return False
    if t.op == "contains":
        return v.lower() in low
    return False


def matching_alias(node, aliases: list[str]) -> str | None:
    """The first alias that satisfied a free-text or alias: term, so the UI can explain why a row matched."""
    if not aliases:
        return None
    for t in terms_of(node):
        if t.field in (None, "alias"):
            for a in aliases:
                if _value_matches(t, a):
                    return a
    return None
