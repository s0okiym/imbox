import { createIdentityService } from '@imbox/auth';
import { createMessagingService } from '@imbox/application';
import { createApp } from '../../apps/api/src/app.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withTenant } from '@imbox/db';
import { provisionWorkspace, type WorkspaceManifest } from '../../scripts/provision-workspace.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
beforeAll(async () => {
  databases = await testDatabases();
  fixture = await tenantFixture(databases.owner);
});
afterAll(async () => {
  await databases?.close();
});
const manifest = (): WorkspaceManifest => ({
  tenant_id: randomUUID(),
  workspace_id: randomUUID(),
  tenant_name: 'Provisioned organization',
  workspace_name: 'Team',
  owner_principal_id: fixture.alice.principalId,
  member_principal_ids: [fixture.bob.principalId],
  requested_by: 'Integration operator',
  change_reference: 'integration-test',
});
describe('operator workspace provisioning', () => {
  it('plans without writes and atomically provisions current human identities with restricted roles and an operator receipt', async () => {
    const m = manifest();
    expect((await provisionWorkspace(databases.owner, m, false)).status).toBe('planned');
    expect(
      await databases.owner
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', m.tenant_id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect((await provisionWorkspace(databases.owner, m, true)).status).toBe('applied');
    await withTenant(databases.db, m.tenant_id, async (tx) => {
      const members = await tx.selectFrom('memberships').select(['principal_id', 'role']).execute();
      expect(members).toHaveLength(2);
      expect(members.find((p) => p.principal_id === m.owner_principal_id)?.role).toBe('admin');
      expect(members.find((p) => p.principal_id === fixture.bob.principalId)?.role).toBe('member');
      expect(
        await tx
          .selectFrom('tenant_principals')
          .select('principal_id')
          .where('role', '=', 'owner')
          .execute(),
      ).toEqual([{ principal_id: m.owner_principal_id }]);
    });
    const receipt = await sql<{
      database_actor: string;
      requested_by: string;
    }>`select database_actor,requested_by from workspace_provisioning_receipts where tenant_id=${m.tenant_id}::uuid`.execute(
      databases.owner,
    );
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]?.database_actor).toBeTruthy();
    expect(receipt.rows[0]?.requested_by).toBe(m.requested_by);
    await expect(
      sql`select * from workspace_provisioning_receipts`.execute(databases.db),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`select * from workspace_provisioning_receipts`.execute(databases.identityDb),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('serializes concurrent retries and never reactivates revoked grants on replay', async () => {
    const m = manifest();
    const results = await Promise.all([
      provisionWorkspace(databases.owner, m, true),
      provisionWorkspace(databases.owner, m, true),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['already_applied', 'applied']);
    await withTenant(databases.owner, m.tenant_id, (tx) =>
      tx
        .updateTable('memberships')
        .set({ status: 'disabled' })
        .where('principal_id', '=', fixture.bob.principalId)
        .execute(),
    );
    expect((await provisionWorkspace(databases.owner, m, true)).status).toBe('already_applied');
    await withTenant(databases.db, m.tenant_id, async (tx) =>
      expect(
        (
          await tx
            .selectFrom('memberships')
            .select('status')
            .where('principal_id', '=', fixture.bob.principalId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('disabled'),
    );
    await expect(
      provisionWorkspace(databases.owner, { ...m, workspace_name: 'Changed' }, true),
    ).rejects.toThrow('different manifest');
  });
  it('refuses existing tenants and missing identities without leaving a tenant or receipt', async () => {
    await expect(
      provisionWorkspace(databases.owner, { ...manifest(), tenant_id: fixture.tenantId }, true),
    ).rejects.toThrow('Existing tenant');
    const m = { ...manifest(), member_principal_ids: [randomUUID()] };
    await expect(provisionWorkspace(databases.owner, m, true)).rejects.toThrow(
      'existing active human',
    );
    expect(
      await databases.owner
        .selectFrom('tenants')
        .select('id')
        .where('id', '=', m.tenant_id)
        .executeTakeFirst(),
    ).toBeUndefined();
    const receipts =
      await sql`select 1 from workspace_provisioning_receipts where tenant_id=${m.tenant_id}::uuid`.execute(
        databases.owner,
      );
    expect(receipts.rows).toHaveLength(0);
  });
  it('rejects runtime credentials, duplicate principals, unknown fields and disabled identities', async () => {
    await expect(provisionWorkspace(databases.db, manifest(), true)).rejects.toThrow(
      'migration owner',
    );
    await expect(provisionWorkspace(databases.identityDb, manifest(), true)).rejects.toThrow(
      'migration owner',
    );
    const m = manifest();
    await expect(
      provisionWorkspace(
        databases.owner,
        { ...m, member_principal_ids: [m.owner_principal_id] },
        true,
      ),
    ).rejects.toThrow('Duplicate');
    await expect(
      provisionWorkspace(databases.owner, { ...m, role: 'admin' }, true),
    ).rejects.toThrow('schema');
    const disabled = randomUUID();
    await databases.owner
      .insertInto('principals')
      .values({ id: disabled, kind: 'human', display_name: 'Disabled', status: 'disabled' })
      .execute();
    await expect(
      provisionWorkspace(databases.owner, { ...m, owner_principal_id: disabled }, true),
    ).rejects.toThrow('existing active human');
  });
  it('admits provisioned members through normal session and conversation APIs while rejecting an unlisted human', async () => {
    const m = manifest();
    await provisionWorkspace(databases.owner, m, true);
    const origin = 'http://localhost:5173',
      secret = 'workspace-provisioning-integration-secret-at-least-32';
    const app = createApp({
      readiness: async () => {},
      messaging: createMessagingService(databases.db, secret),
      identity: createIdentityService({
        db: databases.db,
        identityDb: databases.identityDb,
        publicOrigin: origin,
        sessionSecret: secret,
        environment: 'test',
        enableDevAuth: true,
        devPrincipalIds: [fixture.alice.principalId, fixture.charlie.principalId],
      }),
    });
    try {
      for (const [id, allowed] of [
        [fixture.alice.principalId, true],
        [fixture.charlie.principalId, false],
      ] as const) {
        const login = await app.inject({
          method: 'POST',
          url: '/v1/auth/dev-login',
          headers: { origin },
          payload: { principal_id: id },
        });
        expect(login.statusCode).toBe(200);
        const cookie = login.cookies.find((c) => c.name === 'imbox_session')!.value;
        const headers = {
          origin,
          cookie: `imbox_session=${cookie}`,
          'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token,
          'x-imbox-tenant-id': m.tenant_id,
          'idempotency-key': randomUUID(),
        };
        const me = await app.inject({ url: '/v1/me', headers });
        expect(me.statusCode).toBe(allowed ? 200 : 403);
        if (allowed) {
          const chat = await app.inject({
            method: 'POST',
            url: '/v1/conversations',
            headers,
            payload: {
              workspace_id: m.workspace_id,
              kind: 'group',
              title: 'New organization chat',
              member_ids: m.member_principal_ids,
            },
          });
          expect(chat.statusCode).toBe(201);
        }
      }
    } finally {
      await app.close();
    }
  });
});
