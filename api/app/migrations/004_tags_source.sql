-- Tags became a toggleable (derived) data source.
UPDATE datadog_connections SET sources = array_append(sources, 'tags') WHERE NOT ('tags' = ANY(sources));
