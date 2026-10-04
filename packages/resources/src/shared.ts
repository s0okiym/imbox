import { createHash, randomUUID } from 'node:crypto';
import {
  ApplicationError,
  authorizeTenant,
  authorizeWorkspace,
  authorizeConversation,
  type AuthContext,
} from '@imbox/application';
import { sql, lockTaskRoots, lockPrincipal, type TenantTransaction as Tx } from '@imbox/db';
export type Scope = { conversation_id: string | null; task_id: string | null };
export interface UploadRow extends Scope {
  id: string;
  resource_id: string;
  created_by: string;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  staging_key: string;
  object_key: string;
  authorization_fence: Record<string, unknown>;
  status: string;
  version: string;
  verification_generation: string;
  expires_at: Date;
  created_at: Date;
  live?: boolean;
}
export interface ResourceRow extends Scope {
  id: string;
  upload_id: string;
  created_by: string;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  object_key: string;
  version: string;
  authz_generation: string;
  created_at: Date;
  deleted_at: Date | null;
}
export interface ArtifactRow extends Scope {
  id: string;
  created_by: string;
  title: string;
  kind: 'text' | 'markdown' | 'file';
  version: string;
  head_version: string;
  created_at: Date;
}
export function fail(code: string, status: number, message = code): never {
  throw new ApplicationError(code, status, message);
}
export const json = (value: unknown) => JSON.stringify(value);
export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, value]) => [k, canonical(value)]),
    );
  return v;
}
export const same = (a: unknown, b: unknown) => json(canonical(a)) === json(canonical(b));
export const resourceDto = (row: ResourceRow) => ({
  id: row.id,
  filename: row.filename,
  content_type: row.content_type,
  byte_size: row.byte_size,
  sha256: row.sha256,
  version: row.version,
  conversation_id: row.conversation_id,
  task_id: row.task_id,
  created_by: row.created_by,
  created_at: row.created_at.toISOString(),
  download_path: `/v1/resources/${row.id}/content`,
});
export async function scopeAccess(
  tx: Tx,
  auth: AuthContext,
  scope: Scope,
  write = false,
  createdAt?: Date,
) {
  await authorizeTenant(tx, auth);
  const principal = await lockPrincipal(tx, auth.principalId);
  if (principal?.status !== 'active') fail('FORBIDDEN', 403);
  if (scope.conversation_id) {
    const access = await authorizeConversation(tx, auth, scope.conversation_id, write);
    if (
      createdAt &&
      access.row.history_policy === 'since_join' &&
      access.member.joined_at > createdAt
    )
      fail('NOT_FOUND', 404);
    return {
      principal_version: principal.version,
      conversation_generation: access.row.authz_generation,
      member_version: access.member.version,
      workspace_version: access.row.workspace_id
        ? (await authorizeWorkspace(tx, auth, access.row.workspace_id)).version
        : null,
    };
  }
  const initial = (
    await sql<{
      id: string;
      root_task_id: string;
      workspace_id: string | null;
      authz_generation: string;
    }>`select id,root_task_id,workspace_id,authz_generation from tasks where id=${scope.task_id}`.execute(
      tx,
    )
  ).rows[0];
  if (!initial?.workspace_id) fail('NOT_FOUND', 404);
  await lockTaskRoots(tx, auth.tenantId, [initial.root_task_id]);
  const chain = (
    await sql<{
      id: string;
      execution_epoch: string;
      status: string;
      archived: boolean;
    }>`with recursive ancestors as (select id,parent_task_id,0 as depth from tasks where id=${scope.task_id} union all select t.id,t.parent_task_id,a.depth+1 from tasks t join ancestors a on a.parent_task_id=t.id) select t.id,t.execution_epoch,t.status,t.archived from tasks t join ancestors a on a.id=t.id order by a.depth desc for share of t`.execute(
      tx,
    )
  ).rows;
  if (
    write &&
    chain.some(
      (row) => row.archived || ['completed', 'cancelled', 'failed', 'expired'].includes(row.status),
    )
  )
    fail('VERSION_CONFLICT', 409);
  const workspace = await authorizeWorkspace(tx, auth, initial.workspace_id);
  const member = (
    await sql<{
      role: string;
      version: string;
    }>`select role,version from task_participants where task_id=${scope.task_id} and principal_id=${auth.principalId} and status='active' for share`.execute(
      tx,
    )
  ).rows[0];
  if (!member || (write && !['owner', 'contributor'].includes(member.role))) fail('NOT_FOUND', 404);
  return {
    principal_version: principal.version,
    task_generation: initial.authz_generation,
    member_version: member.version,
    workspace_version: workspace.version,
    ancestor_fences: chain.map((row) => ({ id: row.id, execution_epoch: row.execution_epoch })),
  };
}
export async function resource(tx: Tx, auth: AuthContext, id: string, write = false) {
  const row = (await sql<ResourceRow>`select * from resources where id=${id}`.execute(tx)).rows[0];
  if (!row || row.deleted_at) fail('NOT_FOUND', 404);
  await scopeAccess(tx, auth, row, write);
  const visible = (
    await sql<{
      visible: boolean;
    }>`select ${resourceHistorySql(auth)} as visible from resources r where r.id=${id}`.execute(tx)
  ).rows[0]?.visible;
  if (!visible) fail('NOT_FOUND', 404);
  const current = (
    await sql<ResourceRow>`select * from resources where id=${id} for share`.execute(tx)
  ).rows[0];
  if (!current || current.deleted_at) fail('NOT_FOUND', 404);
  return current;
}
export async function queueCleanup(
  tx: Tx,
  tenantId: string,
  key: string,
  uploadId: string | null,
  resourceId: string | null,
) {
  await sql`insert into resource_cleanup_jobs(tenant_id,id,object_key,upload_id,resource_id) values(${tenantId},${randomUUID()},${key},${uploadId},${resourceId}) on conflict(tenant_id,object_key) do update set status=case when resource_cleanup_jobs.status='done' then 'pending' else resource_cleanup_jobs.status end,updated_at=clock_timestamp()`.execute(
    tx,
  );
}
/** A visible message is an explicit same-conversation disclosure of an older upload. */
export function resourceHistorySql(auth: AuthContext, alias = 'r') {
  return sql<boolean>`(${sql.ref(`${alias}.task_id`)} is not null or exists(select 1 from conversations c join conversation_members cm on cm.tenant_id=c.tenant_id and cm.conversation_id=c.id where c.id=${sql.ref(`${alias}.conversation_id`)} and cm.principal_id=${auth.principalId} and cm.status='active' and (c.history_policy='all' or cm.joined_at<=${sql.ref(`${alias}.created_at`)} or exists(select 1 from message_resources mr join messages m on m.tenant_id=mr.tenant_id and m.id=mr.message_id where mr.resource_id=${sql.ref(`${alias}.id`)} and mr.resource_version=${sql.ref(`${alias}.version`)} and m.conversation_id=c.id and m.seq>=cm.visible_from_seq and m.deleted_at is null))))`;
}
