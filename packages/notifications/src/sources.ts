import { sql, type TenantTransaction as Tx } from '@imbox/db';
export type Category = 'message' | 'task' | 'request' | 'action' | 'run';
export interface Source {
  source_kind: Category;
  source_id: string;
  source_version: string;
  ordering_version: string;
  topic_key: string;
  category: Category;
  conversation_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  recipient_id: string | null;
  created_at: Date;
  seq: string | null;
  approver_ids: string[] | null;
}
/** This authoritative view deliberately projects no source title, text, parameters or output.
 * Statement time keeps deadline checks current on each read while allowing source-ID predicates
 * to reach each UNION branch. Volatile clock_timestamp() materializes the entire tenant history.
 */
export const sources = sql`with notification_sources as not materialized (
 select 'message'::text source_kind,m.id source_id,m.version source_version,m.seq ordering_version,'conversation:'||m.conversation_id::text topic_key,'message'::text category,m.conversation_id,null::uuid task_id,c.workspace_id,null::uuid recipient_id,m.created_at,m.seq,null::jsonb approver_ids
 from messages m join conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id where m.deleted_at is null
 union all select 'task',t.id,t.version,t.version,'task:'||t.id::text,'task',null,t.id,t.workspace_id,null,t.created_at,null,null from tasks t where not t.archived and t.status in('blocked','in_review')
 union all select 'request',r.id,r.version,r.version,'request:'||r.id::text,'request',null,t.id,t.workspace_id,case when r.status='clarification_requested' then r.requester_principal_id else r.recipient_principal_id end,r.created_at,null,null
 from collaboration_requests r join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id where r.status in('pending','clarification_requested') and r.expires_at>statement_timestamp() and t.execution_epoch=r.task_epoch and t.goal_version=r.goal_version and not t.archived and t.status not in('completed','cancelled','failed') and not exists(select 1 from jsonb_array_elements(r.ancestor_fences) f left join tasks a on a.id=(f->>'taskId')::uuid where a.id is null or a.execution_epoch::text<>f->>'executionEpoch' or a.archived or a.status in('completed','cancelled','failed'))
 union all select 'action',a.id,a.version,a.version,'action:'||a.id::text,'action',null,t.id,t.workspace_id,case when a.status='unknown' then a.requester_id else null end,a.created_at,null,case when a.status='awaiting_approval' then g.approver_ids else null end
 from actions a join tasks t on t.tenant_id=a.tenant_id and t.id=a.task_id join capability_grants g on g.tenant_id=a.tenant_id and g.id=a.grant_id where a.status in('awaiting_approval','unknown') and not t.archived and g.status='active' and g.revision=a.grant_revision and (a.status='unknown' or (g.expires_at>statement_timestamp() and exists(select 1 from action_approvals ap where ap.action_id=a.id and ap.status='pending' and ap.expires_at>statement_timestamp()))) and not exists(select 1 from jsonb_array_elements(a.ancestor_fences) f left join tasks z on z.id=(f->>'taskId')::uuid where z.id is null or z.execution_epoch::text<>f->>'executionEpoch' or z.archived or z.status in('completed','cancelled','failed'))
 union all select 'run',r.id,r.version,r.version,'run:'||r.id::text,'run',r.conversation_id,r.task_id,coalesce(c.workspace_id,t.workspace_id),r.created_by,r.created_at,null,null
 from agent_runs r left join tasks t on t.tenant_id=r.tenant_id and t.id=r.task_id left join conversations c on c.tenant_id=r.tenant_id and c.id=r.conversation_id where r.status in('waiting_input','waiting_approval','waiting_dependency','paused','failed') and exists(select 1 from principals cp join tenant_principals ct on ct.principal_id=cp.id where cp.id=r.created_by and cp.status='active' and cp.version=r.creator_principal_version and ct.status='active' and ct.authz_revision=r.creator_authz_revision)
)`;
/** Per-caller ACL is applied in SQL before paging/counts. Generation capture prevents withdrawal/re-add revival. */
export const joins = sql`join principals p on p.id=tp.principal_id and p.status='active' and p.kind='human'
 join tenants ten on ten.id=tp.tenant_id and ten.status='active'
 left join memberships wm on wm.workspace_id=s.workspace_id and wm.tenant_id=tp.tenant_id and wm.principal_id=tp.principal_id and wm.status='active'
 left join conversations c on c.id=s.conversation_id and c.tenant_id=tp.tenant_id
 left join conversation_members cm on cm.conversation_id=c.id and cm.tenant_id=tp.tenant_id and cm.principal_id=tp.principal_id and cm.status='active'
 left join tasks t on t.id=s.task_id and t.tenant_id=tp.tenant_id
 left join task_participants tm on tm.task_id=t.id and tm.tenant_id=tp.tenant_id and tm.principal_id=tp.principal_id and tm.status='active'`;
export const visible = sql`tp.status='active' and (s.workspace_id is null or wm.principal_id is not null)
 and (s.recipient_id is null or s.recipient_id=tp.principal_id) and (s.approver_ids is null or s.approver_ids ? tp.principal_id::text)
 and ((s.conversation_id is not null and cm.principal_id is not null and (s.seq is null or s.seq>=cm.visible_from_seq) and (c.history_policy='all' or s.created_at>=cm.joined_at or s.seq>=cm.visible_from_seq))
 or(s.task_id is not null and not t.archived and (s.source_kind='request' or tm.principal_id is not null)))`;
export const fence = sql`jsonb_build_array(p.version,tp.authz_revision,wm.version,c.authz_generation,cm.version,cm.visible_from_seq,t.authz_generation,t.execution_epoch,tm.version,(with recursive ancestors as(select id,parent_task_id,execution_epoch,archived,status from tasks where id=t.id union all select a.id,a.parent_task_id,a.execution_epoch,a.archived,a.status from tasks a join ancestors z on z.parent_task_id=a.id) select jsonb_agg(jsonb_build_array(id,execution_epoch,archived,status in('completed','cancelled','failed')) order by id) from ancestors))`;
export interface VisibleSource extends Source {
  principal_id: string;
  authorization_fence: unknown;
}
export async function source(tx: Tx, kind: string, id: string) {
  return (
    await sql<Source>`${sources} select * from notification_sources where source_kind=${kind} and source_id=${id}`.execute(
      tx,
    )
  ).rows[0];
}
export function intentQuery(principalId: string) {
  return sql` ${sources} select n.*,s.conversation_id,s.task_id,s.category as live_category,s.source_version as live_source_version,
 coalesce(mu.muted,false) as silent from notification_intents n join notification_sources s on s.source_kind=n.source_kind and s.source_id=n.source_id
 join tenant_principals tp on tp.principal_id=n.recipient_id and tp.tenant_id=n.tenant_id ${joins}
 left join notification_mutes mu on mu.tenant_id=n.tenant_id and mu.principal_id=n.recipient_id and mu.conversation_id=s.conversation_id
 where n.recipient_id=${principalId} and ${visible} and ${fence}=n.authorization_fence`;
}
