import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { assertContract, schemas } from '@imbox/contracts';
import type { GovernanceService } from '@imbox/governance';
export function registerGovernanceRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  governance: GovernanceService,
) {
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: string }).id);
  app.get(
    '/v1/governance/policy',
    { schema: { response: { 200: schemas.GovernancePolicy } } },
    async (r) => governance.policy(await auth(r)),
  );
  app.post(
    '/v1/exports',
    { schema: { body: schemas.CreateExportInput, response: { 201: schemas.ExportJob } } },
    async (r, reply) =>
      reply
        .code(201)
        .send(
          await governance.createExport(
            await auth(r),
            assertContract('CreateExportInput', r.body),
            assertContract('IdempotencyKey', r.headers['idempotency-key']),
          ),
        ),
  );
  app.get(
    '/v1/exports/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.ExportJob } } },
    async (r) => governance.getExport(await auth(r), id(r)),
  );
  app.get(
    '/v1/exports/:id/content',
    { schema: { params: schemas.ResourceParams } },
    async (r, reply) => {
      const content = await governance.content(await auth(r), id(r), () => auth(r));
      return reply
        .type('application/x-ndjson')
        .header('Content-Disposition', `attachment; filename="imbox-${id(r)}.ndjson"`)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(content.stream);
    },
  );
}
