import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import {
  assertContract,
  definitions,
  schemas,
  type ContractTypes,
  type SchemaName,
} from '@imbox/contracts';
import { ApplicationError, type TaskService } from '@imbox/application';

const header = (r: FastifyRequest, name: string) => {
  const v = r.headers[name];
  if (typeof v !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return v;
};
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', header(r, 'idempotency-key'));
const version = (r: FastifyRequest) => {
  const value = header(r, 'if-match');
  if (!/^"[1-9][0-9]*"$/.test(value)) throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', value.slice(1, -1));
};
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
const page = (r: FastifyRequest) => {
  const q = r.query as { cursor?: string; limit?: string };
  const input = {
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(q.limit ? { limit: Number(q.limit) } : {}),
  };
  return assertContract('PaginationQuery', input);
};
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 4096 },
    limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' },
  },
};

/** Only this explicit route registration advertises the M2 implementation. */
export function registerTaskRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  tasks: TaskService,
) {
  const auth = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  function post<N extends SchemaName>(
    path: string,
    name: N,
    response: SchemaName,
    handler: (r: FastifyRequest, input: ContractTypes[N]) => Promise<unknown>,
    status: 200 | 201 = 200,
    method: 'POST' | 'PATCH' = 'POST',
  ) {
    app.route({
      method,
      url: path,
      schema: {
        ...(path.includes(':id') ? { params: schemas.ResourceParams } : {}),
        body: schemas[name],
        response: { [status]: schemas[response] },
      },
      handler: async (r, reply) => {
        const result = await handler(r, assertContract(name, r.body));
        const value = result as { version?: string; request?: { version: string } };
        if (value.version ?? value.request?.version)
          reply.header('ETag', `"${value.version ?? value.request?.version}"`);
        return reply.code(status).send(result);
      },
    });
  }
  app.get(
    '/v1/tasks',
    { schema: { querystring: querySchema, response: { 200: schemas.TaskPage } } },
    async (r) => tasks.listTasks(await auth(r), page(r)),
  );
  app.get(
    '/v1/tasks/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Task } } },
    async (r, reply) => {
      const t = await tasks.getTask(await auth(r), id(r));
      return reply.header('ETag', `"${t.version}"`).send(t);
    },
  );
  post(
    '/v1/agent-runs/:id/promote',
    'PromoteRunInput',
    'Task',
    async (r, input) => tasks.promoteRun(await auth(r), id(r), input, version(r), key(r)),
    201,
  );
  app.get(
    '/v1/tasks/:id/run-origin',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.TaskRunOrigin } } },
    async (r) => tasks.runOrigin(await auth(r), id(r)),
  );
  post(
    '/v1/tasks',
    'CreateTaskInput',
    'Task',
    async (r, input) => tasks.createTask(await auth(r), input, key(r)),
    201,
  );
  post(
    '/v1/tasks/:id',
    'UpdateTaskInput',
    'Task',
    async (r, input) => tasks.updateTask(await auth(r), id(r), input, version(r), key(r)),
    200,
    'PATCH',
  );
  app.get(
    '/v1/tasks/:id/participants',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.TaskParticipantPage } } },
    async (r) => tasks.participants(await auth(r), id(r)),
  );
  post('/v1/tasks/:id/participants', 'TaskParticipantInput', 'Task', async (r, input) =>
    tasks.changeParticipant(
      await auth(r),
      id(r),
      input.principal_id,
      input.role,
      version(r),
      key(r),
    ),
  );
  app.delete(
    '/v1/tasks/:id/participants/:principalId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'principalId'],
          properties: { id: definitions.Identifier, principalId: definitions.Identifier },
        },
        response: { 200: schemas.Task },
      },
    },
    async (r, reply) => {
      const p = r.params as { id: string; principalId: string };
      const t = await tasks.changeParticipant(
        await auth(r),
        p.id,
        p.principalId,
        null,
        version(r),
        key(r),
      );
      return reply.header('ETag', `"${t.version}"`).send(t);
    },
  );
  post('/v1/tasks/:id/conversation-links', 'TaskConversationLinkInput', 'Task', async (r, input) =>
    tasks.linkConversation(await auth(r), id(r), input, version(r), key(r)),
  );
  app.get(
    '/v1/conversations/:id/task-summaries',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.TaskSummaryPage } } },
    async (r) => tasks.conversationSummaries(await auth(r), id(r)),
  );
  post('/v1/tasks/:id/state', 'TaskStateInput', 'Task', async (r, input) =>
    tasks.changeState(await auth(r), id(r), input, version(r), key(r)),
  );
  post('/v1/tasks/:id/cancel', 'TaskReasonInput', 'Task', async (r, input) =>
    tasks.cancelTask(await auth(r), id(r), input, version(r), key(r)),
  );
  post('/v1/tasks/:id/reopen', 'ReopenTaskInput', 'Task', async (r, input) =>
    tasks.reopenTask(await auth(r), id(r), input, version(r), key(r)),
  );
  post('/v1/tasks/:id/takeover', 'TaskReasonInput', 'Task', async (r, input) =>
    tasks.takeover(await auth(r), id(r), input, version(r), key(r)),
  );
  post('/v1/tasks/:id/dependencies', 'TaskDependencyInput', 'Task', async (r, input) =>
    tasks.addDependency(await auth(r), id(r), input, version(r), key(r)),
  );
  post(
    '/v1/tasks/:id/requests',
    'CreateTaskRequestInput',
    'CollaborationRequest',
    async (r, input) => tasks.createRequest(await auth(r), id(r), input, version(r), key(r)),
    201,
  );
  app.get(
    '/v1/requests',
    { schema: { querystring: querySchema, response: { 200: schemas.CollaborationRequestPage } } },
    async (r) => tasks.listRequests(await auth(r), page(r)),
  );
  app.get(
    '/v1/requests/:id',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.CollaborationRequest } } },
    async (r, reply) => {
      const item = await tasks.getRequest(await auth(r), id(r));
      return reply.header('ETag', `"${item.version}"`).send(item);
    },
  );
  post(
    '/v1/requests/:id',
    'ReviseTaskRequestInput',
    'CollaborationRequest',
    async (r, input) => tasks.reviseRequest(await auth(r), id(r), input, version(r), key(r)),
    200,
    'PATCH',
  );
  post(
    '/v1/requests/:id/decisions',
    'RequestDecisionInput',
    'RequestDecisionResult',
    async (r, input) => tasks.decideRequest(await auth(r), id(r), input, version(r), key(r)),
  );
  post('/v1/requests/:id/withdraw', 'TaskReasonInput', 'CollaborationRequest', async (r, input) =>
    tasks.withdrawRequest(await auth(r), id(r), input, version(r), key(r)),
  );
  post(
    '/v1/tasks/:id/submissions',
    'SubmissionInput',
    'Submission',
    async (r, input) => tasks.submit(await auth(r), id(r), input, version(r), key(r)),
    201,
  );
  app.get(
    '/v1/tasks/:id/submissions',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.SubmissionPage } } },
    async (r) => tasks.submissions(await auth(r), id(r)),
  );
  post(
    '/v1/tasks/:id/reviews',
    'TaskReviewInput',
    'TaskReview',
    async (r, input) => tasks.review(await auth(r), id(r), input, version(r), key(r)),
    201,
  );
  app.get(
    '/v1/tasks/:id/reviews',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.TaskReviewPage } } },
    async (r) => tasks.reviews(await auth(r), id(r)),
  );
}
