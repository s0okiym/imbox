// Operator-only receipts. Deliberately excluded from application/identity role grants.
export const workspaceProvisioningSql = `
CREATE TABLE workspace_provisioning_receipts (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  workspace_id uuid NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 200),
  change_reference text NOT NULL CHECK (length(change_reference) BETWEEN 1 AND 200),
  database_actor text NOT NULL DEFAULT session_user,
  member_count integer NOT NULL CHECK (member_count BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id)
);
REVOKE ALL ON workspace_provisioning_receipts FROM PUBLIC;
`;
