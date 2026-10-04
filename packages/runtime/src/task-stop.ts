import { appendEvent, type AuthContext } from '@imbox/application';
import { sql, type TenantTransaction } from '@imbox/db';
/** Caller owns the task-root lock and has authorized the terminal task transition. DB-only. */
export async function stopTaskRuns(tx: TenantTransaction, auth: AuthContext, taskId: string) {
  const rows = (
    await sql<{ id: string; version: string; task_id: string }>`with recursive tree as (
    select id from tasks where id=${taskId}
    union all select t.id from tasks t join tree p on t.parent_task_id=p.id
  ) update agent_runs r set
    status=case when r.status in ('running','cancelling') and r.lease_expires_at>statement_timestamp() then 'cancelling' else 'cancelled' end,
    cancellation_requested=true,pause_requested=false,version=r.version+1,
    lease_holder=case when r.status in ('running','cancelling') and r.lease_expires_at>statement_timestamp() then r.lease_holder else null end,
    lease_expires_at=case when r.status in ('running','cancelling') and r.lease_expires_at>statement_timestamp() then r.lease_expires_at else null end,
    updated_at=clock_timestamp()
    where r.task_id in(select id from tree) and r.status not in ('completed','failed','cancelled','expired')
    returning r.id,r.version,r.task_id`.execute(tx)
  ).rows;
  for (const row of rows)
    await appendEvent(tx, auth, {
      aggregateType: 'agent_run',
      aggregateId: row.id,
      version: row.version,
      type: 'run.cancel_requested',
      payload: { task_id: row.task_id, stopped_by_task_id: taskId },
      target: `run:${row.id}`,
    });
  return rows.length;
}
