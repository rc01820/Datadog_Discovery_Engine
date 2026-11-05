-- Databases became a data source.
UPDATE datadog_connections SET sources = array_append(sources, 'databases') WHERE NOT ('databases' = ANY(sources));
