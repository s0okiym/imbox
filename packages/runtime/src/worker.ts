import { assertRunToolProgress, runToolState } from './tool-intents.js';
import type { RuntimeSourcePort } from '@imbox/application';
import { claimCapacity, checkpointCapacity, modelCapacity, RUNTIME_LIMITS } from './limits.js';
import { randomUUID } from 'node:crypto';
import { appendEvent, command, type AuthContext } from '@imbox/application';
import { sql, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { isTerminalRunStatus, transitionRun, type AgentRun } from '@imbox/domain';
import {
  fail,
  activeChain,
  ancestry,
  hash,
  json,
  liveActors,
  money,
  runRow,
  verifyContext,
  runtimeTransaction,
  principal,
} from './shared.js';
import { runDto } from './service.js';
import type { BudgetRow, LeaseClaim, ReportInput, Reservation, RunRow } from './types.js';

export function createRuntimeWorker(options: {
  db: Db;
  sources?: RuntimeSourcePort;
  workerId: string;
  leaseSeconds?: number;
  authorizeExecution?: (tx: Tx, runId: string) => Promise<void>;
  claimActor?: AuthContext;
}) {
  const ttl = options.leaseSeconds ?? 60;
  if (!options.workerId || !Number.isInteger(ttl) || ttl < 1 || ttl > 300)
    throw new Error('Worker identity and a 1..300 second lease required');
  async function lockExecution(
    tx: Tx,
    runId: string,
    claim?: LeaseClaim,
    allowCancellation = false,
  ) {
    const initial = await runRow(tx, runId);
    await options.authorizeExecution?.(tx, runId);
    const actors = await liveActors(tx, initial);
    const chain = initial.task_id ? await ancestry(tx, initial.task_id) : [];
    if (initial.task_id && !allowCancellation) activeChain(chain, initial.ancestor_fences);
    const run = await runRow(tx, runId, true);
    if (claim) {
      const valid = (
        await sql<{
          valid: boolean;
        }>`select lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() as valid from agent_runs where id=${run.id}`.execute(
          tx,
        )
      ).rows[0]?.valid;
      if (claim.holder !== options.workerId || !valid)
        fail('VERSION_CONFLICT', 409, 'Execution lease is expired or no longer owned');
    }
    if (!allowCancellation) {
      const live = (
        await sql<{
          valid: boolean;
        }>`select created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'>clock_timestamp() as valid from agent_runs where id=${run.id}`.execute(
          tx,
        )
      ).rows[0]?.valid;
      if (!live) fail('EXECUTION_EXPIRED', 409);
      if (
        run.cancellation_requested ||
        isTerminalRunStatus(run.status) ||
        run.status === 'cancelling'
      )
        fail('VERSION_CONFLICT', 409);
      await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
    }
    return { run, actors, chain };
  }
  async function event(tx: Tx, run: RunRow, type: string) {
    await appendEvent(
      tx,
      {
        tenantId: run.tenant_id,
        principalId: run.created_by,
        kind: (await principal(tx, run.created_by)).kind,
        authzRevision: run.creator_authz_revision,
      },
      {
        aggregateType: 'agent_run',
        aggregateId: run.id,
        version: run.version,
        type,
        payload: {},
        target: `run:${run.id}`,
      },
    );
  }
  async function reservation(tx: Tx, reservationId: string) {
    return (
      (
        await sql<Reservation>`select * from runtime_reservations where id=${reservationId} for update`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function accounting(tx: Tx, reservationId: string) {
    const initial =
      (
        await sql<Reservation>`select * from runtime_reservations where id=${reservationId}`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404);
    if (initial.task_id) await ancestry(tx, initial.task_id);
    const run = await runRow(tx, initial.run_id, true);
    const row = await reservation(tx, reservationId);
    const budgets: BudgetRow[] = [];
    for (const accountId of row.account_ids)
      budgets.push(
        (
          await sql<BudgetRow>`select * from task_budgets where task_id=${accountId} for update`.execute(
            tx,
          )
        ).rows[0] ?? fail('NOT_FOUND', 404),
      );
    return { row, run, budgets };
  }
  type UsageInput = {
    usage_key: string;
    actual_microunits: string;
    evidence: Record<string, unknown>;
  };
  function validateUsage(input: UsageInput) {
    money(input.actual_microunits);
    if (!input.usage_key || input.usage_key.length > 300 || !Object.keys(input.evidence).length)
      fail('VALIDATION_FAILED', 400);
  }
  async function settleAccounting(
    tx: Tx,
    tenantId: string,
    reservationId: string,
    input: UsageInput,
  ) {
    const { row, run, budgets } = await accounting(tx, reservationId);
    const previous = (
      await sql<{
        reservation_id: string;
        actual_microunits: string;
        evidence: unknown;
      }>`select reservation_id,actual_microunits,evidence from runtime_usage_records where usage_key=${input.usage_key}`.execute(
        tx,
      )
    ).rows[0];
    if (previous) {
      if (
        previous.reservation_id !== row.id ||
        previous.actual_microunits !== input.actual_microunits ||
        hash(previous.evidence) !== hash(input.evidence)
      )
        fail('IDEMPOTENCY_CONFLICT', 409);
      return row;
    }
    if (!['held', 'unknown'].includes(row.status)) fail('VERSION_CONFLICT', 409);
    await sql`insert into runtime_usage_records(tenant_id,id,reservation_id,usage_key,actual_microunits,currency,evidence) values(${tenantId},${randomUUID()},${row.id},${input.usage_key},${input.actual_microunits},${row.currency},${json(input.evidence)}::jsonb)`.execute(
      tx,
    );
    for (const budget of budgets)
      await sql`update task_budgets set reserved_microunits=reserved_microunits-${row.amount_microunits}::bigint,spent_microunits=spent_microunits+${input.actual_microunits}::bigint,
     blocked=blocked OR reserved_microunits-${row.amount_microunits}::bigint+spent_microunits+${input.actual_microunits}::bigint>limit_microunits,
     overrun_microunits=greatest(0,spent_microunits+${input.actual_microunits}::bigint-limit_microunits),version=version+1 where task_id=${budget.task_id}`.execute(
        tx,
      );
    await sql`update agent_runs set budget_reserved_microunits=budget_reserved_microunits-${row.amount_microunits}::bigint,budget_spent_microunits=budget_spent_microunits+${input.actual_microunits}::bigint,
     budget_blocked=budget_blocked OR budget_reserved_microunits-${row.amount_microunits}::bigint+budget_spent_microunits+${input.actual_microunits}::bigint>budget_limit_microunits where id=${run.id}`.execute(
      tx,
    );
    await sql`update runtime_reservations set status='settled',actual_microunits=${input.actual_microunits},usage_key=${input.usage_key},updated_at=clock_timestamp() where id=${row.id}`.execute(
      tx,
    );
    return await reservation(tx, row.id);
  }
  return {
    async claim(
      tenantId: string,
      runId: string,
      idempotencyKey?: string,
    ): Promise<LeaseClaim | null> {
      return runtimeTransaction(options.db, tenantId, async (tx) => {
        await options.authorizeExecution?.(tx, runId);
        const execute = async () => {
          const { run } = await lockExecution(tx, runId);
          const lease = (
            await sql<{
              live: boolean;
            }>`select lease_expires_at>clock_timestamp() as live from agent_runs where id=${runId}`.execute(
              tx,
            )
          ).rows[0]!;
          if (!['queued', 'running'].includes(run.status) || lease.live)
            fail('VERSION_CONFLICT', 409);
          const unresolved = (
            await sql<{
              id: string;
            }>`select id from runtime_reservations where run_id=${runId} and status in ('held','unknown')`.execute(
              tx,
            )
          ).rows;
          if (unresolved.length) {
            await sql`update runtime_reservations set status='unknown',updated_at=clock_timestamp() where run_id=${runId} and status='held'`.execute(
              tx,
            );
            await sql`update agent_runs set status='waiting_dependency',version=version+1,lease_holder=null,lease_expires_at=null,summary='Waiting for prior usage reconciliation',updated_at=clock_timestamp() where id=${runId}`.execute(
              tx,
            );
            await event(tx, await runRow(tx, runId), 'run.waiting_reconciliation');
            return 'blocked';
          }
          await assertRunToolProgress(tx, run.id, 'claim');
          await claimCapacity(tx, run);
          const result = (
            await sql<RunRow>`update agent_runs set status='running',version=version+1,lease_holder=${options.workerId},last_claim_holder=${options.workerId},last_claim_generation=lease_generation+1,lease_generation=lease_generation+1,lease_expires_at=clock_timestamp()+${ttl}*interval '1 second',updated_at=clock_timestamp() where id=${runId} returning *`.execute(
              tx,
            )
          ).rows[0]!;
          await event(tx, result, 'run.claimed');
          return result.lease_generation;
        };
        const generation =
          idempotencyKey && options.claimActor
            ? await command(
                tx,
                options.claimActor,
                'run.external.claim',
                idempotencyKey,
                { runId, holder: options.workerId },
                execute,
              )
            : await execute();
        if (generation === 'blocked') return null;
        const valid = (
          await sql<{
            valid: boolean;
          }>`select lease_holder=${options.workerId} and lease_generation=${generation} and lease_expires_at>clock_timestamp() and status='running' as valid from agent_runs where id=${runId}`.execute(
            tx,
          )
        ).rows[0]?.valid;
        if (!valid) fail('VERSION_CONFLICT', 409);
        return { tenantId, runId, holder: options.workerId, generation };
      });
    },
    async listRunnable(tenantId: string, limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, tenantId, async (tx) => {
        await sql`insert into runtime_scan_cursors(tenant_id,worker_id) values(${tenantId},${options.workerId}) on conflict do nothing`.execute(
          tx,
        );
        const scan = (
          await sql<{
            last_created_at: Date | null;
            last_run_id: string | null;
          }>`select * from runtime_scan_cursors where worker_id=${options.workerId} for update`.execute(
            tx,
          )
        ).rows[0]!;
        const rows = (
          await sql<{
            id: string;
            created_at: Date;
          }>`select r.id,r.created_at from agent_runs r join agent_installations a on a.tenant_id=r.tenant_id and a.id=r.agent_id where a.mode='hosted' and a.status='active' and (r.status='queued' or (r.status='running' and r.lease_expires_at<=clock_timestamp())) and (${scan.last_created_at}::timestamptz is null or (r.created_at,r.id)>(${scan.last_created_at}::timestamptz,${scan.last_run_id}::uuid)) order by r.created_at,r.id limit ${limit}`.execute(
            tx,
          )
        ).rows;
        const last = rows.length === limit ? rows.at(-1) : undefined;
        await sql`update runtime_scan_cursors set last_created_at=${last?.created_at ?? null},last_run_id=${last?.id ?? null},updated_at=clock_timestamp() where worker_id=${options.workerId}`.execute(
          tx,
        );
        return rows.map((row) => row.id);
      });
    },
    async acknowledgeCancellation(
      tenantId: string,
      runId: string,
      generation: string,
      key: string,
    ) {
      const actor = options.claimActor;
      if (!actor?.machine || actor.tenantId !== tenantId) fail('FORBIDDEN', 403);
      return runtimeTransaction(options.db, tenantId, async (tx) => {
        const { run } = await lockExecution(tx, runId, undefined, true);
        const live = (
          await sql<{
            live: boolean;
          }>`select coalesce(lease_expires_at>clock_timestamp(),false) as live from agent_runs where id=${runId}`.execute(
            tx,
          )
        ).rows[0]!.live;
        if (
          run.execution_location !== 'external' ||
          !run.cancellation_requested ||
          !['cancelling', 'cancelled', 'expired'].includes(run.status) ||
          live ||
          run.last_claim_holder !== options.workerId ||
          run.last_claim_generation !== generation
        )
          fail('VERSION_CONFLICT', 409);
        await command(
          tx,
          actor,
          'run.external.cancellation_ack',
          key,
          { runId, generation, holder: options.workerId },
          async () => {
            if (run.cancellation_acknowledged_at) return runId;
            const updated = (
              await sql<RunRow>`update agent_runs set cancellation_acknowledged_at=clock_timestamp(),status=case when status='cancelling' then 'cancelled' else status end,lease_holder=null,lease_expires_at=null,version=version+1,updated_at=clock_timestamp() where id=${runId} returning *`.execute(
                tx,
              )
            ).rows[0]!;
            await appendEvent(tx, actor, {
              aggregateType: 'agent_run',
              aggregateId: runId,
              version: updated.version,
              type: 'run.cancellation_acknowledged',
              payload: { generation },
              target: `run:${runId}`,
            });
            return runId;
          },
        );
        const current = await runRow(tx, runId);
        return {
          run_id: runId,
          generation,
          acknowledged_at: current.cancellation_acknowledged_at!.toISOString(),
          report_source: 'external_report' as const,
        };
      });
    },
    async heartbeat(claim: LeaseClaim) {
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        const { run, actors, chain } = await lockExecution(tx, claim.runId, claim, true);
        // A cancellation is an instruction to stop. It never renews execution authority.
        if (run.cancellation_requested || run.status === 'cancelling')
          return {
            expires_at: run.lease_expires_at!.toISOString(),
            cancellation_requested: true,
            pause_requested: run.pause_requested,
          };
        if (run.task_id) activeChain(chain, run.ancestor_fences);
        const live = (
          await sql<{
            valid: boolean;
          }>`select created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'>clock_timestamp() as valid from agent_runs where id=${run.id}`.execute(
            tx,
          )
        ).rows[0]?.valid;
        if (!live) fail('EXECUTION_EXPIRED', 409);
        if (isTerminalRunStatus(run.status)) fail('VERSION_CONFLICT', 409);
        await verifyContext(tx, run, actors.creator, actors.agent, options.sources);
        const updated = (
          await sql<{
            lease_expires_at: Date;
          }>`update agent_runs set lease_expires_at=clock_timestamp()+${ttl}*interval '1 second',updated_at=clock_timestamp() where id=${run.id} and lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() returning lease_expires_at`.execute(
            tx,
          )
        ).rows[0];
        if (!updated) fail('VERSION_CONFLICT', 409);
        return {
          expires_at: updated.lease_expires_at.toISOString(),
          cancellation_requested: false,
          pause_requested: run.pause_requested,
        };
      });
    },
    async getContext(claim: LeaseClaim) {
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        const { run, actors } = await lockExecution(tx, claim.runId, claim);
        return {
          manifest_id: run.context_manifest_id,
          items: await verifyContext(tx, run, actors.creator, actors.agent, options.sources),
        };
      });
    },
    async getExecution(claim: LeaseClaim) {
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        const { run, actors } = await lockExecution(tx, claim.runId, claim);
        if (run.pause_requested) fail('VERSION_CONFLICT', 409, 'Pause acknowledgement required');
        const revision = (
          await sql<{
            config: Record<string, unknown>;
            capabilities: string[];
          }>`select config,capabilities from agent_revisions where agent_id=${run.agent_id} and revision=${run.agent_revision}`.execute(
            tx,
          )
        ).rows[0]!;
        const manifest = (
          await sql<{
            id: string;
            purpose: string;
            destination: string;
            content_hash: string;
          }>`select id,purpose,destination,content_hash from context_manifests where id=${run.context_manifest_id}`.execute(
            tx,
          )
        ).rows[0]!;
        const latest =
          (
            await sql<{
              seq: string;
              payload: Record<string, unknown>;
            }>`select checkpoint_no as seq,payload from run_checkpoints where run_id=${run.id} order by checkpoint_no desc limit 1`.execute(
              tx,
            )
          ).rows[0] ?? null;
        return {
          tool_grant_id: run.tool_grant_id,
          tool_authorization: run.tool_grant_id
            ? ((
                await sql<{
                  tool_id: string;
                  tool_version: string;
                  target_id: string;
                }>`select tool_id,tool_version,target_id from capability_grants where id=${run.tool_grant_id} and revision=${run.tool_grant_revision} and status='active' and expires_at>clock_timestamp()`.execute(
                  tx,
                )
              ).rows[0] ?? fail('FORBIDDEN', 403))
            : null,
          tool_intent: await runToolState(tx, run.id),
          latest_checkpoint: latest,
          run_id: run.id,
          agent_id: run.agent_id,
          agent_revision: run.agent_revision,
          mode: actors.agentInstall.mode,
          config: revision.config,
          capabilities: revision.capabilities,
          manifest,
          budget: { currency: run.budget_currency, limit_microunits: run.budget_limit_microunits },
          items: await verifyContext(tx, run, actors.creator, actors.agent, options.sources),
        };
      });
    },
    async report(claim: LeaseClaim, input: ReportInput, key: string) {
      if (!key || key.length > 200 || Buffer.byteLength(json(input)) > 131072)
        fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        await options.authorizeExecution?.(tx, claim.runId);
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${claim.tenantId}:run-report:${claim.runId}`},0))`.execute(
          tx,
        );
        const previous = (
          await sql<{
            request_hash: string;
            lease_generation: string;
            worker_id: string;
          }>`select request_hash,lease_generation,worker_id from run_reports where run_id=${claim.runId} and report_key=${key}`.execute(
            tx,
          )
        ).rows[0];
        if (previous) {
          if (
            previous.request_hash !== hash(input) ||
            previous.lease_generation !== claim.generation ||
            previous.worker_id !== claim.holder ||
            claim.holder !== options.workerId
          )
            fail('IDEMPOTENCY_CONFLICT', 409);
          const existing = await runRow(tx, claim.runId);
          const actors = await liveActors(tx, existing);
          await verifyContext(tx, existing, actors.creator, actors.agent, options.sources);
          return runDto(existing);
        }
        const { run } = await lockExecution(tx, claim.runId, claim, input.status === 'cancelled');
        if (!['cancelled', 'failed', 'completed'].includes(input.status))
          await checkpointCapacity(tx, run);
        if (input.status === 'completed') await assertRunToolProgress(tx, run.id, 'complete');
        if (input.status === 'cancelled' && input.output !== undefined)
          fail('VALIDATION_FAILED', 400, 'Cancellation acknowledgement cannot publish output');
        if (
          input.status === 'completed' &&
          (
            await sql`select 1 from runtime_reservations where run_id=${run.id} and status in ('held','unknown')`.execute(
              tx,
            )
          ).rows.length
        )
          fail('VERSION_CONFLICT', 409, 'Usage reconciliation required before completion');
        if (
          (input.summary && input.summary.length > 2000) ||
          (input.output && input.output.length > 64000)
        )
          fail('VALIDATION_FAILED', 400);
        if (run.pause_requested && input.status !== 'paused' && input.status !== 'cancelled')
          fail('VERSION_CONFLICT', 409, 'Pause acknowledgement required');
        const model: AgentRun = {
          id: run.id,
          taskId: run.task_id,
          originScope: run.task_id
            ? { kind: 'task', taskId: run.task_id }
            : { kind: 'conversation', conversationId: run.conversation_id! },
          status: run.status,
          version: BigInt(run.version),
          cancellationRequested: run.cancellation_requested,
          previousRunId: run.previous_run_id,
        };
        if (input.status !== run.status)
          transitionRun(model, input.status, {
            expectedVersion: BigInt(run.version),
            safeCheckpointConfirmed: true,
            executionAuthorityTerminated: true,
            unresolvedActionsRegistered: true,
          });
        else if (input.status !== 'running') fail('VERSION_CONFLICT', 409);
        const stillRunning = input.status === 'running';
        const updated = (
          await sql<RunRow>`update agent_runs set status=${input.status},version=version+1,checkpoint_seq=checkpoint_seq+1,cancellation_acknowledged_at=case when ${input.status === 'cancelled'} then clock_timestamp() else cancellation_acknowledged_at end,summary=${input.summary ?? run.summary},output=${input.output ?? run.output},pause_requested=false,
     lease_holder=case when ${stillRunning} then lease_holder else null end,lease_expires_at=case when ${stillRunning} then lease_expires_at else null end,updated_at=clock_timestamp()
     where id=${run.id} and lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() returning *`.execute(
            tx,
          )
        ).rows[0];
        if (!updated) fail('VERSION_CONFLICT', 409);
        await sql`insert into run_checkpoints(tenant_id,run_id,checkpoint_no,lease_generation,status,payload) values(${claim.tenantId},${run.id},${updated.checkpoint_seq},${claim.generation},${input.status},${json(input.checkpoint)}::jsonb)`.execute(
          tx,
        );
        await sql`insert into run_reports(tenant_id,run_id,report_key,request_hash,result_version,lease_generation,worker_id) values(${claim.tenantId},${run.id},${key},${hash(input)},${updated.version},${claim.generation},${options.workerId})`.execute(
          tx,
        );
        await event(tx, updated, `run.${input.status}`);
        return runDto(updated);
      });
    },
    async reserve(
      claim: LeaseClaim,
      input: { reservation_key: string; amount_microunits: string; currency: string },
    ) {
      money(input.amount_microunits);
      if (!input.reservation_key || input.reservation_key.length > 200)
        fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        const { run, chain } = await lockExecution(tx, claim.runId, claim);
        if (run.status !== 'running' || run.pause_requested) fail('VERSION_CONFLICT', 409);
        const existing = (
          await sql<Reservation>`select * from runtime_reservations where run_id=${run.id} and reservation_key=${input.reservation_key} for update`.execute(
            tx,
          )
        ).rows[0];
        if (existing) {
          if (
            existing.amount_microunits !== input.amount_microunits ||
            existing.currency !== input.currency
          )
            fail('IDEMPOTENCY_CONFLICT', 409);
          return { ...existing, newly_reserved: false };
        }
        if (
          (
            await sql`select 1 from runtime_reservations where run_id=${run.id} and status='unknown'`.execute(
              tx,
            )
          ).rows.length
        )
          fail('BUDGET_EXCEEDED', 409, 'Usage reconciliation required');
        await assertRunToolProgress(tx, run.id, 'model');
        await modelCapacity(tx, run);
        const amount = money(input.amount_microunits);
        if (
          run.budget_currency !== input.currency ||
          run.budget_blocked ||
          BigInt(run.budget_reserved_microunits) + BigInt(run.budget_spent_microunits) + amount >
            BigInt(run.budget_limit_microunits)
        )
          fail('BUDGET_EXCEEDED', 409);
        for (const ancestor of chain) {
          const budget =
            (
              await sql<BudgetRow>`select * from task_budgets where task_id=${ancestor.id} for update`.execute(
                tx,
              )
            ).rows[0] ?? fail('NOT_FOUND', 404);
          if (
            budget.currency !== input.currency ||
            budget.blocked ||
            BigInt(budget.reserved_microunits) + BigInt(budget.spent_microunits) + amount >
              BigInt(budget.limit_microunits)
          )
            fail('BUDGET_EXCEEDED', 409);
        }
        const reservationId = randomUUID();
        await sql`insert into runtime_reservations(tenant_id,id,run_id,task_id,root_task_id,reservation_key,account_ids,currency,amount_microunits) values(${claim.tenantId},${reservationId},${run.id},${run.task_id},${chain[0]?.id ?? null},${input.reservation_key},${json(chain.map((row) => row.id))}::jsonb,${input.currency},${input.amount_microunits})`.execute(
          tx,
        );
        for (const ancestor of chain)
          await sql`update task_budgets set reserved_microunits=reserved_microunits+${input.amount_microunits}::bigint,version=version+1 where task_id=${ancestor.id}`.execute(
            tx,
          );
        const updated = (
          await sql`update agent_runs set budget_reserved_microunits=budget_reserved_microunits+${input.amount_microunits}::bigint where id=${run.id} and lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() returning id`.execute(
            tx,
          )
        ).rows[0];
        if (!updated) fail('VERSION_CONFLICT', 409);
        return { ...(await reservation(tx, reservationId)), newly_reserved: true };
      });
    },
    async markUnknown(tenantId: string, reservationId: string) {
      return runtimeTransaction(options.db, tenantId, async (tx) => {
        const { row } = await accounting(tx, reservationId);
        if (!['held', 'unknown'].includes(row.status)) fail('VERSION_CONFLICT', 409);
        await sql`update runtime_reservations set status='unknown',updated_at=clock_timestamp() where id=${row.id}`.execute(
          tx,
        );
        return { ...row, status: 'unknown' as const };
      });
    },
    async release(
      tenantId: string,
      reservationId: string,
      evidence: { confirmed_no_charge: boolean; reference: string },
    ) {
      if (!evidence.confirmed_no_charge || !evidence.reference)
        fail('VERSION_CONFLICT', 409, 'Positive no-charge evidence required');
      return runtimeTransaction(options.db, tenantId, async (tx) => {
        const { row, run, budgets } = await accounting(tx, reservationId);
        if (row.status === 'released') {
          const previous = (
            await sql<{
              resolution_evidence: unknown;
            }>`select resolution_evidence from runtime_reservations where id=${row.id}`.execute(tx)
          ).rows[0]!;
          if (hash(previous.resolution_evidence) !== hash(evidence))
            fail('IDEMPOTENCY_CONFLICT', 409);
          return row;
        }
        if (!['held', 'unknown'].includes(row.status)) fail('VERSION_CONFLICT', 409);
        for (const budget of budgets)
          await sql`update task_budgets set reserved_microunits=reserved_microunits-${row.amount_microunits}::bigint,version=version+1 where task_id=${budget.task_id}`.execute(
            tx,
          );
        await sql`update agent_runs set budget_reserved_microunits=budget_reserved_microunits-${row.amount_microunits}::bigint where id=${run.id}`.execute(
          tx,
        );
        await sql`update runtime_reservations set status='released',resolution_evidence=${json(evidence)}::jsonb,updated_at=clock_timestamp() where id=${row.id}`.execute(
          tx,
        );
        return { ...row, status: 'released' as const };
      });
    },
    async completeStep(
      claim: LeaseClaim,
      reservationId: string,
      input: UsageInput,
      checkpoint: Record<string, unknown>,
    ) {
      validateUsage(input);
      if (Buffer.byteLength(json(checkpoint)) > 131072) fail('VALIDATION_FAILED', 400);
      return runtimeTransaction(options.db, claim.tenantId, async (tx) => {
        const { run } = await lockExecution(tx, claim.runId, claim);
        if (run.status !== 'running') fail('VERSION_CONFLICT', 409);
        const bound = (
          await sql<{
            run_id: string;
          }>`select run_id from runtime_reservations where id=${reservationId}`.execute(tx)
        ).rows[0];
        if (bound?.run_id !== run.id) fail('NOT_FOUND', 404);
        const receiptKey = `runtime:step:${reservationId}`;
        const requestHash = hash({ input, checkpoint });
        const previous = (
          await sql<{
            request_hash: string;
          }>`select request_hash from run_reports where run_id=${run.id} and report_key=${receiptKey}`.execute(
            tx,
          )
        ).rows[0];
        if (previous) {
          if (previous.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 409);
          return runDto(run);
        }
        await checkpointCapacity(tx, run);
        await settleAccounting(tx, claim.tenantId, reservationId, input);
        const updated = (
          await sql<RunRow>`update agent_runs set version=version+1,checkpoint_seq=checkpoint_seq+1,updated_at=clock_timestamp() where id=${run.id} and lease_holder=${claim.holder} and lease_generation=${claim.generation} and lease_expires_at>clock_timestamp() returning *`.execute(
            tx,
          )
        ).rows[0];
        if (!updated) fail('VERSION_CONFLICT', 409);
        await sql`insert into run_checkpoints(tenant_id,run_id,checkpoint_no,lease_generation,status,payload) values(${claim.tenantId},${run.id},${updated.checkpoint_seq},${claim.generation},'running',${json(checkpoint)}::jsonb)`.execute(
          tx,
        );
        await sql`insert into run_reports(tenant_id,run_id,report_key,request_hash,result_version,lease_generation,worker_id) values(${claim.tenantId},${run.id},${receiptKey},${requestHash},${updated.version},${claim.generation},${options.workerId})`.execute(
          tx,
        );
        await event(tx, updated, 'run.step_completed');
        return runDto(updated);
      });
    },
    async settle(tenantId: string, reservationId: string, input: UsageInput) {
      validateUsage(input);
      return runtimeTransaction(options.db, tenantId, (tx) =>
        settleAccounting(tx, tenantId, reservationId, input),
      );
    },
  };
}
export type RuntimeWorker = ReturnType<typeof createRuntimeWorker>;
