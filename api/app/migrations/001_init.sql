CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE roles (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    permissions TEXT[] NOT NULL
);

INSERT INTO roles (name, description, permissions) VALUES
 ('Administrator', 'Users, roles, integrations, audit and all search functions',
  ARRAY['search','inspect','saved.personal','export','saved.shared','admin.users','admin.integrations','admin.settings','admin.audit']),
 ('Operator', 'Search, export and shared saved searches',
  ARRAY['search','inspect','saved.personal','export','saved.shared']),
 ('Viewer', 'Permitted searches and details; export is configurable',
  ARRAY['search','inspect','saved.personal']);

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login    TIMESTAMPTZ
);

CREATE TABLE user_roles (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL REFERENCES roles(name),
    PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    ip         TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE organizations (
    id   BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE datadog_connections (
    id             BIGSERIAL PRIMARY KEY,
    org_id         BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site           TEXT NOT NULL,
    api_key_enc    TEXT NOT NULL DEFAULT '',
    app_key_enc    TEXT NOT NULL DEFAULT '',
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 15,
    sources        TEXT[] NOT NULL DEFAULT ARRAY['hosts','monitors','devices','synthetics','dashboards','services'],
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id)
);

CREATE TABLE resources (
    id             BIGSERIAL PRIMARY KEY,
    org_id         BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source         TEXT NOT NULL,            -- DEMO | Datadog
    type           TEXT NOT NULL,            -- Host, Device, Monitor, Tag, Service, Synthetic, Dashboard, VMware, Cloud
    external_id    TEXT NOT NULL,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Unknown',
    status_group   TEXT NOT NULL DEFAULT 'unknown', -- ok | alert | warn | muted | unknown
    ips            TEXT[] NOT NULL DEFAULT '{}',
    tags           TEXT[] NOT NULL DEFAULT '{}',
    env            TEXT NOT NULL DEFAULT '',
    os             TEXT NOT NULL DEFAULT '',
    vendor         TEXT NOT NULL DEFAULT '',
    model          TEXT NOT NULL DEFAULT '',
    agent_version  TEXT NOT NULL DEFAULT '',
    deep_link      TEXT NOT NULL DEFAULT '',
    attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_blob    TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ,
    first_indexed  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_indexed   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_observed  TIMESTAMPTZ,
    sync_version   BIGINT NOT NULL DEFAULT 0,
    UNIQUE (org_id, source, type, external_id)
);
CREATE INDEX resources_type_idx ON resources(type);
CREATE INDEX resources_status_idx ON resources(status_group);
CREATE INDEX resources_name_trgm ON resources USING gin (lower(name) gin_trgm_ops);
CREATE INDEX resources_blob_trgm ON resources USING gin (search_blob gin_trgm_ops);
CREATE INDEX resources_tags_gin ON resources USING gin (tags);
CREATE INDEX resources_ips_gin ON resources USING gin (ips);

CREATE TABLE monitors (
    resource_id BIGINT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    monitor_type TEXT NOT NULL DEFAULT '',
    query       TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    muted       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE resource_relationships (
    from_id  BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    to_id    BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (from_id, to_id, relation)
);

CREATE TABLE saved_searches (
    id          BIGSERIAL PRIMARY KEY,
    owner_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    query       TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'All',
    description TEXT NOT NULL DEFAULT '',
    shared      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_at TIMESTAMPTZ,
    run_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE favorites (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('resource','query')),
    ref        TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, ref)
);

CREATE TABLE search_audit (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    username    TEXT NOT NULL,
    query       TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'All',
    result_count INTEGER NOT NULL DEFAULT 0,
    took_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX search_audit_user_idx ON search_audit(user_id, at DESC);

CREATE TABLE audit_events (
    id       BIGSERIAL PRIMARY KEY,
    at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    username TEXT NOT NULL,
    action   TEXT NOT NULL,
    target   TEXT NOT NULL DEFAULT '',
    detail   JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_events_at_idx ON audit_events(at DESC);

CREATE TABLE sync_jobs (
    id          BIGSERIAL PRIMARY KEY,
    org_id      BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
    trigger     TEXT NOT NULL,             -- manual | schedule
    requested_by TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | success | partial | failed
    queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    counts      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE sync_errors (
    id       BIGSERIAL PRIMARY KEY,
    job_id   BIGINT NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
    source   TEXT NOT NULL,
    category TEXT NOT NULL,  -- permission_denied | not_available | source_unavailable | rate_limited | error
    message  TEXT NOT NULL,
    at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE source_status (
    org_id       BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source       TEXT NOT NULL,
    last_success TIMESTAMPTZ,
    last_attempt TIMESTAMPTZ,
    last_error   TEXT NOT NULL DEFAULT '',
    category     TEXT NOT NULL DEFAULT '',
    record_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, source)
);

CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

INSERT INTO app_settings (key, value) VALUES
 ('viewer_can_export', 'false'),
 ('session_hours', '8'),
 ('required_tags', '["env","app","costcenter"]'),
 ('stale_after_hours', '24'),
 ('audit_retention_days', '365'),
 ('default_page_size', '10');
