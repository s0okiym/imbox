import { createHash } from 'node:crypto';
import {
  authorizeConversation,
  authorizeTenant,
  taskOwnerAvailable,
  authorizeWorkspace,
  ApplicationError,
  type AuthContext,
  type RuntimeSourcePort,
} from '@imbox/application';
import {
  lockTaskRoots,
  lockPrincipal,
  sql,
  withTenant,
  type Db,
  type TenantTransaction as Tx,
} from '@imbox/db';
import type { ContextItem, Installation, RunRow, SourceReference, TaskRow } from './types.js';
export function fail(code: string, status: number, message = code): never {
  throw new ApplicationError(code, status, message);
}
export const json = (value: unknown) => JSON.stringify(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(json(canonical(value)))
    .digest('hex');
export const money = (value: string) => {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    fail('VALIDATION_FAILED', 400);
  return BigInt(value);
};
export const id = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    fail('VALIDATION_FAILED', 400);
  return value;
};
export const runRow = async (tx: Tx, runId: string, lock = false): Promise<RunRow> =>
  (
    await sql<RunRow>`select * from agent_runs where id=${runId} ${lock ? sql`for update` : sql``}`.execute(
      tx,
    )
  ).rows[0] ?? fail('NOT_FOUND', 404);
export async function taskAccess(
  tx: Tx,
  auth: AuthContext,
  taskId: string,
  write = false,
): Promise<TaskRow> {
  const task =
    (await sql<TaskRow>`select * from tasks where id=${taskId}`.execute(tx)).rows[0] ??
    fail('NOT_FOUND', 404);
  await authorizeWorkspace(tx, auth, task.workspace_id);
  const participant = (
    await sql<{
      role: string;
    }>`select role from task_participants where task_id=${taskId} and principal_id=${auth.principalId} and status='active' for share`.execute(
      tx,
    )
  ).rows[0];
  if (!participant || (write && !['owner', 'contributor'].includes(participant.role)))
    fail('NOT_FOUND', 404);
  return task;
}
export async function ancestry(tx: Tx, taskId: string): Promise<TaskRow[]> {
  const root =
    (await sql<TaskRow>`select * from tasks where id=${taskId}`.execute(tx)).rows[0] ??
    fail('NOT_FOUND', 404);
  const tenant = (
    await sql<{ tenant: string }>`select current_setting('imbox.tenant_id') as tenant`.execute(tx)
  ).rows[0]!.tenant;
  await lockTaskRoots(tx, tenant, [root.root_task_id]);
  const ids = (
    await sql<{
      id: string;
    }>`with recursive chain as (select id,parent_task_id,0 as depth from tasks where id=${taskId} union all select t.id,t.parent_task_id,c.depth+1 from tasks t join chain c on t.id=c.parent_task_id) select id from chain order by depth desc`.execute(
      tx,
    )
  ).rows;
  const rows: TaskRow[] = [];
  for (const ref of ids)
    rows.push(
      (
        await sql<TaskRow>`select *, execution_deadline IS NULL OR execution_deadline > clock_timestamp() as deadline_valid from tasks where id=${ref.id} for update`.execute(
          tx,
        )
      ).rows[0]!,
    );
  for (const row of rows) row.owner_available = await taskOwnerAvailable(tx, row);
  return rows;
}
export function activeChain(rows: TaskRow[], captured?: { id: string; execution_epoch: string }[]) {
  if (
    captured &&
    (captured.length !== rows.length ||
      rows.some(
        (row, i) =>
          row.id !== captured[i]!.id || row.execution_epoch !== captured[i]!.execution_epoch,
      ))
  )
    fail('VERSION_CONFLICT', 409, 'Execution ancestry changed');
  for (const row of rows)
    if (
      row.archived ||
      !['open', 'active'].includes(row.status) ||
      row.deadline_valid === false ||
      row.owner_available === false
    )
      fail('VERSION_CONFLICT', 409, 'Task execution is not active');
}
export async function installation(
  tx: Tx,
  agentId: string,
  forShare = true,
): Promise<Installation> {
  const row =
    (
      await sql<Installation>`select * from agent_installations where id=${agentId} ${forShare ? sql`for share` : sql``}`.execute(
        tx,
      )
    ).rows[0] ?? fail('NOT_FOUND', 404);
  if (row.status !== 'active') fail('FORBIDDEN', 403);
  const principal = await tx
    .selectFrom('principals')
    .select(['status', 'kind'])
    .where('id', '=', row.agent_principal_id)
    .executeTakeFirst();
  if (principal?.kind !== 'agent' || principal.status !== 'active') fail('FORBIDDEN', 403);
  return row;
}
export async function principal(tx: Tx, principalId: string) {
  const row = await lockPrincipal(tx, principalId);
  if (!row || row.status !== 'active') fail('FORBIDDEN', 403);
  return row;
}
export async function scopeAuthorization(
  tx: Tx,
  creator: AuthContext,
  agent: AuthContext,
  taskId: string | null,
  conversationId: string | null,
) {
  let workspaceId: string;
  let scope: Record<string, unknown>;
  if (taskId) {
    const task = await taskAccess(tx, creator, taskId, true);
    await taskAccess(tx, agent, taskId, true);
    workspaceId = task.workspace_id;
    const members = (
      await sql<{
        principal_id: string;
        version: string;
      }>`select principal_id,version from task_participants where task_id=${taskId} and principal_id in (${creator.principalId},${agent.principalId}) order by principal_id`.execute(
        tx,
      )
    ).rows;
    scope = { task_authz_generation: task.authz_generation, members };
  } else {
    const a = await authorizeConversation(tx, creator, conversationId!);
    const b = await authorizeConversation(tx, agent, conversationId!);
    if (!a.row.workspace_id) fail('NOT_FOUND', 404);
    workspaceId = a.row.workspace_id;
    scope = {
      conversation_generation: a.row.authz_generation,
      creator_member_version: a.member.version,
      agent_member_version: b.member.version,
    };
  }
  const workspaceMembers = (
    await sql<{
      principal_id: string;
      version: string;
    }>`select principal_id,version from memberships where workspace_id=${workspaceId} and principal_id in (${creator.principalId},${agent.principalId}) order by principal_id`.execute(
      tx,
    )
  ).rows;
  return { ...scope, workspace_members: workspaceMembers };
}
export async function liveActors(tx: Tx, run: RunRow) {
  const creatorPrincipal = await principal(tx, run.created_by);
  if (creatorPrincipal.version !== run.creator_principal_version) fail('FORBIDDEN', 403);
  const creator: AuthContext = {
    tenantId: run.tenant_id,
    principalId: run.created_by,
    kind: creatorPrincipal.kind,
    authzRevision: run.creator_authz_revision,
  };
  await authorizeTenant(tx, creator);
  const agentInstall = await installation(tx, run.agent_id);
  if (agentInstall.authz_revision !== run.installation_authz_revision) fail('FORBIDDEN', 403);
  const agentPrincipal = await principal(tx, agentInstall.agent_principal_id);
  if (agentPrincipal.version !== run.agent_principal_version) fail('FORBIDDEN', 403);
  const agent: AuthContext = {
    tenantId: run.tenant_id,
    principalId: agentInstall.agent_principal_id,
    kind: agentPrincipal.kind,
    authzRevision: run.agent_authz_revision,
  };
  await authorizeTenant(tx, agent);
  // Match Task commands: tenant checks, tree root, ancestor rows, then workspace/participants.
  if (run.task_id) await ancestry(tx, run.task_id);
  const scope = await scopeAuthorization(tx, creator, agent, run.task_id, run.conversation_id);
  if (hash(scope) !== hash(run.scope_authorization))
    fail('FORBIDDEN', 403, 'Execution authorization changed');
  return { creator, agent, agentInstall };
}
/** Safe only for DB-only callbacks: no model calls, tool effects, or network work inside retries. */
export async function runtimeTransaction<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenant(db, tenantId, fn);
    } catch (error) {
      if (
        attempt >= 2 ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        !['40001', '40P01'].includes(String(error.code))
      )
        throw error;
    }
  }
}
export async function source(
  tx: Tx,
  creator: AuthContext,
  agent: AuthContext,
  ref: SourceReference,
  conversationId: string | null,
  taskId: string | null = null,
  sources?: RuntimeSourcePort,
): Promise<{ payload: Record<string, unknown>; authorization: Record<string, unknown> }> {
  if (ref.type === 'memory' || ref.type === 'artifact_version') {
    if (!sources || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail('VALIDATION_FAILED', 400);
    return sources.read(tx, { creator, agent, reference: ref, scope: { conversationId, taskId } });
  }
  if (ref.type === 'message') {
    let message = await tx
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', ref.id)
      .executeTakeFirst();
    if (
      !message ||
      message.deleted_at ||
      message.version !== ref.version ||
      (conversationId && message.conversation_id !== conversationId)
    )
      fail('NOT_FOUND', 404);
    const a = await authorizeConversation(tx, creator, message.conversation_id);
    const b = await authorizeConversation(tx, agent, message.conversation_id);
    message = await tx
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', ref.id)
      .forShare()
      .executeTakeFirst();
    if (!message || message.deleted_at || message.version !== ref.version) fail('NOT_FOUND', 404);
    if (
      BigInt(message.seq) < BigInt(a.member.visible_from_seq) ||
      BigInt(message.seq) < BigInt(b.member.visible_from_seq)
    )
      fail('NOT_FOUND', 404);
    return {
      payload: {
        body: message.body,
        conversation_id: message.conversation_id,
        sender_principal_id: message.sender_principal_id,
      },
      authorization: {
        conversation_generation: a.row.authz_generation,
        creator_member_version: a.member.version,
        agent_member_version: b.member.version,
      },
    };
  }
  if (conversationId)
    fail(
      'DISCLOSURE_DENIED',
      403,
      'Task content cannot be implicitly disclosed in a conversation run',
    );
  await taskAccess(tx, creator, ref.id);
  await taskAccess(tx, agent, ref.id);
  const task =
    (await sql<TaskRow>`select * from tasks where id=${ref.id} for share`.execute(tx)).rows[0] ??
    fail('NOT_FOUND', 404);
  if (task.version !== ref.version) fail('VERSION_CONFLICT', 409);
  return {
    payload: { title: task.title, goal: task.goal },
    authorization: { task_epoch: task.execution_epoch, task_version: task.version },
  };
}
export async function verifyContext(
  tx: Tx,
  run: RunRow,
  creator: AuthContext,
  agent: AuthContext,
  sources?: RuntimeSourcePort,
) {
  const rows = (
    await sql<ContextItem>`select ordinal,source_type,source_id,source_version,source_sha256,content_hash,required,trust_level,payload,authorization_snapshot from context_items where manifest_id=${run.context_manifest_id} order by ordinal`.execute(
      tx,
    )
  ).rows;
  for (const item of rows) {
    const current = await source(
      tx,
      creator,
      agent,
      item.source_type === 'memory' || item.source_type === 'artifact_version'
        ? {
            type: item.source_type,
            id: item.source_id,
            version: item.source_version,
            required: item.required,
            sha256: item.source_sha256 ?? '',
          }
        : {
            type: item.source_type,
            id: item.source_id,
            version: item.source_version,
            required: item.required,
          },
      run.conversation_id,
      run.task_id,
      sources,
    );
    if (
      hash(current.payload) !== item.content_hash ||
      hash(current.authorization) !== hash(item.authorization_snapshot)
    )
      fail('VERSION_CONFLICT', 409, 'Context authorization or content changed');
  }
  return rows;
}
