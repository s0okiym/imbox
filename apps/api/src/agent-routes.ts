import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import type { AgentService } from '@imbox/agents';
import { assertContract, schemas, type SchemaName, type ContractTypes } from '@imbox/contracts';
import { ApplicationError, type MessagingService, type TaskService } from '@imbox/application';
import type { RuntimeService } from '@imbox/runtime';
const header = (r: FastifyRequest, name: string) => {
  const v = r.headers[name];
  if (typeof v !== 'string') throw new ApplicationError('VALIDATION_FAILED', 400);
  return v;
};
const key = (r: FastifyRequest) => assertContract('IdempotencyKey', header(r, 'idempotency-key'));
const id = (r: FastifyRequest) => assertContract('Identifier', (r.params as { id: unknown }).id);
const version = (r: FastifyRequest) => {
  const v = header(r, 'if-match');
  if (!/^"[1-9][0-9]{0,18}"$/.test(v)) throw new ApplicationError('VALIDATION_FAILED', 400);
  return assertContract('Version', v.slice(1, -1));
};
const empty = { type: 'object', additionalProperties: false, properties: {} };
const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 4096 },
    limit: { type: 'string', pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' },
  },
};
const page = (r: FastifyRequest) => {
  const q = r.query as { cursor?: string; limit?: string };
  return assertContract('PaginationQuery', {
    ...(q.cursor ? { cursor: q.cursor } : {}),
    ...(q.limit ? { limit: Number(q.limit) } : {}),
  });
};
export function registerAgentRoutes(
  app: FastifyInstance,
  options: {
    identity: IdentityService;
    agents: AgentService;
    runtime?: RuntimeService;
    messaging?: MessagingService;
    tasks?: TaskService;
  },
) {
  const { identity, agents, runtime, messaging, tasks } = options;
  const human = (r: FastifyRequest) => identity.authenticate(authenticationInput(r));
  const machine = (r: FastifyRequest, scope: string) => {
    if (r.headers.cookie !== undefined) throw new ApplicationError('UNAUTHENTICATED', 401);
    return agents.authenticate(
      typeof r.headers.authorization === 'string' ? r.headers.authorization : undefined,
      assertContract('Identifier', header(r, 'x-imbox-tenant-id')),
      scope,
    );
  };
  function post<N extends SchemaName>(
    path: string,
    input: N,
    response: SchemaName,
    handler: (r: FastifyRequest, body: ContractTypes[N]) => Promise<unknown>,
    status: 200 | 201 = 200,
  ) {
    app.post(
      path,
      {
        schema: {
          ...(path.includes(':id') ? { params: schemas.ResourceParams } : {}),
          body: schemas[input],
          response: { [status]: schemas[response] },
        },
      },
      async (r, reply) => reply.code(status).send(await handler(r, assertContract(input, r.body))),
    );
  }
  app.get(
    '/v1/agents',
    {
      schema: {
        querystring: schemas.AgentDirectoryQuery,
        response: { 200: schemas.AgentDirectory },
      },
    },
    async (r) =>
      agents.directory(
        await human(r),
        assertContract('Identifier', (r.query as { workspace_id: string }).workspace_id),
      ),
  );
  app.get(
    '/v1/agent-management',
    { schema: { response: { 200: schemas.AgentManagementAccess } } },
    async (r) => agents.managementAccess(await human(r)),
  );
  app.get(
    '/v1/agents/:id/credentials',
    {
      schema: {
        params: schemas.ResourceParams,
        querystring: pageQuery,
        response: { 200: schemas.AgentCredentialPage },
      },
    },
    async (r) => agents.credentials(await human(r), id(r), page(r)),
  );
  post(
    '/v1/agents',
    'RegisterAgentInput',
    'RegisteredAgent',
    async (r, b) => agents.register(await human(r), b, key(r)),
    201,
  );
  post(
    '/v1/agents/:id/credentials',
    'IssueAgentCredentialInput',
    'IssuedAgentCredential',
    async (r, b) => agents.issueCredential(await human(r), id(r), b, key(r)),
    201,
  );
  for (const operation of ['disable', 'revoke'] as const) {
    const path =
      operation === 'disable' ? '/v1/agents/:id/disable' : '/v1/agent-credentials/:id/revoke';
    app.post(
      path,
      {
        schema: {
          params: schemas.ResourceParams,
          body: empty,
          response: {
            200: schemas[operation === 'disable' ? 'RegisteredAgent' : 'AgentCredential'],
          },
        },
      },
      async (r) =>
        operation === 'disable'
          ? agents.disable(await human(r), id(r), key(r))
          : agents.revokeCredential(await human(r), id(r), key(r)),
    );
  }
  post('/v1/machine-tokens', 'MachineTokenInput', 'MachineToken', async (r, b) => {
    if (r.headers.cookie !== undefined || r.headers.authorization !== undefined)
      throw new ApplicationError('UNAUTHENTICATED', 401);
    return agents.exchange(b);
  });
  app.get(
    '/v1/machine/agents',
    {
      schema: {
        querystring: schemas.AgentDirectoryQuery,
        response: { 200: schemas.AgentDirectory },
      },
    },
    async (r) =>
      agents.directory(
        await machine(r, 'agents.read'),
        assertContract('Identifier', (r.query as { workspace_id: string }).workspace_id),
      ),
  );
  if (runtime) {
    app.get(
      '/v1/machine/agent-runs',
      { schema: { querystring: empty, response: { 200: schemas.MachineRunPage } } },
      async (r) => agents.listRuns(await machine(r, 'runs.read')),
    );
    post(
      '/v1/machine/agent-runs',
      'CreateRuntimeRunInput',
      'RuntimeRun',
      async (r, b) => {
        const a = await machine(r, 'runs.create');
        if (b.agent_id !== a.machine!.installationId) throw new ApplicationError('FORBIDDEN', 403);
        return runtime.createRun(a, b, key(r));
      },
      201,
    );
    app.get(
      '/v1/machine/agent-runs/:id',
      { schema: { params: schemas.ResourceParams, response: { 200: schemas.RuntimeRun } } },
      async (r) => runtime.getRun(await machine(r, 'runs.read'), id(r)),
    );
    app.get(
      '/v1/machine/agent-runs/:id/context-manifest',
      {
        schema: {
          params: schemas.ResourceParams,
          response: { 200: schemas.RuntimeContextManifest },
        },
      },
      async (r) => runtime.getContextManifest(await machine(r, 'runs.read'), id(r)),
    );
    app.post(
      '/v1/machine/agent-runs/:id/claim',
      {
        schema: {
          params: schemas.ResourceParams,
          body: empty,
          response: { 200: schemas.MachineClaim },
        },
      },
      async (r) => agents.claim(await machine(r, 'runs.execute'), id(r), key(r)),
    );
    post(
      '/v1/machine/agent-runs/:id/heartbeat',
      'MachineHeartbeatInput',
      'MachineHeartbeat',
      async (r, b) => agents.heartbeat(await machine(r, 'runs.execute'), id(r), b.generation),
    );
    post('/v1/machine/agent-runs/:id/reports', 'MachineReportInput', 'RuntimeRun', async (r, b) =>
      agents.report(await machine(r, 'runs.report'), id(r), b, key(r)),
    );
  }
  if (messaging) {
    app.get(
      '/v1/machine/conversations',
      { schema: { querystring: pageQuery, response: { 200: schemas.ConversationPage } } },
      async (r) => messaging.listConversations(await machine(r, 'messages.read'), page(r)),
    );
    app.get(
      '/v1/machine/conversations/:id/messages',
      {
        schema: {
          params: schemas.ResourceParams,
          querystring: pageQuery,
          response: { 200: schemas.MessagePage },
        },
      },
      async (r) => messaging.listMessages(await machine(r, 'messages.read'), id(r), page(r)),
    );
    post(
      '/v1/machine/conversations/:id/messages',
      'CreateMessageInput',
      'Message',
      async (r, b) => messaging.createMessage(await machine(r, 'messages.write'), id(r), b, key(r)),
      201,
    );
  }
  if (tasks) {
    app.get(
      '/v1/machine/tasks',
      { schema: { querystring: pageQuery, response: { 200: schemas.TaskPage } } },
      async (r) => tasks.listTasks(await machine(r, 'tasks.read'), page(r)),
    );
    app.get(
      '/v1/machine/tasks/:id',
      { schema: { params: schemas.ResourceParams, response: { 200: schemas.Task } } },
      async (r) => tasks.getTask(await machine(r, 'tasks.read'), id(r)),
    );
    app.get(
      '/v1/machine/tasks/:id/handoff-actions',
      { schema: { params: schemas.ResourceParams, response: { 200: schemas.TaskHandoffActions } } },
      async (r) => tasks.handoffActions(await machine(r, 'tasks.read'), id(r)),
    );
    post(
      '/v1/machine/tasks',
      'CreateTaskInput',
      'Task',
      async (r, b) => tasks.createTask(await machine(r, 'tasks.create'), b, key(r)),
      201,
    );
    post('/v1/machine/tasks/:id/state', 'TaskStateInput', 'Task', async (r, b) =>
      tasks.changeState(await machine(r, 'tasks.write'), id(r), b, version(r), key(r)),
    );
    post(
      '/v1/machine/tasks/:id/requests',
      'CreateTaskRequestInput',
      'CollaborationRequest',
      async (r, b) =>
        tasks.createRequest(await machine(r, 'tasks.write'), id(r), b, version(r), key(r)),
      201,
    );
    post(
      '/v1/machine/tasks/:id/submissions',
      'SubmissionInput',
      'Submission',
      async (r, b) => tasks.submit(await machine(r, 'tasks.write'), id(r), b, version(r), key(r)),
      201,
    );
    app.get(
      '/v1/machine/requests',
      { schema: { querystring: pageQuery, response: { 200: schemas.CollaborationRequestPage } } },
      async (r) => tasks.listRequests(await machine(r, 'requests.read'), page(r)),
    );
    app.get(
      '/v1/machine/requests/:id',
      {
        schema: { params: schemas.ResourceParams, response: { 200: schemas.CollaborationRequest } },
      },
      async (r) => tasks.getRequest(await machine(r, 'requests.read'), id(r)),
    );
    post(
      '/v1/machine/requests/:id/ack',
      'AgentDeliveryInput',
      'AgentDeliveryReceipt',
      async (r, b) =>
        tasks.acknowledgeRequest(
          await machine(r, 'requests.ack'),
          id(r),
          b.proposal_version,
          key(r),
        ),
    );
    post(
      '/v1/machine/requests/:id/decisions',
      'RequestDecisionInput',
      'RequestDecisionResult',
      async (r, b) =>
        tasks.decideRequest(await machine(r, 'requests.decide'), id(r), b, version(r), key(r)),
    );
  }
}
