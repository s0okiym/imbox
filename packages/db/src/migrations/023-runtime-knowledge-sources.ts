export const runtimeKnowledgeSourcesSql = `
ALTER TABLE context_items DROP CONSTRAINT context_items_source_type_check;
ALTER TABLE context_items ADD CONSTRAINT context_items_source_type_check CHECK(source_type IN ('message','task','memory','artifact_version'));
ALTER TABLE context_items ADD COLUMN source_sha256 text CHECK(source_sha256 IS NULL OR source_sha256~'^[a-f0-9]{64}$');
ALTER TABLE context_items ADD CONSTRAINT context_items_extended_source_hash CHECK(source_type NOT IN ('memory','artifact_version') OR source_sha256 IS NOT NULL);
CREATE INDEX context_memory_source ON context_items(tenant_id,source_id) WHERE source_type='memory';
CREATE INDEX context_artifact_source ON context_items(tenant_id,source_id) WHERE source_type='artifact_version';
`;
