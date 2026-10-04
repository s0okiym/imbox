import { randomUUID, randomBytes } from 'node:crypto';
import { assertContract } from '@imbox/contracts';
import {
  sql,
  withTenant,
  lockTaskRoots,
  lockPrincipal,
  type Db,
  type TenantTransaction as Tx,
} from '@imbox/db';
import { appendEvent, authorizeTenant, CursorCodec, type AuthContext } from './common.js';
export const MAINTENANCE_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001';
/** A disabled owner blocks descendants immediately at admission, before the background projection catches up. */
export async function taskOwnerAvailable(
  tx: Tx,
  task: { id: string; workspace_id: string | null; owner_principal_id: string },
): Promise<boolean> {
  const p = await lockPrincipal(tx, task.owner_principal_id);
  if (!p || p.status !== 'active') return false;
  const member = await tx
    .selectFrom('tenant_principals')
    .select('status')
    .where('principal_id', '=', task.owner_principal_id)
    .forShare()
    .executeTakeFirst();
  if (member?.status !== 'active' || !task.workspace_id) return false;
  const workspace = await tx
    .selectFrom('memberships')
    .select('status')
    .where('workspace_id', '=', task.workspace_id)
    .where('principal_id', '=', task.owner_principal_id)
    .forShare()
    .executeTakeFirst();
  if (workspace?.status !== 'active') return false;
  const participant = (
    await sql<{
      status: string;
      role: string;
    }>`select status,role from task_participants where task_id=${task.id} and principal_id=${task.owner_principal_id} for share`.execute(
      tx,
    )
  ).rows[0];
  if (participant?.status !== 'active' || participant.role !== 'owner') return false;
  if (p.kind === 'agent') {
    const installed = (
      await sql<{
        status: string;
      }>`select status from agent_installations where agent_principal_id=${p.id} for share`.execute(
        tx,
      )
    ).rows[0];
    if (installed?.status !== 'active') return false;
  }
  return true;
}
interface TaskRow {
  id: string;
  root_task_id: string;
  workspace_id: string;
  owner_principal_id: string;
  accountable_principal_id: string;
  status: string;
  blocked_from: string | null;
  state_reason: string | null;
  execution_epoch: string;
  version: string;
  execution_deadline: Date | null;
}
export function createTaskMaintenance(db: Db, cursorSecret = randomBytes(32).toString('hex')) {
  const cursors = new CursorCodec(cursorSecret);
  async function systemActor(tx: Tx, tenantId: string): Promise<AuthContext> {
    const p = await lockPrincipal(tx, MAINTENANCE_PRINCIPAL_ID);
    if (p?.kind !== 'service' || p.status !== 'active')
      throw new Error('Maintenance identity unavailable');
    await tx
      .insertInto('tenant_principals')
      .values({ tenant_id: tenantId, principal_id: p.id, role: 'member' })
      .onConflict((c) => c.columns(['tenant_id', 'principal_id']).doNothing())
      .execute();
    const membership = await tx
      .selectFrom('tenant_principals')
      .select('authz_revision')
      .where('principal_id', '=', p.id)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const auth: AuthContext = {
      tenantId,
      principalId: p.id,
      kind: 'service',
      authzRevision: membership.authz_revision,
    };
    await authorizeTenant(tx, auth);
    return auth;
  }
  async function escalate(
    tx: Tx,
    auth: AuthContext,
    t: TaskRow,
    reason: 'owner_unavailable' | 'execution_deadline',
  ) {
    const assigned =
      (
        await sql<{
          principal_id: string;
        }>`select m.principal_id from memberships m join tenant_principals tp on tp.tenant_id=m.tenant_id and tp.principal_id=m.principal_id join principals p on p.id=m.principal_id where m.workspace_id=${t.workspace_id} and m.status='active' and tp.status='active' and p.status='active' and p.kind='human' and (m.principal_id=${t.accountable_principal_id} or m.role='admin') order by (m.principal_id=${t.accountable_principal_id}) desc,m.principal_id limit 1`.execute(
          tx,
        )
      ).rows[0]?.principal_id ?? null;
    await sql`insert into task_escalations(tenant_id,id,task_id,workspace_id,unavailable_owner_id,assigned_to,task_epoch,reason) values(${auth.tenantId},${randomUUID()},${t.id},${t.workspace_id},${t.owner_principal_id},${assigned},${t.execution_epoch},${reason}) on conflict do nothing`.execute(
      tx,
    );
  }
  return {
    async process(tenantId: string, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Maintenance batch limit must be 1..100');
      // Candidate read holds no row locks. Each mutation subsequently acquires the task-tree lock first.
      const candidates = await withTenant(
        db,
        tenantId,
        async (tx) =>
          (
            await sql<TaskRow>`select t.* from tasks t left join tenant_principals tp on tp.tenant_id=t.tenant_id and tp.principal_id=t.owner_principal_id left join principals p on p.id=t.owner_principal_id left join memberships m on m.tenant_id=t.tenant_id and m.workspace_id=t.workspace_id and m.principal_id=t.owner_principal_id left join task_participants participant on participant.tenant_id=t.tenant_id and participant.task_id=t.id and participant.principal_id=t.owner_principal_id left join agent_installations a on a.tenant_id=t.tenant_id and a.agent_principal_id=t.owner_principal_id where t.status in ('open','active','in_review','blocked') and coalesce(t.state_reason,'') not in ('owner_unavailable','execution_deadline') and (p.status is distinct from 'active' or participant.status is distinct from 'active' or participant.role is distinct from 'owner' or tp.status is distinct from 'active' or m.status is distinct from 'active' or(p.kind='agent' and a.status is distinct from 'active') or t.execution_deadline<=clock_timestamp()) order by t.created_at,t.id limit ${limit}`.execute(
              tx,
            )
          ).rows,
      );
      let blocked = 0;
      for (const candidate of candidates)
        blocked += await withTenant(db, tenantId, async (tx) => {
          const auth = await systemActor(tx, tenantId);
          await lockTaskRoots(tx, tenantId, [candidate.root_task_id]);
          const t = (
            await sql<TaskRow>`select * from tasks where id=${candidate.id} for update`.execute(tx)
          ).rows[0]!;
          if (
            !['open', 'active', 'in_review', 'blocked'].includes(t.status) ||
            ['owner_unavailable', 'execution_deadline'].includes(t.state_reason ?? '')
          )
            return 0;
          const available = await taskOwnerAvailable(tx, t),
            time = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!
              .now;
          const expired = t.execution_deadline !== null && t.execution_deadline <= time;
          if (available && !expired) return 0;
          const reason = !available ? 'owner_unavailable' : 'execution_deadline';
          const updated = (
            await sql<TaskRow>`update tasks set status='blocked',blocked_from=case when status='blocked' then blocked_from else status end,state_reason=${reason},execution_epoch=execution_epoch+1,version=version+1,updated_at=clock_timestamp() where id=${t.id} returning *`.execute(
              tx,
            )
          ).rows[0]!;
          await escalate(tx, auth, updated, reason);
          await appendEvent(tx, auth, {
            aggregateType: 'task',
            aggregateId: t.id,
            version: updated.version,
            type: 'task.escalated',
            payload: { reason },
            target: `task:${t.id}`,
          });
          return 1;
        });
      const expiredRequests = await withTenant(db, tenantId, async (tx) => {
        const auth = await systemActor(tx, tenantId);
        const requests = (
          await sql<{
            id: string;
            version: string;
            task_id: string;
          }>`select id,version,task_id from collaboration_requests where status in ('pending','clarification_requested') and expires_at<=clock_timestamp() order by expires_at,id limit ${limit} for update skip locked`.execute(
            tx,
          )
        ).rows;
        for (const r of requests) {
          const version = String(BigInt(r.version) + 1n);
          await sql`update collaboration_requests set status='expired',version=${version},updated_at=clock_timestamp() where id=${r.id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'request',
            aggregateId: r.id,
            version,
            type: 'request.expired',
            payload: { task_id: r.task_id },
            target: `request:${r.id}`,
          });
        }
        await sql`update task_escalations e set status='resolved',resolved_at=clock_timestamp() from tasks t where t.tenant_id=e.tenant_id and t.id=e.task_id and e.status='open' and (t.status in ('completed','failed','cancelled') or t.owner_principal_id<>e.unavailable_owner_id)`.execute(
          tx,
        );
        return requests.length;
      });
      // An escalation stays actionable when its originally assigned human loses membership.
      await withTenant(db, tenantId, async (tx) => {
        await sql`update task_escalations e set assigned_to=null where e.status='open' and e.assigned_to is not null and not exists(select 1 from memberships m join tenant_principals tp on tp.tenant_id=m.tenant_id and tp.principal_id=m.principal_id join principals p on p.id=m.principal_id where m.workspace_id=e.workspace_id and m.principal_id=e.assigned_to and m.status='active' and tp.status='active' and p.status='active' and p.kind='human')`.execute(
          tx,
        );
      });
      return { blocked, expired_requests: expiredRequests };
    },
    async listEscalations(auth: AuthContext, cursor?: string) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        const binding = `escalations:${auth.tenantId}:${auth.principalId}:${auth.authzRevision}`;
        const after = cursor ? assertContract('Identifier', cursors.decode(cursor, binding)) : null;
        const rows = (
          await sql<{
            id: string;
            task_id: string;
            task_version: string;
            can_takeover: boolean;
            reason: string;
            assigned_to: string | null;
            created_at: Date;
          }>`select e.id,e.task_id,t.version as task_version,(${auth.kind}='human' and m.role='admin') as can_takeover,e.reason,e.assigned_to,e.created_at from task_escalations e join tasks t on t.tenant_id=e.tenant_id and t.id=e.task_id join memberships m on m.tenant_id=e.tenant_id and m.workspace_id=e.workspace_id and m.principal_id=${auth.principalId} where e.status='open' and (${after}::uuid is null or e.id>${after}::uuid) and m.status='active' and (e.assigned_to=${auth.principalId} or m.role='admin') order by e.id limit 101`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows.slice(0, 100).map((r) => ({ ...r, created_at: r.created_at.toISOString() })),
          ...(rows.length > 100 ? { next_cursor: cursors.encode(binding, rows[99]!.id) } : {}),
        };
      });
    },
  };
}

export type TaskMaintenance = ReturnType<typeof createTaskMaintenance>;
