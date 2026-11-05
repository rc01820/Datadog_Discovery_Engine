-- Host aliases (AWS instance IDs, EC2/RDS DNS names, cloud Name tags, alternate hostnames) as a searchable column.
ALTER TABLE resources ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}';
UPDATE resources
   SET aliases = ARRAY(SELECT jsonb_array_elements_text(attributes->'aliases'))
 WHERE jsonb_typeof(attributes->'aliases') = 'array';
CREATE INDEX resources_aliases_gin ON resources USING gin (aliases);
