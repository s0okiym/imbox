import { sql, type TenantTransaction } from '@imbox/db';
/** Compose with the Action completion gate inside the caller's already root-locked transaction. */
export async function runtimeCompletionGate(
  tx: TenantTransaction,
  taskId: string,
): Promise<boolean> {
  const result = await sql<{ closed: boolean }>`with recursive subtree as (
  select id from tasks where id=${taskId}
  union all select t.id from tasks t join subtree s on t.parent_task_id=s.id
 ) select not exists(select 1 from agent_runs r join subtree s on s.id=r.task_id
   where r.status not in ('completed','failed','cancelled','expired'))
   and not exists(select 1 from runtime_reservations rr join subtree s on s.id=rr.task_id
   where rr.status in ('held','unknown')) as closed`.execute(tx);
  return result.rows[0]?.closed === true;
}
