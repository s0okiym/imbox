import {
  appendEvent,
  authorizeTenant,
  type AuthContext,
  type RuntimeSourcePort,
} from '@imbox/application';
import { sql, type TenantTransaction as Tx } from '@imbox/db';
import { activeChain, ancestry, fail, liveActors, runRow, verifyContext } from './shared.js';
import { checkpointCapacity, RUNTIME_LIMITS } from './limits.js';

export interface ScheduledRunBinding {
  auth: AuthContext;
  taskId: string;
  runId: string;
}

/** DB-only admission. Caller retains the schedule lock until this transaction commits. */
export async function validateScheduledRun(
  tx: Tx,
  binding: ScheduledRunBinding,
  requirePaused = true,
  sources?: RuntimeSourcePort,
) {
  await authorizeTenant(tx, binding.auth);
  if (binding.auth.kind !== 'human') fail('FORBIDDEN', 403);
  const initial = await runRow(tx, binding.runId);
  if (initial.created_by !== binding.auth.principalId || initial.task_id !== binding.taskId)
    fail('NOT_FOUND', 404);
  const actors = await liveActors(tx, initial);
  if (
    actors.creator.kind !== 'human' ||
    actors.creator.authzRevision !== binding.auth.authzRevision
  )
    fail('FORBIDDEN', 403);
  const chain = await ancestry(tx, binding.taskId);
  activeChain(chain, initial.ancestor_fences);
  const run = await runRow(tx, binding.runId, true);
  // Tool authority always requires an explicit human resume, including at schedule admission.
  if (run.tool_grant_id) fail('FORBIDDEN', 403);
  await verifyContext(tx, run, actors.creator, actors.agent, sources);
  const time = (
    await sql<{
      live: boolean;
      unleased: boolean;
      lifetime_deadline: Date;
    }>`select created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'>clock_timestamp() as live,lease_expires_at is null or lease_expires_at<=clock_timestamp() as unleased,created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second' as lifetime_deadline from agent_runs where id=${run.id}`.execute(
      tx,
    )
  ).rows[0]!;
  if (!time.live) fail('EXECUTION_EXPIRED', 409);
  if (
    run.cancellation_requested ||
    ['cancelling', 'completed', 'failed', 'cancelled', 'expired'].includes(run.status)
  )
    fail('VERSION_CONFLICT', 409);
  if (requirePaused && (run.status !== 'paused' || !time.unleased)) fail('VERSION_CONFLICT', 409);
  await checkpointCapacity(tx, run);
  if (
    run.budget_blocked ||
    BigInt(run.budget_reserved_microunits) + BigInt(run.budget_spent_microunits) >
      BigInt(run.budget_limit_microunits)
  )
    fail('BUDGET_EXCEEDED', 409);
  for (const task of chain) {
    const budget = (
      await sql<{
        blocked: boolean;
        overdrawn: boolean;
      }>`select blocked,reserved_microunits::numeric+spent_microunits::numeric>limit_microunits as overdrawn from task_budgets where task_id=${task.id} for share`.execute(
        tx,
      )
    ).rows[0];
    if (!budget || budget.blocked || budget.overdrawn) fail('BUDGET_EXCEEDED', 409);
  }
  const unresolved = (
    await sql`select 1 from runtime_reservations where run_id=${run.id} and status in ('held','unknown') limit 1`.execute(
      tx,
    )
  ).rows.length;
  if (unresolved) fail('CHARGE_STATUS_UNKNOWN', 409);
  return {
    run,
    rootTaskId: chain[0]!.id,
    principalVersion: run.creator_principal_version,
    unleased: time.unleased,
    lifetimeDeadline: time.lifetime_deadline,
  };
}

/** A wake never accepts a Request, creates a Run, spends money, or resumes a terminal Run. */
export async function scheduledWake(
  tx: Tx,
  binding: ScheduledRunBinding & {
    occurrenceId: string;
    scheduleId: string;
    scheduledInstant: Date;
    deadline: Date;
    latestDispatchAt: Date | null;
  },
  sources?: RuntimeSourcePort,
): Promise<'dispatched' | 'overlap'> {
  const { run, unleased } = await validateScheduledRun(tx, binding, false, sources);
  if (run.status !== 'paused' || !unleased) return 'overlap';
  // Tool-bearing Runs require a fresh explicit human resume after approval/pause.
  if (run.tool_grant_id) fail('FORBIDDEN', 403);
  const changed =
    await sql`update agent_runs set status='queued',version=version+1,pause_requested=false,lease_holder=null,lease_expires_at=null,updated_at=clock_timestamp() where id=${run.id} and clock_timestamp()>=${binding.scheduledInstant} and clock_timestamp()<${binding.deadline} and (${binding.latestDispatchAt}::timestamptz is null or clock_timestamp()<=${binding.latestDispatchAt}::timestamptz) and created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'>clock_timestamp() returning id`.execute(
      tx,
    );
  if (changed.rows.length !== 1) fail('EXECUTION_EXPIRED', 409);
  await appendEvent(tx, binding.auth, {
    aggregateType: 'agent_run',
    aggregateId: run.id,
    version: String(BigInt(run.version) + 1n),
    type: 'run.schedule_wake',
    payload: { schedule_id: binding.scheduleId, occurrence_id: binding.occurrenceId },
    target: `run:${run.id}`,
  });
  return 'dispatched';
}
