import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { assertContract, schemas } from '@imbox/contracts';
import { ApplicationError, type MessagingService, type PageQuery } from '@imbox/application';

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return value;
}
function version(request: FastifyRequest): string {
  const value = header(request, 'if-match');
  if (!/^"[1-9][0-9]{0,18}"$/.test(value)) throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
}
function resourceId(request: FastifyRequest): string {
  // Fastify route parameters have a framework prototype, unlike parsed JSON bodies.
  return assertContract('Identifier', (request.params as { id: unknown }).id);
}
function page(request: FastifyRequest): PageQuery {
  const input = request.query as { cursor?: unknown; limit?: unknown };
  const value = {
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
  };
  return assertContract('PaginationQuery', value);
}
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 4096 },
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
  },
};

export async function registerMessagingRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; messaging: MessagingService },
): Promise<void> {
  const { identity, messaging } = options;
  const auth = (request: FastifyRequest) => identity.authenticate(authenticationInput(request));
  app.get('/v1/workspaces', async (request) => messaging.listWorkspaces(await auth(request)));
  app.get(
    '/v1/workspaces/:id/members',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.WorkspaceMemberPage } } },
    async (request) => messaging.workspaceMembers(await auth(request), resourceId(request)),
  );
  app.get(
    '/v1/conversations',
    { schema: { querystring: querySchema, response: { 200: schemas.ConversationPage } } },
    async (request) => messaging.listConversations(await auth(request), page(request)),
  );
  app.post(
    '/v1/conversations',
    { schema: { body: schemas.CreateConversationInput, response: { 201: schemas.Conversation } } },
    async (request, reply) => {
      const result = await messaging.createConversation(
        await auth(request),
        assertContract('CreateConversationInput', request.body),
        header(request, 'idempotency-key'),
      );
      return reply.code(201).header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.get(
    '/v1/conversations/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Conversation } } },
    async (request, reply) => {
      const result = await messaging.getConversation(await auth(request), resourceId(request));
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.get(
    '/v1/conversations/:id/members',
    {
      schema: { params: schemas.ResourceParams, response: { 200: schemas.ConversationMemberPage } },
    },
    async (request) => messaging.conversationMembers(await auth(request), resourceId(request)),
  );
  app.post(
    '/v1/conversations/:id/members',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.AddConversationMemberInput,
        response: { 200: schemas.Conversation },
      },
    },
    async (request, reply) => {
      const input = assertContract('AddConversationMemberInput', request.body);
      const result = await messaging.changeMember(
        await auth(request),
        resourceId(request),
        input.principal_id,
        'add',
        version(request),
        header(request, 'idempotency-key'),
        input.role,
      );
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.delete('/v1/conversations/:id/members/:principalId', async (request, reply) => {
    const params = request.params as { id: string; principalId: string };
    assertContract('Identifier', params.id);
    assertContract('Identifier', params.principalId);
    const result = await messaging.changeMember(
      await auth(request),
      params.id,
      params.principalId,
      'remove',
      version(request),
      header(request, 'idempotency-key'),
    );
    return reply.header('ETag', `"${result.version}"`).send(result);
  });
  app.get(
    '/v1/conversations/:id/messages',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: querySchema,
        response: { 200: schemas.MessagePage },
      },
    },
    async (request) =>
      messaging.listMessages(await auth(request), resourceId(request), page(request)),
  );
  app.post(
    '/v1/conversations/:id/messages',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.CreateMessageInput,
        response: { 201: schemas.Message },
      },
    },
    async (request, reply) => {
      const result = await messaging.createMessage(
        await auth(request),
        resourceId(request),
        assertContract('CreateMessageInput', request.body),
        header(request, 'idempotency-key'),
      );
      return reply.code(201).header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.get(
    '/v1/messages/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Message } } },
    async (request, reply) => {
      const m = await messaging.getMessage(await auth(request), resourceId(request));
      return reply.header('ETag', `"${m.version}"`).send(m);
    },
  );
  app.get(
    '/v1/messages/:id/thread',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: querySchema,
        response: { 200: schemas.MessagePage },
      },
    },
    async (request) =>
      messaging.listThread(await auth(request), resourceId(request), page(request)),
  );
  app.get(
    '/v1/messages/:id/reactions',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: querySchema,
        response: { 200: schemas.ReactionPage },
      },
    },
    async (request) =>
      messaging.listReactions(await auth(request), resourceId(request), page(request)),
  );
  for (const present of [true, false])
    app.post(
      `/v1/messages/:id/reactions${present ? '' : '/remove'}`,
      {
        schema: {
          params: schemas.ResourceParams,
          body: schemas.ReactionInput,
          response: { 200: schemas.Message },
        },
      },
      async (request, reply) => {
        const m = await messaging.setReaction(
          await auth(request),
          resourceId(request),
          assertContract('ReactionInput', request.body),
          present,
          header(request, 'idempotency-key'),
        );
        return reply.header('ETag', `"${m.version}"`).send(m);
      },
    );
  app.patch(
    '/v1/messages/:id',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.EditMessageInput,
        response: { 200: schemas.Message },
      },
    },
    async (request, reply) => {
      const result = await messaging.changeMessage(
        await auth(request),
        resourceId(request),
        assertContract('EditMessageInput', request.body),
        version(request),
        header(request, 'idempotency-key'),
      );
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.delete(
    '/v1/messages/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Message } } },
    async (request, reply) => {
      const result = await messaging.changeMessage(
        await auth(request),
        resourceId(request),
        null,
        version(request),
        header(request, 'idempotency-key'),
      );
      return reply.header('ETag', `"${result.version}"`).send(result);
    },
  );
  app.post(
    '/v1/conversations/:id/read-cursor',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.ReadCursorInput,
        response: { 200: schemas.ReadCursor },
      },
    },
    async (request) => {
      const input = assertContract('ReadCursorInput', request.body);
      return messaging.markRead(
        await auth(request),
        resourceId(request),
        input.last_read_seq,
        header(request, 'idempotency-key'),
      );
    },
  );
}
