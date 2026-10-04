import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
import type { RuntimeService } from '@imbox/runtime';
const header = (r: FastifyRequest, name: string) => {
  const value = r.headers[name];
  if (typeof value !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return value;
};
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', header(r, 'idempotency-key'));
const resource = (r: FastifyRequest) =>
  assertContract('Identifier', (r.params as { id: string }).id);
export async function registerRuntimeRoutes(
  app: FastifyInstance,
  { identity, runtime }: { identity: IdentityService; runtime: RuntimeService },
) {
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  app.get(
    '/v1/agent-runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            task_id: { type: 'string', format: 'uuid' },
            conversation_id: { type: 'string', format: 'uuid' },
            cursor: { type: 'string', maxLength: 4096 },
            limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|100)$' },
          },
        },
        response: { 200: schemas.RuntimeRunPage },
      },
    },
    async (r) => {
      const q = r.query as {
        task_id?: string;
        conversation_id?: string;
        cursor?: string;
        limit?: string;
      };
      const parsed = assertContract('RuntimeRunListQuery', {
        ...q,
        ...(q.limit ? { limit: Number(q.limit) } : {}),
      });
      return runtime.listRuns(
        await auth(r),
        {
          ...(parsed.task_id ? { task_id: parsed.task_id } : {}),
          ...(parsed.conversation_id ? { conversation_id: parsed.conversation_id } : {}),
        },
        {
          ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
          ...(parsed.limit ? { limit: parsed.limit } : {}),
        },
      );
    },
  );
  app.post(
    '/v1/agent-installations',
    {
      schema: {
        body: schemas.InstallRuntimeAgentInput,
        response: { 201: schemas.RuntimeAgentInstallation },
      },
    },
    async (r, reply) =>
      reply
        .code(201)
        .send(
          await runtime.installAgent(
            await auth(r),
            assertContract('InstallRuntimeAgentInput', r.body),
            key(r),
          ),
        ),
  );
  app.post(
    '/v1/agent-runs',
    { schema: { body: schemas.CreateRuntimeRunInput, response: { 201: schemas.RuntimeRun } } },
    async (r, reply) => {
      const run = await runtime.createRun(
        await auth(r),
        assertContract('CreateRuntimeRunInput', r.body),
        key(r),
      );
      return reply.code(201).header('ETag', `"${run.version}"`).send(run);
    },
  );
  app.get(
    '/v1/agent-runs/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.RuntimeRun } } },
    async (r, reply) => {
      const run = await runtime.getRun(await auth(r), resource(r));
      return reply.header('ETag', `"${run.version}"`).send(run);
    },
  );
  app.get(
    '/v1/agent-runs/:id/context-manifest',
    {
      schema: { params: schemas.ResourceParams, response: { 200: schemas.RuntimeContextManifest } },
    },
    async (r) => runtime.getContextManifest(await auth(r), resource(r)),
  );
  for (const action of ['pause', 'resume', 'cancel'] as const)
    app.post(
      `/v1/agent-runs/:id/${action}`,
      { schema: { params: schemas.ResourceParams, response: { 200: schemas.RuntimeRun } } },
      async (r, reply) => {
        if (
          r.body !== undefined &&
          (!r.body ||
            typeof r.body !== 'object' ||
            Array.isArray(r.body) ||
            Object.keys(r.body).length)
        )
          throw new ApplicationError('VALIDATION_FAILED', 400);
        const expected = header(r, 'if-match');
        if (!/^"[1-9][0-9]{0,18}"$/.test(expected))
          throw new ApplicationError('VALIDATION_FAILED', 400);
        const run = await runtime.controlRun(
          await auth(r),
          resource(r),
          action,
          assertContract('Version', expected.slice(1, -1)),
          key(r),
        );
        return reply.header('ETag', `"${run.version}"`).send(run);
      },
    );
  // Internal worker capabilities never become ordinary authenticated user routes.
}
