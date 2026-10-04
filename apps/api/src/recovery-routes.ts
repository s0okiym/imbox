import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
import type { ActionService } from '@imbox/actions';
const header = (r: FastifyRequest, name: string): string => {
  const value = r.headers[name];
  if (typeof value !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return value;
};
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', header(r, 'idempotency-key'));
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: string }).id);
const version = (r: FastifyRequest) => {
  const value = header(r, 'if-match');
  if (!/^"[1-9][0-9]{0,18}"$/.test(value)) throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
};
export async function registerRecoveryRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; actions: ActionService },
): Promise<void> {
  const auth = (r: FastifyRequest) => options.identity.authenticate(authenticationInput(r));
  const recovery = options.actions.recovery;
  app.get(
    '/v1/action-recovery',
    { schema: { response: { 200: schemas.RecoveryStatus } } },
    async (r, reply) => {
      const result = await recovery.status(await auth(r));
      return reply.header('ETag', `"${result.revision}"`).send(result);
    },
  );
  app.post(
    '/v1/action-recovery/refresh',
    { schema: { body: schemas.RecoveryReasonInput, response: { 200: schemas.RecoveryStatus } } },
    async (r, reply) => {
      const result = await recovery.refresh(
        await auth(r),
        assertContract('RecoveryReasonInput', r.body),
        key(r),
      );
      return reply.header('ETag', `"${result.revision}"`).send(result);
    },
  );
  app.get(
    '/v1/action-recovery/cases',
    {
      schema: { querystring: schemas.CursorOnlyQuery, response: { 200: schemas.RecoveryCasePage } },
    },
    async (r) => {
      const q = assertContract('CursorOnlyQuery', r.query);
      return recovery.list(await auth(r), q.cursor);
    },
  );
  app.get(
    '/v1/action-recovery/cases/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.RecoveryCase } } },
    async (r, reply) => {
      const result = await recovery.get(await auth(r), id(r));
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.post(
    '/v1/action-recovery/cases/:id/lookup',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.RecoveryLookupInput,
        response: { 200: schemas.RecoveryEvidence },
      },
    },
    async (r) => recovery.lookup(await auth(r), id(r), key(r)),
  );
  app.post(
    '/v1/action-recovery/cases/:id/confirm',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.RecoveryConfirmInput,
        response: { 200: schemas.RecoveryCase },
      },
    },
    async (r, reply) => {
      const result = await recovery.confirm(
        await auth(r),
        id(r),
        assertContract('RecoveryConfirmInput', r.body),
        version(r),
        key(r),
      );
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.post(
    '/v1/action-recovery/unfreeze',
    { schema: { body: schemas.RecoveryUnfreezeInput, response: { 200: schemas.RecoveryStatus } } },
    async (r, reply) => {
      const result = await recovery.unfreeze(
        await auth(r),
        assertContract('RecoveryUnfreezeInput', r.body),
        version(r),
        key(r),
      );
      return reply.header('ETag', `"${result.revision}"`).send(result);
    },
  );
}
