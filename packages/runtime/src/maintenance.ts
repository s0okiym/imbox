import { sql, withTenant, lockTaskRoots, type Db } from '@imbox/db';
import { appendEvent, MAINTENANCE_PRINCIPAL_ID } from '@imbox/application';
import { RUNTIME_LIMITS } from './limits.js';
/** Expiration never guesses the cost of an in-flight request or releases an unresolved hold. */
export function createRuntimeMaintenance(db: Db) {
  return async (tenantId: string, limit = 50) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid expiration batch limit');
    const candidates = await withTenant(
      db,
      tenantId,
      async (tx) =>
        (
          await sql<{
            id: string;
            root_task_id: string | null;
          }>`select r.id,t.root_task_id from agent_runs r left join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id where r.status not in ('completed','failed','cancelled','expired') and r.created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'<=clock_timestamp() order by r.created_at,r.id limit ${limit}`.execute(
            tx,
          )
        ).rows,
    );
    let expired = 0;
    for (const candidate of candidates)
      expired += await withTenant(db, tenantId, async (tx) => {
        if (candidate.root_task_id) await lockTaskRoots(tx, tenantId, [candidate.root_task_id]);
        const run = (
          await sql<{
            id: string;
            version: string;
          }>`update agent_runs set status='expired',cancellation_requested=true,pause_requested=false,lease_holder=null,lease_expires_at=null,lease_generation=lease_generation+1,version=version+1,updated_at=clock_timestamp() where id=${candidate.id} and status not in ('completed','failed','cancelled','expired') and created_at+${RUNTIME_LIMITS.lifetimeSeconds}*interval '1 second'<=clock_timestamp() returning id,version`.execute(
            tx,
          )
        ).rows[0];
        if (!run) return 0;
        await sql`update runtime_reservations set status='unknown',updated_at=clock_timestamp() where run_id=${run.id} and status='held'`.execute(
          tx,
        );
        await sql`update agent_runs set budget_blocked=true where id=${run.id} and exists(select 1 from runtime_reservations where run_id=${run.id} and status='unknown')`.execute(
          tx,
        );
        await sql`update task_budgets set blocked=true where task_id in(select jsonb_array_elements_text(account_ids)::uuid from runtime_reservations where run_id=${run.id} and status='unknown')`.execute(
          tx,
        );
        await sql`insert into tenant_principals(tenant_id,principal_id,role) values(${tenantId},${MAINTENANCE_PRINCIPAL_ID},'member') on conflict(tenant_id,principal_id) do nothing`.execute(
          tx,
        );
        await appendEvent(
          tx,
          { tenantId, principalId: MAINTENANCE_PRINCIPAL_ID, kind: 'service', authzRevision: '1' },
          {
            aggregateType: 'agent_run',
            aggregateId: run.id,
            version: run.version,
            type: 'run.expired',
            payload: { reason: 'lifetime_limit' },
            target: `run:${run.id}`,
          },
        );
        return 1;
      });
    return { expired };
  };
}
