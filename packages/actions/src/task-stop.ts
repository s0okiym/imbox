import { appendEvent, type AuthContext } from '@imbox/application';
import { sql, type TenantTransaction } from '@imbox/db';
/** Caller holds the task-root lock; executing/unknown effects and reservations are untouched. */
export async function cancelPendingTaskActions(
  tx: TenantTransaction,
  auth: AuthContext,
  taskId: string,
) {
  const rows = (
    await sql<{ id: string; version: string; task_id: string }>`with recursive tree as (
    select id from tasks where id=${taskId}
    union all select t.id from tasks t join tree p on t.parent_task_id=p.id
  ) update actions set status='cancelled',version=version+1 where task_id in(select id from tree)
    and status in ('proposed','awaiting_approval','ready') returning id,version,task_id`.execute(tx)
  ).rows;
  for (const row of rows) {
    await sql`update action_approvals set status='revoked' where action_id=${row.id} and status in ('pending','approved')`.execute(
      tx,
    );
    await appendEvent(tx, auth, {
      aggregateType: 'action',
      aggregateId: row.id,
      version: row.version,
      type: 'action.cancelled',
      payload: { task_id: row.task_id, stopped_by_task_id: taskId },
      target: `task:${row.task_id}`,
    });
  }
  return rows.length;
}
