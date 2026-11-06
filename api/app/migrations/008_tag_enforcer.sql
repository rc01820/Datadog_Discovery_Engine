-- Tag Enforcer integration: one verdict per Discovery resource, imported from
-- Tag Enforcer's latest scan. Replaced wholesale on every import, so a resource
-- Tag Enforcer no longer evaluates simply has no row ("not evaluated").
CREATE TABLE tag_compliance (
    resource_id   BIGINT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    te_scan_id    BIGINT NOT NULL,
    te_type       TEXT NOT NULL,
    te_id         TEXT NOT NULL,
    compliant     BOOLEAN NOT NULL,
    error_count   INTEGER NOT NULL DEFAULT 0,
    warning_count INTEGER NOT NULL DEFAULT 0,
    remediable    BOOLEAN NOT NULL DEFAULT FALSE,
    teams         TEXT[] NOT NULL DEFAULT '{}',
    issues        TEXT[] NOT NULL DEFAULT '{}',      -- 'category:key' for active error/warning findings
    findings      JSONB NOT NULL DEFAULT '[]'::jsonb,
    blind_spots   JSONB NOT NULL DEFAULT '[]'::jsonb, -- monitors this resource misses because of a tag spelling
    te_path       TEXT NOT NULL DEFAULT '',
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tag_compliance_compliant_idx ON tag_compliance(compliant);
CREATE INDEX tag_compliance_issues_gin ON tag_compliance USING gin (issues);
CREATE INDEX tag_compliance_blind_idx ON tag_compliance ((jsonb_array_length(blind_spots) > 0));

CREATE TABLE tag_enforcer_imports (
    id          BIGSERIAL PRIMARY KEY,
    trigger     TEXT NOT NULL DEFAULT '',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'running',     -- running | success | failed | skipped
    te_scan_id  BIGINT,
    received    INTEGER NOT NULL DEFAULT 0,
    matched     INTEGER NOT NULL DEFAULT 0,
    unmatched   JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {resource_type: count} Tag Enforcer had but Discovery doesn't
    blind_spots INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX tag_enforcer_imports_started_idx ON tag_enforcer_imports(started_at DESC);
