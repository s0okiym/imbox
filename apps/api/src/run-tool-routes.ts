import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentService } from '@imbox/agents';
import { authenticationInput, type IdentityService } from '@imbox/auth';
import { createToolRunner, type ActionService } from '@imbox/actions';
import { ApplicationError, type AuthContext } from '@imbox/application';
import { assertContract, schemas } from '@imbox/contracts';
import type { LeaseClaim } from '@imbox/runtime';

/** A machine can propose/execute only within a lease. It cannot approve or resume a waiting Run. */
export function registerRunToolRoutes(
  app: FastifyInstance,
  options: { identity: IdentityService; agents: AgentService; actions: ActionService },
) {
  const runId = (r: FastifyRequest) =>
    assertContract('Identifier', (r.params as { id: string }).id);
  const key = (r: FastifyRequest) => assertContract('IdempotencyKey', r.headers['idempotency-key']);
  const machine = (r: FastifyRequest) => {
    if (r.headers.cookie !== undefined) throw new ApplicationError('UNAUTHENTICATED', 401);
    return options.agents.authenticate(
      typeof r.headers.authorization === 'string' ? r.headers.authorization : undefined,
      assertContract('Identifier', r.headers['x-imbox-tenant-id']),
      'runs.tools',
    );
  };
  const lease = (auth: AuthContext, id: string, generation: string): LeaseClaim => ({
    tenantId: auth.tenantId,
    runId: id,
    generation,
    holder: `external:${auth.machine!.installationId}:${auth.machine!.credentialId}`,
  });
  app.get(
    '/v1/agent-runs/:id/tool-intent',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Action } } },
    async (r) =>
      options.actions.getRunIntent(
        await options.identity.authenticate(authenticationInput(r)),
        runId(r),
      ),
  );
  app.get(
    '/v1/machine/agent-runs/:id/tool-intent',
    { schema: { params: schemas.ResourceParams, response: { 200: schemas.Action } } },
    async (r) => options.actions.getRunIntent(await machine(r), runId(r)),
  );
  app.post(
    '/v1/machine/agent-runs/:id/tool-intents',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.MachineToolIntentInput,
        response: { 201: schemas.Action },
      },
    },
    async (r, reply) => {
      key(r);
      const auth = await machine(r),
        body = assertContract('MachineToolIntentInput', r.body);
      return reply
        .code(201)
        .send(
          await options.actions.proposeForRun(
            lease(auth, runId(r), body.generation),
            body.text,
            auth,
          ),
        );
    },
  );
  app.post(
    '/v1/machine/agent-runs/:id/tool-execution',
    {
      schema: {
        params: schemas.ResourceParams,
        body: schemas.MachineToolExecuteInput,
        response: { 200: schemas.Action },
      },
    },
    async (r) => {
      key(r);
      const auth = await machine(r),
        body = assertContract('MachineToolExecuteInput', r.body),
        claim = lease(auth, runId(r), body.generation);
      const action = await options.actions.getRunToolAction(claim, auth);
      if (action.status === 'ready')
        await createToolRunner({
          actions: options.actions,
          workerId: `machine-tool.${claim.runId}.${claim.generation}`,
        }).runOnce(auth.tenantId, action.id, claim, auth);
      else if (!['succeeded', 'failed', 'cancelled'].includes(action.status))
        throw new ApplicationError(
          action.status === 'unknown' ? 'ACTION_OUTCOME_UNKNOWN' : 'VERSION_CONFLICT',
          409,
        );
      return options.actions.getRunToolAction(claim, auth);
    },
  );
}
