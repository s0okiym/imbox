// A dedicated generation prevents unrelated workspace edits from superseding an independent tenant revocation.
export const tenantMembershipPolicySql = `
ALTER TABLE tenant_principals ADD COLUMN membership_policy_version bigint NOT NULL DEFAULT 1 CHECK (membership_policy_version > 0);
`;
