import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError, type OrganizationService } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';

export function registerOrganizationRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  organization: OrganizationService,
) {
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
  const key = (r: FastifyRequest) => assertContract('IdempotencyKey', r.headers['idempotency-key']);
  const page = (r: FastifyRequest) => {
    const q = r.query as { cursor?: string; limit?: string };
    return assertContract('PaginationQuery', {
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
  };
  const querystring = {
    type: 'object',
    additionalProperties: false,
    properties: {
      cursor: { type: 'string', maxLength: 4096 },
      limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' },
    },
  };
  app.get(
    '/v1/organization/access',
    { schema: { response: { 200: schemas.OrganizationManagementAccess } } },
    async (r) => organization.access(await auth(r)),
  );
  app.get(
    '/v1/organization/workspaces',
    { schema: { querystring, response: { 200: schemas.ManagedWorkspacePage } } },
    async (r) => organization.listWorkspaces(await auth(r), page(r)),
  );
  app.get(
    '/v1/organization/candidates',
    { schema: { querystring, response: { 200: schemas.OrganizationCandidatePage } } },
    async (r) => organization.candidates(await auth(r), page(r)),
  );
  app.get(
    '/v1/organization/workspaces/:id/members',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring,
        response: { 200: schemas.ManagedWorkspaceMemberPage },
      },
    },
    async (r) => organization.members(await auth(r), id(r), page(r)),
  );
  app.post(
    '/v1/organization/workspaces',
    {
      schema: {
        body: schemas.CreateManagedWorkspaceInput,
        response: { 201: schemas.ManagedWorkspace },
      },
    },
    async (r, reply) =>
      reply
        .code(201)
        .send(
          await organization.createWorkspace(
            await auth(r),
            assertContract('CreateManagedWorkspaceInput', r.body),
            key(r),
          ),
        ),
  );
  app.put(
    '/v1/organization/workspaces/:id/members',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.SetWorkspaceMemberInput,
        response: { 200: schemas.ManagedWorkspace },
      },
    },
    async (r) => {
      const a = await auth(r);
      const match = r.headers['if-match'];
      if (typeof match !== 'string' || !/^"[1-9][0-9]*"$/.test(match))
        throw new ApplicationError('VALIDATION_FAILED', 400);
      return organization.setMember(
        a,
        id(r),
        assertContract('SetWorkspaceMemberInput', r.body),
        assertContract('Version', match.slice(1, -1)),
        key(r),
      );
    },
  );
}
