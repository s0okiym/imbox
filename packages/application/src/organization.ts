import { createInvitationOperations } from './organization-invitations.js';
import { randomUUID } from 'node:crypto';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant, lockPrincipal, type Db, type TenantTransaction as Tx } from '@imbox/db';
import {
  authorizeTenant,
  command,
  appendEvent,
  CursorCodec,
  expectedVersion,
  fail,
  type AuthContext,
} from './common.js';
import { recordPolicy, type PolicyLedger } from './policy-ledger.js';

async function canManage(tx: Tx, auth: AuthContext) {
  const row = (
    await sql<{
      role: string;
    }>`select role from tenant_principals where principal_id=${auth.principalId}`.execute(tx)
  ).rows[0];
  return auth.kind === 'human' && (row?.role === 'owner' || row?.role === 'admin');
}
async function admin(tx: Tx, auth: AuthContext) {
  await authorizeTenant(tx, auth);
  if (!(await canManage(tx, auth))) fail('FORBIDDEN', 403);
}
async function workspace(tx: Tx, id: string, lock = false): Promise<C['ManagedWorkspace']> {
  const result = lock
    ? await sql<
        C['ManagedWorkspace']
      >`select id,name,version from workspaces where id=${id} for update`.execute(tx)
    : await sql<
        C['ManagedWorkspace']
      >`select id,name,version from workspaces where id=${id}`.execute(tx);
  return result.rows[0] ?? fail('NOT_FOUND', 404);
}
/** Serialize organization mutations before acquiring actor/target authorization locks. */
async function managementLock(tx: Tx, auth: AuthContext) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`organization:${auth.tenantId}`},0))`.execute(
    tx,
  );
  await admin(tx, auth);
}
const rank = { guest: 0, member: 1, admin: 2 };
const tenantRank = { guest: 0, member: 1, admin: 2, owner: 3 };
async function tenantMember(tx: Tx, id: string): Promise<C['ManagedTenantMember']> {
  const row = (
    await sql<
      C['ManagedTenantMember']
    >`select jsonb_build_object('id',p.id,'kind',p.kind,'display_name',p.display_name,'status',p.status) as principal,tp.role,tp.status,tp.version from tenant_principals tp join principals p on p.id=tp.principal_id where tp.principal_id=${id}`.execute(
      tx,
    )
  ).rows[0];
  return row ?? fail('NOT_FOUND', 404);
}
export function createOrganizationService(
  db: Db,
  secret: string,
  options: { policyLedger?: PolicyLedger } = {},
) {
  const cursors = new CursorCodec(secret);
  function page(auth: AuthContext, scope: string, input: C['PaginationQuery']) {
    assertContract('PaginationQuery', input);
    const limit = Math.min(input.limit ?? 50, 100);
    const binding = JSON.stringify([auth.tenantId, auth.principalId, auth.authzRevision, scope]);
    const after = input.cursor
      ? cursors.decode(input.cursor, binding)
      : '00000000-0000-0000-0000-000000000000';
    assertContract('Identifier', after);
    return {
      limit,
      after,
      finish<T>(rows: T[], id: (r: T) => string) {
        const items = rows.slice(0, limit);
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, id(items[items.length - 1]!)) }
            : {}),
        };
      },
    };
  }
  return {
    ...createInvitationOperations(db, secret, {
      ...options,
      authorizeManager: admin,
      lockManager: managementLock,
    }),
    listTenantMembers(auth: AuthContext, input: C['PaginationQuery'] = {}) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const p = page(auth, 'organization.tenant_members', input);
        const rows = (
          await sql<
            C['ManagedTenantMember']
          >`select jsonb_build_object('id',p.id,'kind',p.kind,'display_name',p.display_name,'status',p.status) as principal,tp.role,tp.status,tp.version from tenant_principals tp join principals p on p.id=tp.principal_id where p.id>${p.after}::uuid order by p.id limit ${p.limit + 1}`.execute(
            tx,
          )
        ).rows;
        return p.finish(rows, (r) => r.principal.id);
      });
    },
    setTenantMember(
      auth: AuthContext,
      id: string,
      input: C['SetTenantMemberInput'],
      version: string,
      key: string,
    ) {
      assertContract('Identifier', id);
      assertContract('SetTenantMemberInput', input);
      assertContract('Version', version);
      if (!input.reason.trim()) fail('VALIDATION_FAILED', 400);
      return withTenant(db, auth.tenantId, async (tx) => {
        await managementLock(tx, auth);
        await command(
          tx,
          auth,
          'organization.set_tenant_member',
          key,
          { id, input, version },
          async () => {
            const old = (
              await sql<{
                role: string;
                status: string;
                version: string;
                membership_policy_version: string;
              }>`select role,status,version,membership_policy_version from tenant_principals where principal_id=${id} for update`.execute(
                tx,
              )
            ).rows[0];
            if (!old) fail('NOT_FOUND', 404);
            const principal = await lockPrincipal(tx, id);
            if (principal?.kind !== 'human' || old.role === 'agent') fail('NOT_FOUND', 404);
            const actor = (
              await sql<{
                role: string;
              }>`select role from tenant_principals where principal_id=${auth.principalId}`.execute(
                tx,
              )
            ).rows[0]!;
            // Only an owner can grant or modify organization administrative authority.
            if (
              actor.role !== 'owner' &&
              (['owner', 'admin'].includes(old.role) || ['owner', 'admin'].includes(input.role))
            )
              fail('FORBIDDEN', 403);
            expectedVersion(old.version, version);
            if (old.status === 'historical') fail('FORBIDDEN', 403);
            if (input.status === 'active' && principal.status !== 'active') fail('FORBIDDEN', 403);
            if (old.role === input.role && old.status === input.status) return id;
            if (
              old.role === 'owner' &&
              old.status === 'active' &&
              (input.role !== 'owner' || input.status !== 'active')
            ) {
              const others = (
                await sql`select tp.principal_id from tenant_principals tp join principals p on p.id=tp.principal_id where tp.principal_id<>${id} and tp.role='owner' and tp.status='active' and p.status='active' and p.kind='human' limit 1`.execute(
                  tx,
                )
              ).rows;
              if (!others.length) fail('LAST_TENANT_OWNER', 409);
            }
            if (old.status === 'active' && input.status === 'disabled') {
              const orphan = (
                await sql`select m.workspace_id from memberships m where m.principal_id=${id} and m.role='admin' and m.status='active' and not exists(select 1 from memberships other join tenant_principals tp on tp.tenant_id=other.tenant_id and tp.principal_id=other.principal_id join principals p on p.id=other.principal_id where other.workspace_id=m.workspace_id and other.principal_id<>${id} and other.role='admin' and other.status='active' and tp.status='active' and p.status='active' and p.kind='human') limit 1`.execute(
                  tx,
                )
              ).rows;
              if (orphan.length) fail('LAST_WORKSPACE_ADMIN', 409);
            }
            if (
              old.status === 'active' &&
              (input.status === 'disabled' ||
                tenantRank[input.role] < tenantRank[old.role as keyof typeof tenantRank])
            ) {
              await recordPolicy(tx, auth, options.policyLedger, {
                kind: 'revocation.tenant_member',
                target_id: id,
                target_version: old.membership_policy_version,
              });
            }
            const changed = (
              await sql<{
                version: string;
              }>`update tenant_principals set role=${input.role},status=${input.status},membership_policy_version=membership_policy_version+1,authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where principal_id=${id} returning version`.execute(
                tx,
              )
            ).rows[0]!;
            await appendEvent(tx, auth, {
              aggregateType: 'tenant_member',
              aggregateId: id,
              version: changed.version,
              type: 'tenant.member_changed',
              payload: {
                principal_id: id,
                role: input.role,
                status: input.status,
                reason: input.reason.trim(),
              },
              target: `principal:${id}`,
            });
            return id;
          },
        );
        return tenantMember(tx, id);
      });
    },
    access(auth: AuthContext) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        return { can_manage: await canManage(tx, auth) };
      });
    },
    listWorkspaces(auth: AuthContext, input: C['PaginationQuery'] = {}) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const p = page(auth, 'organization.workspaces', input);
        const rows = (
          await sql<
            C['ManagedWorkspace']
          >`select id,name,version from workspaces where id>${p.after}::uuid order by id limit ${p.limit + 1}`.execute(
            tx,
          )
        ).rows;
        return p.finish(rows, (r) => r.id);
      });
    },
    candidates(auth: AuthContext, input: C['PaginationQuery'] = {}) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const p = page(auth, 'organization.candidates', input);
        const rows = (
          await sql<
            C['OrganizationCandidate']
          >`select jsonb_build_object('id',p.id,'kind',p.kind,'display_name',p.display_name,'status',p.status) as principal,tp.role as tenant_role from tenant_principals tp join principals p on p.id=tp.principal_id where tp.status='active' and p.status='active' and p.kind='human' and tp.role in ('owner','admin','member','guest') and p.id>${p.after}::uuid order by p.id limit ${p.limit + 1}`.execute(
            tx,
          )
        ).rows;
        return p.finish(rows, (r) => r.principal.id);
      });
    },
    members(auth: AuthContext, id: string, input: C['PaginationQuery'] = {}) {
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const w = await workspace(tx, id);
        const p = page(auth, `organization.members:${id}:${w.version}`, input);
        const rows = (
          await sql<
            C['ManagedWorkspaceMember']
          >`select jsonb_build_object('id',p.id,'kind',p.kind,'display_name',p.display_name,'status',p.status) as principal,m.role,m.status,m.version,tp.status as tenant_status from memberships m join principals p on p.id=m.principal_id join tenant_principals tp on tp.tenant_id=m.tenant_id and tp.principal_id=m.principal_id where m.workspace_id=${id} and p.id>${p.after}::uuid order by p.id limit ${p.limit + 1}`.execute(
            tx,
          )
        ).rows;
        return p.finish(rows, (r) => r.principal.id);
      });
    },
    createWorkspace(auth: AuthContext, input: C['CreateManagedWorkspaceInput'], key: string) {
      assertContract('CreateManagedWorkspaceInput', input);
      if (!input.name.trim()) fail('VALIDATION_FAILED', 400);
      return withTenant(db, auth.tenantId, async (tx) => {
        await managementLock(tx, auth);
        const id = await command(
          tx,
          auth,
          'organization.create_workspace',
          key,
          input,
          async () => {
            const id = randomUUID();
            await sql`insert into workspaces(tenant_id,id,name) values(${auth.tenantId},${id},${input.name.trim()})`.execute(
              tx,
            );
            await sql`insert into memberships(tenant_id,workspace_id,principal_id,role) values(${auth.tenantId},${id},${auth.principalId},'admin')`.execute(
              tx,
            );
            await appendEvent(tx, auth, {
              aggregateType: 'workspace',
              aggregateId: id,
              version: '1',
              type: 'workspace.created',
              payload: { workspace_id: id },
              target: `workspace:${id}`,
            });
            return id;
          },
        );
        return workspace(tx, id);
      });
    },
    setMember(
      auth: AuthContext,
      id: string,
      input: C['SetWorkspaceMemberInput'],
      version: string,
      key: string,
    ) {
      assertContract('SetWorkspaceMemberInput', input);
      assertContract('Version', version);
      if (!input.reason.trim()) fail('VALIDATION_FAILED', 400);
      return withTenant(db, auth.tenantId, async (tx) => {
        await managementLock(tx, auth);
        await command(
          tx,
          auth,
          'organization.set_member',
          key,
          { id, input, version },
          async () => {
            // Target tenant fence precedes membership and workspace locks, matching business operations.
            const target = (
              await sql<{
                status: string;
              }>`select status from tenant_principals where principal_id=${input.principal_id} for update`.execute(
                tx,
              )
            ).rows[0];
            if (!target) fail('NOT_FOUND', 404);
            const identity = await lockPrincipal(tx, input.principal_id);
            if (identity?.kind !== 'human') fail('NOT_FOUND', 404);
            if (
              input.status === 'active' &&
              (identity.status !== 'active' || target.status !== 'active')
            )
              fail('FORBIDDEN', 403);
            const old = (
              await sql<{
                role: C['SetWorkspaceMemberInput']['role'];
                status: string;
                version: string;
              }>`select role,status,version from memberships where workspace_id=${id} and principal_id=${input.principal_id} for update`.execute(
                tx,
              )
            ).rows[0];
            const w = await workspace(tx, id, true);
            expectedVersion(w.version, version);
            if (old?.role === input.role && old.status === input.status) return id;
            if (
              old?.status === 'active' &&
              old.role === 'admin' &&
              (input.role !== 'admin' || input.status !== 'active')
            ) {
              const others = (
                await sql`select m.principal_id from memberships m join tenant_principals tp on tp.tenant_id=m.tenant_id and tp.principal_id=m.principal_id join principals p on p.id=m.principal_id where m.workspace_id=${id} and m.principal_id<>${input.principal_id} and m.role='admin' and m.status='active' and tp.status='active' and p.status='active' and p.kind='human' limit 1`.execute(
                  tx,
                )
              ).rows;
              if (!others.length) fail('LAST_WORKSPACE_ADMIN', 409);
            }
            if (!old && input.status !== 'active') fail('NOT_FOUND', 404);
            if (
              old?.status === 'active' &&
              (input.status === 'disabled' || rank[input.role] < rank[old.role])
            ) {
              await recordPolicy(tx, auth, options.policyLedger, {
                kind: 'revocation.workspace_member',
                target_id: id,
                subject_id: input.principal_id,
                target_version: old.version,
              });
            }
            await sql`insert into memberships(tenant_id,workspace_id,principal_id,role,status) values(${auth.tenantId},${id},${input.principal_id},${input.role},${input.status}) on conflict(tenant_id,workspace_id,principal_id) do update set role=excluded.role,status=excluded.status,version=memberships.version+1,updated_at=clock_timestamp()`.execute(
              tx,
            );
            await sql`update tenant_principals set authz_revision=authz_revision+1,version=version+1,updated_at=clock_timestamp() where principal_id=${input.principal_id}`.execute(
              tx,
            );
            const changed = (
              await sql<{
                version: string;
              }>`update workspaces set version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
                tx,
              )
            ).rows[0]!;
            await appendEvent(tx, auth, {
              aggregateType: 'workspace',
              aggregateId: id,
              version: changed.version,
              type: 'workspace.member_changed',
              payload: {
                principal_id: input.principal_id,
                role: input.role,
                status: input.status,
                reason: input.reason.trim(),
              },
              target: `workspace:${id}`,
            });
            return id;
          },
        );
        return workspace(tx, id);
      });
    },
  };
}
export type OrganizationService = ReturnType<typeof createOrganizationService>;
