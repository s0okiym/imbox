import type { RuntimeSourcePort } from '@imbox/application';
import { bindRunToolGrant, assertRunToolProgress, cancelPendingRunTool } from './tool-intents.js';
import { RUNTIME_LIMITS } from './limits.js';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  appendEvent,
  authorizeConversation,
  authorizeTenant,
  command,
  CursorCodec,
  type AuthContext,
} from '@imbox/application';
import { sql, type Db } from '@imbox/db';
import { isTerminalRunStatus } from '@imbox/domain';
import {
  fail,
  activeChain,
  ancestry,
  hash,
  id,
  installation,
  json,
  liveActors,
  money,
  runRow,
  source,
  taskAccess,
  verifyContext,
  principal,
  scopeAuthorization,
  runtimeTransaction,
} from './shared.js';
import type { ContextItem, CreateRunInput, Installation, RunRow } from './types.js';

export const runDto = (run: RunRow) => ({
  id: run.id,
  execution_location: run.execution_location,
  report_source: run.report_source,
  agent_id: run.agent_id,
  agent_revision: run.agent_revision,
  task_id: run.task_id,
  conversation_id: run.conversation_id,
  status: run.status,
  version: run.version,
  lease_generation: run.lease_generation,
  cancellation_requested: run.cancellation_requested,
  pause_requested: run.pause_requested,
  context_manifest_id: run.context_manifest_id,
  tool_grant_id: run.tool_grant_id,
  summary: run.summary,
  output: run.output,
  budget: {
    currency: run.budget_currency,
    limit_microunits: run.budget_limit_microunits,
    reserved_microunits: run.budget_reserved_microunits,
    spent_microunits: run.budget_spent_microunits,
    blocked: run.budget_blocked,
  },
  created_at: run.created_at.toISOString(),
  updated_at: run.updated_at.toISOString(),
});
export function createRuntimeService(options: {
  db: Db;
  sources?: RuntimeSourcePort;
  maxContextBytes?: number;
  maxContextItems?: number;
  cursorSecret?: string;
}) {
  const cursors = new CursorCodec(options.cursorSecret ?? randomBytes(32).toString('hex'));
  const maxBytes = options.maxContextBytes ?? 65536;
  const maxItems = options.maxContextItems ?? 50;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 65536 ||
    !Number.isInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 50
  )
    throw new Error('Context limits must be within the public contract bounds');
  async function publicAccess(
    tx: Parameters<typeof authorizeTenant>[0],
    auth: AuthContext,
    run: RunRow,
  ) {
    await authorizeTenant(tx, auth);
    if (run.task_id) {
      await ancestry(tx, run.task_id);
      await taskAccess(tx, auth, run.task_id);
    } else await authorizeConversation(tx, auth, run.conversation_id!);
    if (run.created_by !== auth.principalId) {
      const installed = await installation(tx, run.agent_id);
      if (auth.kind !== 'agent' || installed.agent_principal_id !== auth.principalId)
        fail('NOT_FOUND', 404);
    }
  }
  return {
    async installAgent(
      auth: AuthContext,
      input: {
        principal_id: string;
        revision: string;
        mode: 'hosted' | 'device' | 'external';
        config: Record<string, unknown>;
        capabilities: string[];
      },
      key: string,
    ) {
      id(input.principal_id);
      if (
        money(input.revision) === 0n ||
        Buffer.byteLength(json(input.config)) > 16384 ||
        input.capabilities.length > 100
      )
        fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        const role = await tx
          .selectFrom('tenant_principals')
          .select('role')
          .where('principal_id', '=', auth.principalId)
          .executeTakeFirstOrThrow();
        if (!['owner', 'admin'].includes(role.role)) fail('FORBIDDEN', 403);
        const principal = await tx
          .selectFrom('principals')
          .select(['kind', 'status'])
          .where('id', '=', input.principal_id)
          .executeTakeFirst();
        if (principal?.kind !== 'agent' || principal.status !== 'active') fail('NOT_FOUND', 404);
        const agentMember = await tx
          .selectFrom('tenant_principals')
          .select('status')
          .where('principal_id', '=', input.principal_id)
          .executeTakeFirst();
        if (agentMember?.status !== 'active') fail('NOT_FOUND', 404);
        const agentId = await command(tx, auth, 'agent.install', key, input, async () => {
          let row = (
            await sql<Installation>`select * from agent_installations where agent_principal_id=${input.principal_id} for update`.execute(
              tx,
            )
          ).rows[0];
          if (!row) {
            const newId = randomUUID();
            await sql`insert into agent_installations(tenant_id,id,agent_principal_id,mode,created_by) values(${auth.tenantId},${newId},${input.principal_id},${input.mode},${auth.principalId})`.execute(
              tx,
            );
            row = (
              await sql<Installation>`select * from agent_installations where id=${newId}`.execute(
                tx,
              )
            ).rows[0]!;
          }
          if (row.mode !== input.mode || row.status !== 'active') fail('VERSION_CONFLICT', 409);
          const exists = (
            await sql`select 1 from agent_revisions where agent_id=${row.id} and revision=${input.revision}`.execute(
              tx,
            )
          ).rows.length;
          if (exists) fail('VERSION_CONFLICT', 409, 'Agent revisions are immutable');
          await sql`insert into agent_revisions(tenant_id,agent_id,revision,config,config_hash,capabilities) values(${auth.tenantId},${row.id},${input.revision},${json(input.config)}::jsonb,${hash(input.config)},${json(input.capabilities)}::jsonb)`.execute(
            tx,
          );
          return row.id;
        });
        return {
          id: agentId,
          principal_id: input.principal_id,
          revision: input.revision,
          mode: input.mode,
        };
      });
    },
    async createRun(auth: AuthContext, input: CreateRunInput, key: string) {
      id(input.agent_id);
      if (
        !!input.task_id === !!input.conversation_id ||
        input.context.length > maxItems ||
        !input.purpose ||
        input.purpose.length > 500 ||
        !input.destination ||
        input.destination.length > 500
      )
        fail('VALIDATION_FAILED', 400);
      money(input.agent_revision);
      money(input.budget.limit_microunits);
      if (!/^[A-Z]{3}$/.test(input.budget.currency)) fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        const runId = await command(tx, auth, 'run.create', key, input, async () => {
          const installed = await installation(tx, input.agent_id);
          const member = await tx
            .selectFrom('tenant_principals')
            .select('authz_revision')
            .where('principal_id', '=', installed.agent_principal_id)
            .where('status', '=', 'active')
            .forShare()
            .executeTakeFirst();
          if (!member) fail('FORBIDDEN', 403);
          const agent: AuthContext = {
            tenantId: auth.tenantId,
            principalId: installed.agent_principal_id,
            kind: 'agent',
            authzRevision: member.authz_revision,
          };
          let chain: Awaited<ReturnType<typeof ancestry>> = [];
          if (input.task_id) {
            chain = await ancestry(tx, input.task_id);
            activeChain(chain);
            await taskAccess(tx, auth, input.task_id, true);
            await taskAccess(tx, agent, input.task_id, true);
          } else {
            await authorizeConversation(tx, auth, input.conversation_id!);
            await authorizeConversation(tx, agent, input.conversation_id!);
          }
          if (input.previous_run_id) {
            const previous = await runRow(tx, input.previous_run_id);
            await publicAccess(tx, auth, previous);
            const sameScope =
              previous.task_id === (input.task_id ?? null) &&
              previous.conversation_id === (input.conversation_id ?? null);
            const promotedScope =
              !!input.task_id &&
              !previous.task_id &&
              !!previous.conversation_id &&
              (
                await sql`select 1 from task_run_origins where task_id=${input.task_id} and run_id=${previous.id}`.execute(
                  tx,
                )
              ).rows.length === 1;
            if (!isTerminalRunStatus(previous.status) || (!sameScope && !promotedScope))
              fail('VERSION_CONFLICT', 409);
            if (promotedScope) {
              const actors = await liveActors(tx, previous);
              await verifyContext(tx, previous, actors.creator, actors.agent, options.sources);
            }
          }
          const config = (
            await sql<{
              config: Record<string, unknown>;
            }>`select config from agent_revisions where agent_id=${input.agent_id} and revision=${input.agent_revision}`.execute(
              tx,
            )
          ).rows[0];
          if (!config) fail('NOT_FOUND', 404);
          const items: ContextItem[] = [];
          let total = 0;
          for (const ref of input.context) {
            id(ref.id);
            if (money(ref.version) === 0n) fail('VALIDATION_FAILED', 400);
            let value: Awaited<ReturnType<typeof source>>;
            try {
              value = await source(
                tx,
                auth,
                agent,
                ref,
                input.conversation_id ?? null,
                input.task_id ?? null,
                options.sources,
              );
            } catch (error) {
              if (
                !ref.required &&
                error &&
                typeof error === 'object' &&
                'code' in error &&
                ['NOT_FOUND', 'FORBIDDEN', 'DISCLOSURE_DENIED', 'VERSION_CONFLICT'].includes(
                  String(error.code),
                )
              )
                continue;
              throw error;
            }
            total += Buffer.byteLength(json(value.payload));
            if (total > maxBytes) fail('VALIDATION_FAILED', 400, 'Context size limit exceeded');
            items.push({
              ordinal: items.length + 1,
              source_type: ref.type,
              source_id: ref.id,
              source_version: ref.version,
              source_sha256: 'sha256' in ref ? ref.sha256 : null,
              content_hash: hash(value.payload),
              required: ref.required,
              trust_level: 'untrusted_user_content',
              payload: value.payload,
              authorization_snapshot: value.authorization,
            });
          }
          await sql`select pg_advisory_xact_lock(hashtextextended(${`${auth.tenantId}:runtime-capacity`},0))`.execute(
            tx,
          );
          const pending = (
            await sql<{
              n: string;
            }>`select count(*) as n from agent_runs where status in ('queued','running','waiting_input','waiting_approval','waiting_dependency','paused','cancelling')`.execute(
              tx,
            )
          ).rows[0]!;
          if (BigInt(pending.n) >= BigInt(RUNTIME_LIMITS.queuedPerTenant))
            fail('CAPACITY_EXCEEDED', 409);
          if (chain[0]) {
            const count = (
              await sql<{
                n: string;
              }>`select count(*) as n from agent_runs r join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id where t.root_task_id=${chain[0].id}`.execute(
                tx,
              )
            ).rows[0]!;
            if (BigInt(count.n) >= BigInt(RUNTIME_LIMITS.runsPerRoot))
              fail('STEP_LIMIT_EXCEEDED', 409);
          }
          const creatorPrincipal = await principal(tx, auth.principalId);
          const agentPrincipal = await principal(tx, agent.principalId);
          const authorization = await scopeAuthorization(
            tx,
            auth,
            agent,
            input.task_id ?? null,
            input.conversation_id ?? null,
          );
          const newId = randomUUID();
          const manifestId = randomUUID();
          await sql`insert into agent_runs(tenant_id,id,agent_id,agent_revision,created_by,creator_authz_revision,agent_authz_revision,installation_authz_revision,task_id,conversation_id,origin_type,ancestor_fences,budget_currency,budget_limit_microunits,context_manifest_id,previous_run_id,creator_principal_version,agent_principal_version,scope_authorization,execution_location,report_source)
      values(${auth.tenantId},${newId},${input.agent_id},${input.agent_revision},${auth.principalId},${auth.authzRevision},${agent.authzRevision},${installed.authz_revision},${input.task_id ?? null},${input.conversation_id ?? null},${input.task_id ? 'task' : 'conversation'},${json(chain.map((row) => ({ id: row.id, execution_epoch: row.execution_epoch })))}::jsonb,${input.budget.currency},${input.budget.limit_microunits},${manifestId},${input.previous_run_id ?? null},${creatorPrincipal.version},${agentPrincipal.version},${json(authorization)}::jsonb,${installed.mode},${installed.mode === 'hosted' ? 'platform_verified' : 'external_report'})`.execute(
            tx,
          );
          await sql`insert into context_manifests(tenant_id,id,run_id,purpose,destination,content_hash,total_bytes) values(${auth.tenantId},${manifestId},${newId},${input.purpose},${input.destination},${hash(items)},${total})`.execute(
            tx,
          );
          for (const item of items)
            await sql`insert into context_items(tenant_id,manifest_id,ordinal,source_type,source_id,source_version,source_sha256,content_hash,required,trust_level,payload,authorization_snapshot) values(${auth.tenantId},${manifestId},${item.ordinal},${item.source_type},${item.source_id},${item.source_version},${item.source_sha256},${item.content_hash},${item.required},${item.trust_level},${json(item.payload)}::jsonb,${json(item.authorization_snapshot)}::jsonb)`.execute(
              tx,
            );
          if (input.tool_grant_id)
            await bindRunToolGrant(
              tx,
              auth,
              await runRow(tx, newId),
              items,
              input.tool_grant_id,
              agent.principalId,
            );
          await appendEvent(tx, auth, {
            aggregateType: 'agent_run',
            aggregateId: newId,
            version: '1',
            type: 'run.queued',
            payload: {},
            target: `run:${newId}`,
          });
          return newId;
        });
        const run = await runRow(tx, runId);
        await publicAccess(tx, auth, run);
        return runDto(run);
      });
    },
    async listRuns(
      auth: AuthContext,
      scope: { task_id?: string; conversation_id?: string },
      query: { cursor?: string; limit?: number } = {},
    ) {
      if (!!scope.task_id === !!scope.conversation_id) fail('VALIDATION_FAILED', 400);
      const scopeId = id(scope.task_id ?? scope.conversation_id!);
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        const generation = scope.task_id
          ? (await taskAccess(tx, auth, scopeId)).authz_generation
          : (await authorizeConversation(tx, auth, scopeId)).row.authz_generation;
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:runs:${scope.task_id ? 'task' : 'conversation'}:${scopeId}:${generation}`;
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<RunRow>`select r.* from agent_runs r join agent_installations a on a.tenant_id=r.tenant_id and a.id=r.agent_id where ${scope.task_id ? sql`r.task_id=${scopeId}` : sql`r.conversation_id=${scopeId}`} and (r.created_by=${auth.principalId} or a.agent_principal_id=${auth.principalId}) and r.id>${after}::uuid order by r.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const run of rows.slice(0, limit)) {
          // Never expose stale output when its manifest sources or execution identities were revoked.
          try {
            await publicAccess(tx, auth, run);
            const actors = await liveActors(tx, run);
            await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
            items.push(runDto(run));
          } catch (error) {
            if (!(
              error instanceof Error &&
              'status' in error &&
              [403, 404, 409].includes(Number(error.status))
            ))
              throw error;
          }
        }
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async getRun(auth: AuthContext, runId: string) {
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        const run = await runRow(tx, id(runId));
        await publicAccess(tx, auth, run);
        const actors = await liveActors(tx, run);
        await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
        return runDto(run);
      });
    },
    async getContextManifest(auth: AuthContext, runId: string) {
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        const run = await runRow(tx, id(runId));
        await publicAccess(tx, auth, run);
        const actors = await liveActors(tx, run);
        const items = await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
        const manifest = (
          await sql<{
            id: string;
            purpose: string;
            destination: string;
            content_hash: string;
            total_bytes: number;
          }>`select id,purpose,destination,content_hash,total_bytes from context_manifests where id=${run.context_manifest_id}`.execute(
            tx,
          )
        ).rows[0]!;
        return { ...manifest, items };
      });
    },
    async controlRun(
      auth: AuthContext,
      runId: string,
      action: 'pause' | 'resume' | 'cancel',
      version: string,
      key: string,
    ) {
      return runtimeTransaction(options.db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        await command(tx, auth, `run.${action}`, key, { runId, version }, async () => {
          const initial = await runRow(tx, id(runId));
          await publicAccess(tx, auth, initial);
          if (initial.created_by !== auth.principalId) fail('FORBIDDEN', 403);
          if (initial.task_id) {
            const chain = await ancestry(tx, initial.task_id);
            if (action !== 'cancel') activeChain(chain, initial.ancestor_fences);
          }
          const run = await runRow(tx, runId, true);
          if (run.version !== version || isTerminalRunStatus(run.status))
            fail('VERSION_CONFLICT', 409);
          if (
            action === 'resume' &&
            !['paused', 'waiting_input', 'waiting_approval', 'waiting_dependency'].includes(
              run.status,
            )
          )
            fail('VERSION_CONFLICT', 409);
          if (action === 'resume') {
            if (run.tool_grant_id && auth.kind !== 'human') fail('FORBIDDEN', 403);
            await assertRunToolProgress(tx, run.id, 'resume');
            const actors = await liveActors(tx, run);
            await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
          }
          if (run.status === 'cancelling' && action !== 'cancel') fail('VERSION_CONFLICT', 409);
          const lease = (
            await sql<{
              live: boolean;
            }>`select lease_expires_at>clock_timestamp() as live from agent_runs where id=${run.id}`.execute(
              tx,
            )
          ).rows[0];
          const running = ['running', 'cancelling'].includes(run.status) && lease?.live === true;
          const status =
            action === 'cancel'
              ? running
                ? 'cancelling'
                : 'cancelled'
              : action === 'pause'
                ? running
                  ? 'running'
                  : 'paused'
                : 'queued';
          await sql`update agent_runs set status=${status},version=version+1,cancellation_requested=${action === 'cancel' || run.cancellation_requested},pause_requested=${action === 'pause'},lease_expires_at=case when ${!running} then null else lease_expires_at end,lease_holder=case when ${!running} then null else lease_holder end,updated_at=clock_timestamp() where id=${runId}`.execute(
            tx,
          );
          if (action === 'cancel') await cancelPendingRunTool(tx, auth, run.id);
          const updated = await runRow(tx, runId);
          await appendEvent(tx, auth, {
            aggregateType: 'agent_run',
            aggregateId: runId,
            version: updated.version,
            type: `run.${action}_requested`,
            payload: {},
            target: `run:${runId}`,
          });
          return runId;
        });
        const run = await runRow(tx, runId);
        await publicAccess(tx, auth, run);
        if (action === 'cancel') return { ...runDto(run), output: null, summary: '' };
        const actors = await liveActors(tx, run);
        await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
        return runDto(run);
      });
    },
  };
}
export type RuntimeService = ReturnType<typeof createRuntimeService>;
