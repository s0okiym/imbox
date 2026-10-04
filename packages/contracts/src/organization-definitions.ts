const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const page = (item: string) =>
  object(
    {
      items: { type: 'array', items: ref(item), maxItems: 100 },
      next_cursor: ref('Cursor'),
    },
    ['items'],
  );
export const organizationDefinitions = {
  OrganizationInvitationPreview: object({
    invitation_id: ref('Identifier'),
    tenant_id: ref('Identifier'),
    tenant_name: { type: 'string', minLength: 1, maxLength: 200 },
    workspace_id: ref('Identifier'),
    workspace_name: { type: 'string', minLength: 1, maxLength: 200 },
    role: { enum: ['member', 'guest'] },
    status: { enum: ['pending', 'accepted'] },
    expires_at: ref('UtcTimestamp'),
  }),
  OrganizationInvitation: object({
    id: ref('Identifier'),
    principal_id: ref('Identifier'),
    workspace_id: ref('Identifier'),
    role: { enum: ['member', 'guest'] },
    status: { enum: ['pending', 'accepted', 'revoked', 'expired'] },
    version: ref('Version'),
    expires_at: ref('UtcTimestamp'),
    created_by: ref('Identifier'),
  }),
  OrganizationInvitationPage: page('OrganizationInvitation'),
  CreateOrganizationInvitationInput: object({
    principal_id: ref('Identifier'),
    workspace_id: ref('Identifier'),
    role: { enum: ['member', 'guest'] },
    expires_in_hours: { type: 'integer', minimum: 1, maximum: 168 },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
  CreatedOrganizationInvitation: object(
    {
      invitation: ref('OrganizationInvitation'),
      code: { type: 'string', minLength: 1, maxLength: 300 },
    },
    ['invitation'],
  ),
  RevokeOrganizationInvitationInput: object({
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
  AcceptOrganizationInvitationInput: object({
    code: { type: 'string', minLength: 1, maxLength: 300 },
  }),
  AcceptedOrganizationInvitation: object({
    invitation_id: ref('Identifier'),
    tenant_id: ref('Identifier'),
    workspace_id: ref('Identifier'),
  }),
  ManagedTenantMember: object({
    principal: ref('Principal'),
    role: { enum: ['owner', 'admin', 'member', 'guest', 'agent'] },
    status: { enum: ['active', 'disabled', 'historical'] },
    version: ref('Version'),
  }),
  ManagedTenantMemberPage: page('ManagedTenantMember'),
  SetTenantMemberInput: object({
    role: { enum: ['owner', 'admin', 'member', 'guest'] },
    status: { enum: ['active', 'disabled'] },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
  OrganizationManagementAccess: object({ can_manage: { type: 'boolean' } }),
  ManagedWorkspace: object({
    id: ref('Identifier'),
    name: { type: 'string', minLength: 1, maxLength: 200 },
    version: ref('Version'),
  }),
  ManagedWorkspacePage: page('ManagedWorkspace'),
  OrganizationCandidate: object({
    principal: ref('Principal'),
    tenant_role: { enum: ['owner', 'admin', 'member', 'guest'] },
  }),
  OrganizationCandidatePage: page('OrganizationCandidate'),
  ManagedWorkspaceMember: object({
    principal: ref('Principal'),
    role: { enum: ['admin', 'member', 'guest'] },
    status: { enum: ['active', 'disabled'] },
    version: ref('Version'),
    tenant_status: { enum: ['active', 'disabled', 'historical'] },
  }),
  ManagedWorkspaceMemberPage: page('ManagedWorkspaceMember'),
  CreateManagedWorkspaceInput: object({ name: { type: 'string', minLength: 1, maxLength: 120 } }),
  SetWorkspaceMemberInput: object({
    principal_id: ref('Identifier'),
    role: { enum: ['admin', 'member', 'guest'] },
    status: { enum: ['active', 'disabled'] },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
  }),
};
