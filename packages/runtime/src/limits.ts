import { sql, type TenantTransaction as Tx } from '@imbox/db';
import { fail } from './shared.js';
import type { RunRow } from './types.js';
/** V1 deployment bounds. Stricter tenant policies may be composed; callers cannot increase them. */
export const RUNTIME_LIMITS = Object.freeze({
  stepsPerRun: 20,
  modelInvocationsPerRun: 20,
  concurrentPerRoot: 4,
  concurrentPerTenant: 16,
  runsPerRoot: 200,
  queuedPerTenant: 1000,
  lifetimeSeconds: 86400,
});
export async function claimCapacity(tx: Tx, run: RunRow) {
  // Taken after task-root locks by every claimant; release only at commit. No network under this lock.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${run.tenant_id}:runtime-capacity`},0))`.execute(
    tx,
  );
  const active = (
    await sql<{
      n: string;
    }>`select count(*) as n from agent_runs where id<>${run.id} and status in ('running','cancelling') and lease_expires_at>clock_timestamp()`.execute(
      tx,
    )
  ).rows[0]!;
  if (BigInt(active.n) >= BigInt(RUNTIME_LIMITS.concurrentPerTenant))
    fail('CAPACITY_EXCEEDED', 409);
  if (run.task_id) {
    const root = (
      await sql<{
        root_task_id: string;
      }>`select root_task_id from tasks where id=${run.task_id}`.execute(tx)
    ).rows[0]!;
    const count = (
      await sql<{
        n: string;
      }>`select count(*) as n from agent_runs r join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id where t.root_task_id=${root.root_task_id} and r.id<>${run.id} and r.status in ('running','cancelling') and r.lease_expires_at>clock_timestamp()`.execute(
        tx,
      )
    ).rows[0]!;
    if (BigInt(count.n) >= BigInt(RUNTIME_LIMITS.concurrentPerRoot)) fail('CAPACITY_EXCEEDED', 409);
  }
}
export async function checkpointCapacity(_tx: Tx, run: RunRow) {
  if (BigInt(run.checkpoint_seq) >= BigInt(RUNTIME_LIMITS.stepsPerRun))
    fail('STEP_LIMIT_EXCEEDED', 409);
}
export async function modelCapacity(tx: Tx, run: RunRow) {
  const count = (
    await sql<{
      n: string;
    }>`select count(*) as n from runtime_reservations where run_id=${run.id}`.execute(tx)
  ).rows[0]!;
  if (BigInt(count.n) >= BigInt(RUNTIME_LIMITS.modelInvocationsPerRun))
    fail('STEP_LIMIT_EXCEEDED', 409);
}
