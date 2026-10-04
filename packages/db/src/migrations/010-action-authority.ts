/** Existing actions/grants without a snapshot deliberately fail closed after migration. */
export const actionAuthoritySql = `
ALTER TABLE capability_grants ADD COLUMN ancestor_fences jsonb NOT NULL DEFAULT '[]';
ALTER TABLE capability_grants ADD COLUMN authority_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE actions ADD COLUMN authority_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE action_approvals ADD COLUMN authority_snapshot jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_installations ADD CONSTRAINT agent_installations_principal_binding UNIQUE(tenant_id,id,agent_principal_id);
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_installation_binding UNIQUE(tenant_id,id,installation_id);
ALTER TABLE agent_access_tokens ADD CONSTRAINT agent_tokens_credential_binding FOREIGN KEY(tenant_id,credential_id,installation_id) REFERENCES agent_credentials(tenant_id,id,installation_id);
ALTER TABLE agent_access_tokens ADD CONSTRAINT agent_tokens_principal_binding FOREIGN KEY(tenant_id,installation_id,principal_id) REFERENCES agent_installations(tenant_id,id,agent_principal_id);
ALTER TABLE agent_access_tokens ADD CONSTRAINT agent_tokens_positive_revisions CHECK(installation_revision>0 AND credential_revision>0 AND principal_version>0 AND tenant_authz_revision>0);
`;
