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
