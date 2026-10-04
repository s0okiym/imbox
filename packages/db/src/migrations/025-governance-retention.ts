export const governanceRetentionSql=`
ALTER TABLE agent_runs ADD COLUMN content_redacted_at timestamptz;
CREATE INDEX messages_retention ON messages(tenant_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX resources_retention ON resources(tenant_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX run_content_retention ON agent_runs(tenant_id,updated_at,id) WHERE status IN ('completed','failed','cancelled','expired') AND content_redacted_at IS NULL;
CREATE INDEX run_lifetime_expiration ON agent_runs(tenant_id,created_at,id) WHERE status NOT IN ('completed','failed','cancelled','expired');
CREATE INDEX export_expiration ON governance_exports(tenant_id,expires_at,id);
`;
