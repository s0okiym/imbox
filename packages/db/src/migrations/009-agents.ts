const tables=['agent_provisioning_requests','agent_credentials','agent_access_tokens','runtime_scan_cursors'] as const;
export const agentsSql=`
ALTER TABLE agent_installations ADD COLUMN allowed_scopes jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_runs ADD COLUMN execution_location text NOT NULL DEFAULT 'hosted' CHECK(execution_location IN ('hosted','device','external'));
ALTER TABLE agent_runs ADD COLUMN report_source text NOT NULL DEFAULT 'platform_verified' CHECK(report_source IN ('platform_verified','external_report'));
CREATE TABLE agent_provisioning_requests (
 tenant_id uuid NOT NULL, id uuid NOT NULL, created_by uuid NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
 principal_id uuid NOT NULL, installation_id uuid NOT NULL, status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','awaiting_activation','ready')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,created_by,idempotency_key),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE agent_credentials (
 tenant_id uuid NOT NULL,id uuid NOT NULL,installation_id uuid NOT NULL,secret_hash text NOT NULL,scopes jsonb NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by uuid NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,secret_hash),
 FOREIGN KEY(tenant_id,installation_id) REFERENCES agent_installations(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE TABLE agent_access_tokens (
 tenant_id uuid NOT NULL,id uuid NOT NULL,token_hash text NOT NULL,installation_id uuid NOT NULL,credential_id uuid NOT NULL,principal_id uuid NOT NULL,
 audience text NOT NULL,scopes jsonb NOT NULL,installation_revision bigint NOT NULL,credential_revision bigint NOT NULL,principal_version bigint NOT NULL,tenant_authz_revision bigint NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,token_hash),
 FOREIGN KEY(tenant_id,installation_id) REFERENCES agent_installations(tenant_id,id),
 FOREIGN KEY(tenant_id,credential_id) REFERENCES agent_credentials(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE INDEX agent_access_tokens_expiry ON agent_access_tokens(tenant_id,expires_at);
CREATE TABLE runtime_scan_cursors (
 tenant_id uuid NOT NULL,worker_id text NOT NULL,last_created_at timestamptz,last_run_id uuid,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,worker_id),FOREIGN KEY(tenant_id) REFERENCES tenants(id)
);
${tables.map(table=>`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
`;
export const agentTableNames:readonly string[]=[...tables];
