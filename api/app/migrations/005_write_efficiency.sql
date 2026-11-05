-- Content fingerprint so a sync can skip records whose data did not change.
ALTER TABLE resources ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
-- Leave free space in each page so the narrow "last seen" updates can be HOT (no index maintenance).
ALTER TABLE resources SET (fillfactor = 80);
-- Datadog Tag entities are now a collector of their own.
UPDATE resources SET collector = 'tags' WHERE source = 'Datadog' AND type = 'Tag';
CREATE INDEX IF NOT EXISTS resource_changes_type_at_idx ON resource_changes(type, at);

INSERT INTO app_settings (key, value) VALUES
 ('history_retention_days', '365'),
 ('ephemeral_history_retention_days', '14'),
 ('track_ephemeral_changes', 'true')
ON CONFLICT (key) DO NOTHING;
