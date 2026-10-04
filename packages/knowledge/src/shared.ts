import { createHash } from 'node:crypto';
import { ApplicationError, authorizeTenant, type AuthContext } from '@imbox/application';
import { sql, lockPrincipal, type TenantTransaction as Tx } from '@imbox/db';
export type SourceKind = 'message' | 'task' | 'artifact_version';
export interface SourceRef {
  kind: SourceKind;
  id: string;
  version: string;
  sha256: string;
}
export interface MemoryInput {
  scope: 'personal' | 'conversation' | 'task';
  conversation_id?: string;
  task_id?: string;
  body: string;
  source_refs: SourceRef[];
  confirmation: 'confirmed' | 'needs_confirmation' | 'conflicted';
  confidence: number;
  expires_at?: string | null;
  status?: 'active' | 'disabled';
}
export interface SourceView {
  kind: SourceKind;
  id: string;
  version: string;
  sha256: string;
  body: string;
  title: string;
  conversation_id: string | null;
  task_id: string | null;
  workspace_id: string | null;
  scope_generation: string;
  member_version: string;
  workspace_version: string;
  created_at: Date;
}
export interface MemoryRow {
  id: string;
  created_by: string;
  scope: MemoryInput['scope'];
  conversation_id: string | null;
  task_id: string | null;
  version: string;
  status: 'active' | 'disabled' | 'restricted' | 'deleted';
  confirmation: MemoryInput['confirmation'];
  confidence: number;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
export function fail(code: string, status: number): never {
  throw new ApplicationError(code, status);
}
export const json = (v: unknown) => JSON.stringify(v);
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const normalizeQuery = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export async function authorize(tx: Tx, auth: AuthContext) {
  await authorizeTenant(tx, auth);
  const p = await lockPrincipal(tx, auth.principalId);
  if (p?.status !== 'active' || p.kind !== auth.kind) fail('FORBIDDEN', 403);
  return p!;
}
/** ACL predicates live inside the SQL candidate query, before text matching or limits. */
export function conversationVisible(auth: Pick<AuthContext, 'principalId'>, alias: string) {
  return sql<boolean>`exists(select 1 from conversations c join conversation_members cm on cm.tenant_id=c.tenant_id and cm.conversation_id=c.id left join memberships wm on wm.tenant_id=c.tenant_id and wm.workspace_id=c.workspace_id and wm.principal_id=${auth.principalId} where c.id=${sql.ref(alias)} and cm.principal_id=${auth.principalId} and cm.status='active' and (c.workspace_id is null or wm.status='active'))`;
}
export function taskVisible(auth: Pick<AuthContext, 'principalId'>, alias: string) {
  return sql<boolean>`exists(select 1 from tasks t join task_participants tp on tp.tenant_id=t.tenant_id and tp.task_id=t.id join memberships wm on wm.tenant_id=t.tenant_id and wm.workspace_id=t.workspace_id and wm.principal_id=${auth.principalId} where t.id=${sql.ref(alias)} and tp.principal_id=${auth.principalId} and tp.status='active' and wm.status='active' and not t.archived)`;
}
export function sourceViews(auth: { principalId: string | ReturnType<typeof sql.ref> }) {
  return sql<SourceView>`
 select 'message'::text as kind,m.id,m.version,encode(sha256(convert_to(m.body,'UTF8')),'hex') as sha256,m.body,c.title as title,m.conversation_id,null::uuid as task_id,c.workspace_id,c.authz_generation as scope_generation,cm.version as member_version,coalesce(wm.version,0) as workspace_version,m.created_at
 from messages m join conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id join conversation_members cm on cm.tenant_id=m.tenant_id and cm.conversation_id=c.id and cm.principal_id=${auth.principalId} left join memberships wm on wm.tenant_id=c.tenant_id and wm.workspace_id=c.workspace_id and wm.principal_id=${auth.principalId}
 where m.deleted_at is null and cm.status='active' and m.seq>=cm.visible_from_seq and (c.workspace_id is null or wm.status='active')
 union all
 select 'task',t.id,t.version,encode(sha256(convert_to(t.title||E'\n'||t.goal||E'\n'||t.acceptance_criteria::text,'UTF8')),'hex'),t.title||E'\n'||t.goal||E'\n'||t.acceptance_criteria::text,t.title,null::uuid,t.id,t.workspace_id,t.authz_generation,tp.version,wm.version,t.created_at
 from tasks t join task_participants tp on tp.tenant_id=t.tenant_id and tp.task_id=t.id and tp.principal_id=${auth.principalId} join memberships wm on wm.tenant_id=t.tenant_id and wm.workspace_id=t.workspace_id and wm.principal_id=${auth.principalId} where tp.status='active' and wm.status='active' and not t.archived
 union all
 select 'artifact_version',av.id,av.version,r.sha256,coalesce(d.body,''),a.title||' '||r.filename,a.conversation_id,a.task_id,coalesce(c.workspace_id,t.workspace_id),coalesce(c.authz_generation,t.authz_generation),coalesce(cm.version,tp.version),coalesce(wm.version,0),av.created_at
 from artifact_versions av join artifacts a on a.tenant_id=av.tenant_id and a.id=av.artifact_id join resources r on r.tenant_id=av.tenant_id and r.id=av.resource_id
 left join resource_text_documents d on d.tenant_id=r.tenant_id and d.resource_id=r.id and d.resource_version=r.version and d.sha256=r.sha256
 left join conversations c on c.tenant_id=a.tenant_id and c.id=a.conversation_id left join conversation_members cm on cm.tenant_id=a.tenant_id and cm.conversation_id=c.id and cm.principal_id=${auth.principalId}
 left join tasks t on t.tenant_id=a.tenant_id and t.id=a.task_id left join task_participants tp on tp.tenant_id=a.tenant_id and tp.task_id=t.id and tp.principal_id=${auth.principalId}
 left join memberships wm on wm.tenant_id=a.tenant_id and wm.workspace_id=coalesce(c.workspace_id,t.workspace_id) and wm.principal_id=${auth.principalId}
 where r.deleted_at is null and ((a.conversation_id is not null and cm.status='active' and (c.workspace_id is null or wm.status='active') and (c.history_policy='all' or (cm.joined_at<=a.created_at and cm.joined_at<=r.created_at))) or (a.task_id is not null and tp.status='active' and wm.status='active' and not t.archived))
 `;
}
export function memoryVisible(auth: Pick<AuthContext, 'principalId'>, alias = 'mi') {
  return sql<boolean>`((${sql.ref(`${alias}.scope`)}='personal' and ${sql.ref(`${alias}.created_by`)}=${auth.principalId}) or (${sql.ref(`${alias}.scope`)}='conversation' and ${conversationVisible(auth, `${alias}.conversation_id`)} and exists(select 1 from conversations c join conversation_members cm on cm.tenant_id=c.tenant_id and cm.conversation_id=c.id where c.id=${sql.ref(`${alias}.conversation_id`)} and cm.principal_id=${auth.principalId} and (c.history_policy='all' or cm.joined_at<=${sql.ref(`${alias}.created_at`)}))) or (${sql.ref(`${alias}.scope`)}='task' and ${taskVisible(auth, `${alias}.task_id`)}))`;
}
/** Caller-visible sources are materialized by the caller as source_view. */
export function memorySourcesLive(alias = 'mi') {
  return sql<boolean>`not exists(select 1 from memory_sources ms where ms.memory_id=${sql.ref(`${alias}.id`)} and ms.memory_version=${sql.ref(`${alias}.version`)} and (not exists(select 1 from source_view sv where sv.id=coalesce(ms.source_message_id,ms.source_task_id,ms.source_artifact_version_id) and sv.kind=case when ms.source_message_id is not null then 'message' when ms.source_task_id is not null then 'task' else 'artifact_version' end and sv.version=ms.source_version and sv.sha256=ms.sha256 and sv.scope_generation::text=ms.authorization_fence->>'scope_generation') or not exists(select 1 from (${sourceViews({ principalId: sql.ref(`${alias}.created_by`) })}) creator_source join principals creator on creator.id=${sql.ref(`${alias}.created_by`)} join tenant_principals creator_tenant on creator_tenant.principal_id=creator.id where creator_source.id=coalesce(ms.source_message_id,ms.source_task_id,ms.source_artifact_version_id) and creator_source.kind=case when ms.source_message_id is not null then 'message' when ms.source_task_id is not null then 'task' else 'artifact_version' end and creator_source.member_version::text=ms.authorization_fence->>'creator_member_version' and creator_source.workspace_version::text=ms.authorization_fence->>'creator_workspace_version' and creator.status='active' and creator_tenant.status='active' and creator_tenant.authz_revision::text=ms.authorization_fence->>'creator_authz_revision' and creator.version::text=ms.authorization_fence->>'creator_principal_version'))) `;
}
export async function authorizationBinding(tx: Tx, auth: AuthContext) {
  const row = (
    await sql<{
      generation: string;
    }>`select md5(coalesce(string_agg(value,'|' order by value),'')) as generation from (
 select 'w:'||workspace_id||':'||version||':'||status as value from memberships where principal_id=${auth.principalId}
 union all select 'c:'||cm.conversation_id||':'||cm.version||':'||cm.status||':'||c.authz_generation from conversation_members cm join conversations c on c.tenant_id=cm.tenant_id and c.id=cm.conversation_id where cm.principal_id=${auth.principalId}
 union all select 't:'||tp.task_id||':'||tp.version||':'||tp.status||':'||t.authz_generation||':'||t.archived from task_participants tp join tasks t on t.tenant_id=tp.tenant_id and t.id=tp.task_id where tp.principal_id=${auth.principalId}
 ) acl`.execute(tx)
  ).rows[0]!;
  return row.generation;
}
