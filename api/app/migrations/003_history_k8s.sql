-- Which collector produced a record, so pruning is per collector (several collectors may emit the same type).
ALTER TABLE resources ADD COLUMN collector TEXT NOT NULL DEFAULT '';
UPDATE resources SET collector = CASE type
    WHEN 'Host' THEN 'hosts' WHEN 'VMware' THEN 'hosts' WHEN 'Cloud' THEN 'hosts'
    WHEN 'Monitor' THEN 'monitors' WHEN 'Device' THEN 'devices' WHEN 'Synthetic' THEN 'synthetics'
    WHEN 'Dashboard' THEN 'dashboards' WHEN 'Service' THEN 'services' ELSE '' END
 WHERE source = 'Datadog';
CREATE INDEX resources_collector_idx ON resources(source, collector);

-- Change history between syncs.
CREATE TABLE resource_changes (
    id           BIGSERIAL PRIMARY KEY,
    at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    org_id       BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resource_id  BIGINT REFERENCES resources(id) ON DELETE SET NULL,
    resource_key TEXT NOT NULL,            -- source|type|external_id: survives deletion and re-creation
    source       TEXT NOT NULL,
    type         TEXT NOT NULL,
    name         TEXT NOT NULL,
    change       TEXT NOT NULL,            -- added | removed | status | tags | ips | aliases | renamed
    before       JSONB,
    after        JSONB,
    summary      TEXT NOT NULL DEFAULT '',
    job_id       BIGINT REFERENCES sync_jobs(id) ON DELETE SET NULL
);
CREATE INDEX resource_changes_at_idx ON resource_changes(at DESC);
CREATE INDEX resource_changes_key_idx ON resource_changes(resource_key, at DESC);
CREATE INDEX resource_changes_rid_idx ON resource_changes(resource_id, at DESC);
CREATE INDEX resource_changes_name_trgm ON resource_changes USING gin (lower(name) gin_trgm_ops);

INSERT INTO app_settings (key, value) VALUES ('auto_purge_demo', 'true') ON CONFLICT DO NOTHING;

UPDATE datadog_connections
   SET sources = sources || ARRAY['interfaces','kubernetes','aws']
 WHERE NOT ('kubernetes' = ANY(sources));
