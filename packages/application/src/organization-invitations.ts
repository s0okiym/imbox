import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant, lockPrincipal, type Db, type TenantTransaction as Tx } from '@imbox/db';
import {
  ApplicationError,
  appendEvent,
  command,
  CursorCodec,
  expectedVersion,
  fail,
  type AuthContext,
} from './common.js';
import { recordPolicy, type PolicyLedger } from './policy-ledger.js';

const digest = (code: string) => createHash('sha256').update(code).digest('hex');
const normalize = (row: C['OrganizationInvitation']): C['OrganizationInvitation'] => ({
  ...row,
  expires_at: new Date(row.expires_at).toISOString(),
});
async function invitation(tx: Tx, id: string) {
  const row = (
    await sql<
      C['OrganizationInvitation']
    >`select id,principal_id,workspace_id,role,case when status='pending' and expires_at<=clock_timestamp() then 'expired' else status end as status,version,expires_at,created_by from organization_invitations where id=${id}`.execute(
      tx,
    )
  ).rows[0];
  return normalize(row ?? fail('NOT_FOUND', 404));
}
function parseCode(code: string) {
  const parts = code.split('.');
  if (parts.length !== 3) fail('INVITATION_UNAVAILABLE', 404);
  const [tenant, id, signature] = parts as [string, string, string];
  if (
    !/^[a-f0-9-]{36}$/.test(tenant) ||
    !/^[a-f0-9-]{36}$/.test(id) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    fail('INVITATION_UNAVAILABLE', 404);
  assertContract('Identifier', tenant);
  assertContract('Identifier', id);
  return { tenant, id };
}
export function createInvitationOperations(
  db: Db,
  secret: string,
  options: {
    policyLedger?: PolicyLedger;
    authorizeManager: (tx: Tx, auth: AuthContext) => Promise<void>;
    lockManager: (tx: Tx, auth: AuthContext) => Promise<void>;
  },
) {
  const cursors = new CursorCodec(secret);
  const codeFor = (tenant: string, id: string) =>
    `${tenant}.${id}.${createHmac('sha256', secret).update(`imbox.invitation.v1:${tenant}:${id}`).digest('base64url')}`;
  async function assertIssuer(
    tx: Tx,
    tenant: string,
    row: { created_by: string; creator_authz_revision: string; creator_principal_version: string },
  ) {
    const issuer: AuthContext = {
      tenantId: tenant,
      principalId: row.created_by,
      kind: 'human',
      authzRevision: row.creator_authz_revision,
    };
    try {
      await options.authorizeManager(tx, issuer);
    } catch (error) {
      if (error instanceof ApplicationError && [403, 404].includes(error.status))
        fail('INVITATION_UNAVAILABLE', 409);
      throw error;
    }
    if ((await lockPrincipal(tx, row.created_by))?.version !== row.creator_principal_version)
      fail('INVITATION_UNAVAILABLE', 409);
  }
  return {
    async previewInvitation(
      principalId: string,
      input: C['AcceptOrganizationInvitationInput'],
    ): Promise<C['OrganizationInvitationPreview']> {
      assertContract('Identifier', principalId);
      assertContract('AcceptOrganizationInvitationInput', input);
      const { tenant, id } = parseCode(input.code);
      return withTenant(db, tenant, async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`organization:${tenant}`},0))`.execute(
          tx,
        );
        const row = (
          await sql<{
            principal_id: string;
            workspace_id: string;
            role: 'member' | 'guest';
            status: string;
            code_hash: string;
            created_by: string;
            creator_authz_revision: string;
            creator_principal_version: string;
            expires_at: Date;
            expired: boolean;
            tenant_name: string;
            tenant_status: string;
            workspace_name: string;
          }>`select i.principal_id,i.workspace_id,i.role,i.status,i.code_hash,i.created_by,i.creator_authz_revision,i.creator_principal_version,i.expires_at,i.expires_at<=clock_timestamp() as expired,t.name as tenant_name,t.status as tenant_status,w.name as workspace_name from organization_invitations i join tenants t on t.id=i.tenant_id join workspaces w on w.tenant_id=i.tenant_id and w.id=i.workspace_id where i.id=${id} for share of i,t`.execute(
            tx,
          )
        ).rows[0];
        if (
          !row ||
          row.tenant_status !== 'active' ||
          row.principal_id !== principalId ||
          !timingSafeEqual(
            Buffer.from(row.code_hash, 'hex'),
            Buffer.from(digest(input.code), 'hex'),
          )
        )
          fail('INVITATION_UNAVAILABLE', 404);
        const recipient = await lockPrincipal(tx, principalId);
        if (recipient?.kind !== 'human' || recipient.status !== 'active') fail('FORBIDDEN', 403);
        if (row.status === 'accepted') {
          const member = (
            await sql<{
              status: string;
            }>`select status from tenant_principals where principal_id=${principalId} for share`.execute(
              tx,
            )
          ).rows[0];
          if (
            member?.status !== 'active' ||
            !(
              await sql`select principal_id from memberships where principal_id=${principalId} and workspace_id=${row.workspace_id} and status='active'`.execute(
                tx,
              )
            ).rows.length
          )
            fail('FORBIDDEN', 403);
        } else {
          if (row.status !== 'pending' || row.expired) fail('INVITATION_UNAVAILABLE', 409);
          await assertIssuer(tx, tenant, row);
        }
        return {
          invitation_id: id,
          tenant_id: tenant,
          tenant_name: row.tenant_name,
          workspace_id: row.workspace_id,
          workspace_name: row.workspace_name,
          role: row.role,
          status: row.status as 'pending' | 'accepted',
          expires_at: new Date(row.expires_at).toISOString(),
        };
      });
    },
    listInvitations(auth: AuthContext, input: C['PaginationQuery'] = {}) {
      assertContract('PaginationQuery', input);
      return withTenant(db, auth.tenantId, async (tx) => {
        await options.authorizeManager(tx, auth);
        const binding = JSON.stringify([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          'organization.invitations',
        ]);
        const after = input.cursor
          ? cursors.decode(input.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        assertContract('Identifier', after);
        const limit = Math.min(input.limit ?? 50, 100);
        const rows = (
          await sql<
            C['OrganizationInvitation']
          >`select id,principal_id,workspace_id,role,case when status='pending' and expires_at<=clock_timestamp() then 'expired' else status end as status,version,expires_at,created_by from organization_invitations where id>${after}::uuid order by id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = rows.slice(0, limit).map(normalize);
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, items[items.length - 1]!.id) }
            : {}),
        };
      });
    },
    createInvitation(
      auth: AuthContext,
      input: C['CreateOrganizationInvitationInput'],
      key: string,
    ): Promise<C['CreatedOrganizationInvitation']> {
      assertContract('CreateOrganizationInvitationInput', input);
      if (!input.reason.trim()) fail('VALIDATION_FAILED', 400);
      return withTenant(db, auth.tenantId, async (tx) => {
        await options.lockManager(tx, auth);
        const id = await command(
          tx,
          auth,
          'organization.create_invitation',
          key,
          input,
          async () => {
            const target = await lockPrincipal(tx, input.principal_id);
            if (target?.kind !== 'human' || target.status !== 'active') fail('NOT_FOUND', 404);
            const existing = (
              await sql`select principal_id from tenant_principals where principal_id=${input.principal_id}`.execute(
                tx,
              )
            ).rows;
            if (existing.length) fail('ALREADY_ORGANIZATION_MEMBER', 409);
            if (
              !(
                await sql`select id from workspaces where id=${input.workspace_id} for share`.execute(
                  tx,
                )
              ).rows.length
            )
              fail('NOT_FOUND', 404);
            if (
              (
                await sql`select id from organization_invitations where principal_id=${input.principal_id} and status='pending'`.execute(
                  tx,
                )
              ).rows.length
            )
              fail('INVITATION_PENDING_EXISTS', 409);
            const issuer = await lockPrincipal(tx, auth.principalId),
              id = randomUUID(),
              hash = digest(codeFor(auth.tenantId, id));
            await sql`insert into organization_invitations(tenant_id,id,principal_id,workspace_id,role,code_hash,created_by,creator_authz_revision,creator_principal_version,expires_at) values(${auth.tenantId},${id},${input.principal_id},${input.workspace_id},${input.role},${hash},${auth.principalId},${auth.authzRevision}::bigint,${issuer!.version}::bigint,clock_timestamp()+${input.expires_in_hours}*interval '1 hour')`.execute(
              tx,
            );
            await appendEvent(tx, auth, {
              aggregateType: 'invitation',
              aggregateId: id,
              version: '1',
              type: 'organization.invitation_created',
              payload: {
                principal_id: input.principal_id,
                workspace_id: input.workspace_id,
                role: input.role,
                reason: input.reason.trim(),
              },
              target: `principal:${auth.principalId}`,
            });
            return id;
          },
        );
        const result = await invitation(tx, id);
        if (result.status !== 'pending') return { invitation: result };
        const stored = (
          await sql<{
            code_hash: string;
          }>`select code_hash from organization_invitations where id=${id}`.execute(tx)
        ).rows[0]!;
        const code = codeFor(auth.tenantId, id);
        if (stored.code_hash !== digest(code)) fail('INVITATION_KEY_CHANGED', 409);
        return { invitation: result, code };
      });
    },
    revokeInvitation(
      auth: AuthContext,
      id: string,
      input: C['RevokeOrganizationInvitationInput'],
      version: string,
      key: string,
    ) {
      assertContract('Identifier', id);
      assertContract('RevokeOrganizationInvitationInput', input);
      assertContract('Version', version);
      if (!input.reason.trim()) fail('VALIDATION_FAILED', 400);
      return withTenant(db, auth.tenantId, async (tx) => {
        await options.lockManager(tx, auth);
        await command(
          tx,
          auth,
          'organization.revoke_invitation',
          key,
          { id, input, version },
          async () => {
            const row =
              (
                await sql<{
                  status: string;
                  version: string;
                }>`select status,version from organization_invitations where id=${id} for update`.execute(
                  tx,
                )
              ).rows[0] ?? fail('NOT_FOUND', 404);
            expectedVersion(row.version, version);
            if (row.status === 'accepted') fail('INVITATION_ALREADY_ACCEPTED', 409);
            if (row.status === 'revoked') return id;
            await recordPolicy(tx, auth, options.policyLedger, {
              kind: 'revocation.invitation',
              target_id: id,
              target_version: row.version,
            });
            const changed = (
              await sql<{
                version: string;
              }>`update organization_invitations set status='revoked',version=version+1,updated_at=clock_timestamp() where id=${id} returning version`.execute(
                tx,
              )
            ).rows[0]!;
            await appendEvent(tx, auth, {
              aggregateType: 'invitation',
              aggregateId: id,
              version: changed.version,
              type: 'organization.invitation_revoked',
              payload: { reason: input.reason.trim() },
              target: `principal:${auth.principalId}`,
            });
            return id;
          },
        );
        return invitation(tx, id);
      });
    },
    acceptInvitation(
      principalId: string,
      input: C['AcceptOrganizationInvitationInput'],
    ): Promise<C['AcceptedOrganizationInvitation']> {
      assertContract('Identifier', principalId);
      assertContract('AcceptOrganizationInvitationInput', input);
      const { tenant, id } = parseCode(input.code);
      return withTenant(db, tenant, async (tx) => {
        // No tenant membership is assumed here: the route supplies a separately authenticated human account.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`organization:${tenant}`},0))`.execute(
          tx,
        );
        const currentTenant = (
          await sql<{
            status: string;
          }>`select status from tenants where id=${tenant} for share`.execute(tx)
        ).rows[0];
        if (currentTenant?.status !== 'active') fail('INVITATION_UNAVAILABLE', 404);
        const row = (
          await sql<{
            principal_id: string;
            workspace_id: string;
            role: 'member' | 'guest';
            status: string;
            version: string;
            code_hash: string;
            created_by: string;
            creator_authz_revision: string;
            creator_principal_version: string;
            expired: boolean;
          }>`select principal_id,workspace_id,role,status,version,code_hash,created_by,creator_authz_revision,creator_principal_version,expires_at<=clock_timestamp() as expired from organization_invitations where id=${id} for update`.execute(
            tx,
          )
        ).rows[0];
        if (
          !row ||
          row.principal_id !== principalId ||
          !timingSafeEqual(
            Buffer.from(row.code_hash, 'hex'),
            Buffer.from(digest(input.code), 'hex'),
          )
        )
          fail('INVITATION_UNAVAILABLE', 404);
        const recipient = await lockPrincipal(tx, principalId);
        if (recipient?.kind !== 'human' || recipient.status !== 'active') fail('FORBIDDEN', 403);
        const receipt = { invitation_id: id, tenant_id: tenant, workspace_id: row.workspace_id };
        if (row.status === 'accepted') return receipt;
        if (row.status !== 'pending' || row.expired) fail('INVITATION_UNAVAILABLE', 409);
        await assertIssuer(tx, tenant, row);
        if (
          (
            await sql`select principal_id from tenant_principals where principal_id=${principalId} for update`.execute(
              tx,
            )
          ).rows.length
        )
          fail('ALREADY_ORGANIZATION_MEMBER', 409);
        const w = (
          await sql<{
            version: string;
          }>`select version from workspaces where id=${row.workspace_id} for update`.execute(tx)
        ).rows[0];
        if (!w) fail('INVITATION_UNAVAILABLE', 404);
        if (
          !(
            await sql`select id from organization_invitations where id=${id} and expires_at>clock_timestamp()`.execute(
              tx,
            )
          ).rows.length
        )
          fail('INVITATION_UNAVAILABLE', 409);
        const acceptedBy: AuthContext = {
          tenantId: tenant,
          principalId,
          kind: 'human',
          authzRevision: '1',
        };
        // Consumption is independently durable too: restoring a pre-join snapshot must not replay the invitation grant.
        await recordPolicy(tx, acceptedBy, options.policyLedger, {
          kind: 'revocation.invitation',
          target_id: id,
          target_version: row.version,
        });
        await sql`insert into tenant_principals(tenant_id,principal_id,role) values(${tenant},${principalId},${row.role})`.execute(
          tx,
        );
        await sql`insert into memberships(tenant_id,workspace_id,principal_id,role) values(${tenant},${row.workspace_id},${principalId},${row.role})`.execute(
          tx,
        );
        await sql`update workspaces set version=version+1,updated_at=clock_timestamp() where id=${row.workspace_id}`.execute(
          tx,
        );
        const changed =
          (
            await sql<{
              version: string;
            }>`update organization_invitations set status='accepted',version=version+1,updated_at=clock_timestamp() where id=${id} and status='pending' and expires_at>clock_timestamp() returning version`.execute(
              tx,
            )
          ).rows[0] ?? fail('INVITATION_UNAVAILABLE', 409);
        await appendEvent(tx, acceptedBy, {
          aggregateType: 'invitation',
          aggregateId: id,
          version: changed.version,
          type: 'organization.invitation_accepted',
          payload: { principal_id: principalId, workspace_id: row.workspace_id, role: row.role },
          target: `principal:${principalId}`,
        });
        return receipt;
      });
    },
  };
}
