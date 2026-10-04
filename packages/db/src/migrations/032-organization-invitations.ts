export const organizationInvitationsSql = `
CREATE TABLE organization_invitations (
 tenant_id uuid NOT NULL REFERENCES tenants(id),id uuid NOT NULL,principal_id uuid NOT NULL REFERENCES principals(id),workspace_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('member','guest')),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
 code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),created_by uuid NOT NULL,creator_authz_revision bigint NOT NULL CHECK(creator_authz_revision>0),creator_principal_version bigint NOT NULL CHECK(creator_principal_version>0),
 expires_at timestamptz NOT NULL,version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id),FOREIGN KEY(tenant_id,created_by) REFERENCES tenant_principals(tenant_id,principal_id)
);
CREATE UNIQUE INDEX organization_invitations_pending_recipient ON organization_invitations(tenant_id,principal_id) WHERE status='pending';
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_invitations_tenant_isolation ON organization_invitations USING(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting('imbox.tenant_id',true),'')::uuid);
`;
export const organizationInvitationTableNames = ['organization_invitations'] as const;
