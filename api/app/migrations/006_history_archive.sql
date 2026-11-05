INSERT INTO app_settings (key, value) VALUES ('history_archive_enabled', 'false') ON CONFLICT (key) DO NOTHING;
