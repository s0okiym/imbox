import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { assertContract, schemas } from '@imbox/contracts';
import { ApplicationError } from '@imbox/application';
import type { KnowledgeService, KnowledgeSearchQuery } from '@imbox/knowledge';
const key = (request: FastifyRequest) =>
  assertContract('IdempotencyKey', request.headers['idempotency-key']);
const id = (request: FastifyRequest) =>
  assertContract('Identifier', (request.params as { id: unknown }).id);
const version = (request: FastifyRequest) => {
  const match = request.headers['if-match'];
  if (typeof match !== 'string' || !/^"[1-9][0-9]*"$/.test(match))
    throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', match.slice(1, -1));
};
const commonQuery = {
  conversation_id: { type: 'string', format: 'uuid' },
  task_id: { type: 'string', format: 'uuid' },
  cursor: { type: 'string', minLength: 1, maxLength: 4096 },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
};
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; knowledge: KnowledgeService },
) {
  const { identity, knowledge } = options;
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  app.post(
    '/v1/memories',
    { schema: { body: schemas.CreateMemoryInput, response: { 201: schemas.ExplicitMemory } } },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          assertContract(
            'ExplicitMemory',
            await knowledge.createMemory(
              await auth(request),
              assertContract('CreateMemoryInput', request.body),
              key(request),
            ),
          ),
        ),
  );
  app.patch(
    '/v1/memories/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.UpdateMemoryInput,
        response: { 200: schemas.ExplicitMemory },
      },
    },
    async (request) =>
      assertContract(
        'ExplicitMemory',
        await knowledge.updateMemory(
          await auth(request),
          id(request),
          assertContract('UpdateMemoryInput', request.body),
          version(request),
          key(request),
        ),
      ),
  );
  app.get(
    '/v1/memories/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.ExplicitMemory } } },
    async (request) =>
      assertContract('ExplicitMemory', await knowledge.getMemory(await auth(request), id(request))),
  );
  app.delete(
    '/v1/memories/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.MemoryDeletion } } },
    async (request) =>
      assertContract(
        'MemoryDeletion',
        await knowledge.deleteMemory(
          await auth(request),
          id(request),
          version(request),
          key(request),
        ),
      ),
  );
  app.get(
    '/v1/memories',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: commonQuery },
        response: { 200: schemas.ExplicitMemoryPage },
      },
    },
    async (request) => {
      const query = request.query as {
        conversation_id?: string;
        task_id?: string;
        cursor?: string;
        limit?: string;
      };
      return assertContract(
        'ExplicitMemoryPage',
        await knowledge.listMemories(await auth(request), {
          ...(query.conversation_id ? { conversation_id: query.conversation_id } : {}),
          ...(query.task_id ? { task_id: query.task_id } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit ? { limit: Number(query.limit) } : {}),
        }),
      );
    },
  );
  app.get(
    '/v1/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            ...commonQuery,
            q: { type: 'string', minLength: 2, maxLength: 200 },
            workspace_id: { type: 'string', format: 'uuid' },
            kind: { type: 'string', enum: ['message', 'task', 'artifact_version', 'memory'] },
          },
        },
        response: { 200: schemas.KnowledgeSearchPage },
      },
    },
    async (request) => {
      const query = request.query as Omit<KnowledgeSearchQuery, 'limit'> & { limit?: string };
      const parsed = assertContract('KnowledgeSearchQuery', {
        ...query,
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      });
      return assertContract(
        'KnowledgeSearchPage',
        await knowledge.search(await auth(request), parsed),
      );
    },
  );
}
