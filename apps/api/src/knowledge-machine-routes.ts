import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentService } from '@imbox/agents';
import type { KnowledgeService } from '@imbox/knowledge';
import { ApplicationError } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';

/** Machine knowledge access remains subject to the same live source permissions as humans. */
export function registerKnowledgeMachineRoutes(
  app: FastifyInstance,
  agents: AgentService,
  knowledge: KnowledgeService,
) {
  const auth = (r: FastifyRequest, scope: string) => {
    if (r.headers.cookie !== undefined) throw new ApplicationError('UNAUTHENTICATED', 401);
    return agents.authenticate(
      typeof r.headers.authorization === 'string' ? r.headers.authorization : undefined,
      assertContract('Identifier', r.headers['x-imbox-tenant-id']),
      scope,
    );
  };
  const properties = {
    conversation_id: { type: 'string', format: 'uuid' },
    task_id: { type: 'string', format: 'uuid' },
    cursor: { type: 'string', minLength: 1, maxLength: 4096 },
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
  };
  const query = (r: FastifyRequest) => {
    const q = r.query as Record<string, string>;
    return { ...q, ...(q.limit ? { limit: Number(q.limit) } : {}) };
  };
  app.get(
    '/v1/machine/memories/:id',
    {
      schema: { params: schemas.ResourceParams, response: { 200: schemas.ExplicitMemory } },
    },
    async (r) =>
      knowledge.getMemory(
        await auth(r, 'knowledge.read'),
        assertContract('Identifier', (r.params as { id: string }).id),
      ),
  );
  app.get(
    '/v1/machine/memories',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties },
        response: { 200: schemas.ExplicitMemoryPage },
      },
    },
    async (r) => knowledge.listMemories(await auth(r, 'knowledge.read'), query(r)),
  );
  app.get(
    '/v1/machine/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            ...properties,
            q: { type: 'string', minLength: 2, maxLength: 200 },
            workspace_id: { type: 'string', format: 'uuid' },
            kind: { type: 'string', enum: ['message', 'task', 'artifact_version', 'memory'] },
          },
        },
        response: { 200: schemas.KnowledgeSearchPage },
      },
    },
    async (r) =>
      knowledge.search(
        await auth(r, 'knowledge.search'),
        assertContract('KnowledgeSearchQuery', query(r)),
      ),
  );
}
