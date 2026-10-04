const tables = ['policy_receipts','governance_exports'] as const;
export const governanceSql = `
CREATE TABLE policy_receipts (
 tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,kind text NOT NULL,target_id uuid NOT NULL,actor_id uuid NOT NULL,
 accepted_at timestamptz NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id)
);
CREATE INDEX policy_receipts_target ON policy_receipts(tenant_id,kind,target_id);
CREATE TABLE governance_exports (
 tenant_id uuid NOT NULL,id uuid NOT NULL,created_by uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('conversation','task','personal')),
 scope_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id),CHECK((scope='personal')=(scope_id IS NULL))
);
${tables.map(table=>`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_isolation ON ${table} USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);`).join('\n')}
`;
export const governanceTableNames: readonly string[] = [...tables];
