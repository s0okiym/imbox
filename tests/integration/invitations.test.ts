import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import {
  createOrganizationService,
  createFilePolicyLedger,
  replayPolicyLedger,
  authorizeWorkspace,
} from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import { assertContract } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
const secret = 'invitation-integration-secret-at-least-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>,
  fixture: Awaited<ReturnType<typeof tenantFixture>>,
  recipient: string,
  directory: string,
  ledger: Awaited<ReturnType<typeof createFilePolicyLedger>>,
  service: ReturnType<typeof createOrganizationService>;
beforeAll(async () => {
  databases = await testDatabases();
  directory = await mkdtemp(join(tmpdir(), 'imbox-invitations-'));
  ledger = await createFilePolicyLedger({ directory, signingKey: secret });
  service = createOrganizationService(databases.db, secret, { policyLedger: ledger });
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  recipient = randomUUID();
  await databases.owner
    .insertInto('principals')
    .values({ id: recipient, kind: 'human', display_name: 'Invited human' })
    .execute();
});
afterAll(async () => {
  await databases?.close();
  await rm(directory, { recursive: true, force: true });
});
const input = () => ({
  principal_id: recipient,
  workspace_id: fixture.workspaceId,
  role: 'member' as const,
  expires_in_hours: 24,
  reason: 'Invite reviewed person into the team',
});
const membership = () =>
  withTenant(
    databases.db,
    fixture.tenantId,
    async (tx) =>
      (
        await sql<{
          status: string;
          version: string;
        }>`select status,version from tenant_principals where principal_id=${recipient}`.execute(tx)
      ).rows[0],
  );
it('issues only principal-bound human invitations, retains no plaintext code, and retries creation with the same credential', async () => {
  await expect(service.createInvitation(fixture.bob, input(), randomUUID())).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(
    service.createInvitation(
      fixture.alice,
      { ...input(), principal_id: fixture.bob.principalId },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'ALREADY_ORGANIZATION_MEMBER' });
  const foreign = await tenantFixture(databases.owner);
  await expect(
    service.createInvitation(
      fixture.alice,
      { ...input(), workspace_id: foreign.workspaceId },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const key = randomUUID(),
    created = await service.createInvitation(fixture.alice, input(), key);
  assertContract('CreatedOrganizationInvitation', created);
  expect(Boolean(created.code)).toBe(true);
  const retried = await service.createInvitation(fixture.alice, input(), key);
  expect(retried.code === created.code).toBe(true);
  await expect(
    service.createInvitation(fixture.alice, input(), randomUUID()),
  ).rejects.toMatchObject({ code: 'INVITATION_PENDING_EXISTS' });
  const stored = await withTenant(
    databases.db,
    fixture.tenantId,
    async (tx) =>
      (
        await sql<{
          code_hash: string;
        }>`select code_hash from organization_invitations where id=${created.invitation.id}`.execute(
          tx,
        )
      ).rows[0]!,
  );
  expect(stored.code_hash === createHash('sha256').update(created.code!).digest('hex')).toBe(true);
  const page = await service.listInvitations(fixture.alice);
  assertContract('OrganizationInvitationPage', page);
  expect(JSON.stringify(page).includes(created.code!)).toBe(false);
  await expect(
    service.acceptInvitation(fixture.bob.principalId, { code: created.code! }),
  ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  await expect(
    service.acceptInvitation(recipient, {
      code: created.code!.slice(0, -1) + (created.code!.endsWith('A') ? 'B' : 'A'),
    }),
  ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
});
it('joins once under concurrent acceptance and never restores a later disabled membership on receipt retry', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  const results = await Promise.all([
    service.acceptInvitation(recipient, { code: created.code! }),
    service.acceptInvitation(recipient, { code: created.code! }),
  ]);
  expect(results[0]).toEqual(results[1]);
  assertContract('AcceptedOrganizationInvitation', results[0]);
  await withTenant(databases.db, fixture.tenantId, (tx) =>
    authorizeWorkspace(
      tx,
      { tenantId: fixture.tenantId, principalId: recipient, kind: 'human', authzRevision: '1' },
      fixture.workspaceId,
    ),
  );
  await service.setTenantMember(
    fixture.alice,
    recipient,
    { role: 'member', status: 'disabled', reason: 'End access after joining' },
    '1',
    randomUUID(),
  );
  await service.acceptInvitation(recipient, { code: created.code! });
  expect(await membership()).toMatchObject({ status: 'disabled', version: '2' });
  await expect(
    service.createInvitation(fixture.alice, input(), randomUUID()),
  ).rejects.toMatchObject({ code: 'ALREADY_ORGANIZATION_MEMBER' });
});
it('uses database expiry, permits explicit revocation of expired invitations, and never silently replaces a pending grant', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  await withTenant(databases.owner, fixture.tenantId, (tx) =>
    sql`update organization_invitations set expires_at=clock_timestamp()-interval '1 second' where id=${created.invitation.id}`.execute(
      tx,
    ),
  );
  expect((await service.listInvitations(fixture.alice)).items[0]!.status).toBe('expired');
  await expect(service.acceptInvitation(recipient, { code: created.code! })).rejects.toMatchObject({
    code: 'INVITATION_UNAVAILABLE',
  });
  await expect(
    service.createInvitation(fixture.alice, input(), randomUUID()),
  ).rejects.toMatchObject({ code: 'INVITATION_PENDING_EXISTS' });
  expect(
    await service.revokeInvitation(
      fixture.alice,
      created.invitation.id,
      { reason: 'Replace expired grant' },
      '1',
      randomUUID(),
    ),
  ).toMatchObject({ status: 'revoked' });
  const next = await service.createInvitation(fixture.alice, input(), randomUUID());
  expect(next.invitation.id).not.toBe(created.invitation.id);
  expect(next.code === created.code).toBe(false);
});
it('fences invitations after issuer authority is changed and restored', async () => {
  await service.setTenantMember(
    fixture.alice,
    fixture.bob.principalId,
    { role: 'owner', status: 'active', reason: 'Appoint second owner' },
    '1',
    randomUUID(),
  );
  const created = await service.createInvitation(fixture.alice, input(), randomUUID()),
    otherOwner = { ...fixture.bob, authzRevision: '2' };
  await service.setTenantMember(
    otherOwner,
    fixture.alice.principalId,
    { role: 'admin', status: 'active', reason: 'Reduce organization authority' },
    '1',
    randomUUID(),
  );
  await expect(service.acceptInvitation(recipient, { code: created.code! })).rejects.toMatchObject({
    code: 'INVITATION_UNAVAILABLE',
  });
  await service.setTenantMember(
    otherOwner,
    fixture.alice.principalId,
    { role: 'owner', status: 'active', reason: 'Explicit new authority' },
    '2',
    randomUUID(),
  );
  await expect(service.acceptInvitation(recipient, { code: created.code! })).rejects.toMatchObject({
    code: 'INVITATION_UNAVAILABLE',
  });
  expect(await membership()).toBeUndefined();
});
it('serializes invitation acceptance against revocation without a partial membership grant', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  const results = await Promise.allSettled([
    service.acceptInvitation(recipient, { code: created.code! }),
    service.revokeInvitation(
      fixture.alice,
      created.invitation.id,
      { reason: 'Withdraw grant' },
      '1',
      randomUUID(),
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const row = (await service.listInvitations(fixture.alice)).items[0]!;
  expect(Boolean(await membership())).toBe(row.status === 'accepted');
});
it('independently persists consumption before database commit and prevents regrant after rollback', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  const interrupted = createOrganizationService(databases.db, secret, {
    policyLedger: {
      ...ledger,
      append: async (record) => {
        await ledger.append(record);
        throw new Error('transaction interrupted after durable consumption');
      },
    },
  });
  await expect(interrupted.acceptInvitation(recipient, { code: created.code! })).rejects.toThrow(
    'transaction interrupted after durable consumption',
  );
  expect(await membership()).toBeUndefined();
  expect((await service.listInvitations(fixture.alice)).items[0]!.status).toBe('pending');
  const [fact] = await ledger.records(fixture.tenantId);
  expect(fact).toMatchObject({
    kind: 'revocation.invitation',
    target_id: created.invitation.id,
    target_version: '1',
  });
  expect(await replayPolicyLedger(databases.db, ledger, fixture.tenantId)).toEqual({ applied: 1 });
  expect((await service.listInvitations(fixture.alice)).items[0]!.status).toBe('revoked');
  await expect(service.acceptInvitation(recipient, { code: created.code! })).rejects.toMatchObject({
    code: 'INVITATION_UNAVAILABLE',
  });
  expect(await membership()).toBeUndefined();
});
it('fails closed before granting membership when the independent consumption ledger is unavailable', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  const broken = createOrganizationService(databases.db, secret, {
    policyLedger: {
      ...ledger,
      append: async () => {
        throw new Error('ledger unavailable');
      },
    },
  });
  await expect(broken.acceptInvitation(recipient, { code: created.code! })).rejects.toThrow(
    'ledger unavailable',
  );
  expect(await membership()).toBeUndefined();
  expect((await service.listInvitations(fixture.alice)).items[0]!.status).toBe('pending');
});
it('allows a session-only account to inspect its own identity, requires CSRF to join, and rechecks tenant access afterward', async () => {
  const origin = 'http://localhost:5173';
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    publicOrigin: origin,
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [recipient],
  });
  const session = await identity.devLogin({ principalId: recipient, origin }),
    app = createApp({ readiness: async () => {}, identity, organization: service });
  const cookie = `imbox_session=${session.token}`;
  try {
    const account = await app.inject({ method: 'GET', url: '/v1/account', headers: { cookie } });
    expect(account.statusCode).toBe(200);
    expect(account.headers['cache-control']).toBe('no-store');
    assertContract('Account', account.json());
    expect((await app.inject({ method: 'GET', url: '/v1/account' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/account',
          headers: { cookie, authorization: 'Bearer unsupported' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { cookie, 'x-imbox-tenant-id': fixture.tenantId },
        })
      ).statusCode,
    ).toBe(403);
    const created = await service.createInvitation(fixture.alice, input(), randomUUID());
    const command = {
      method: 'POST' as const,
      url: '/v1/account/invitations/accept',
      payload: { code: created.code! },
      headers: { cookie, origin, 'x-csrf-token': session.csrfToken },
    };
    expect(
      (await app.inject({ ...command, headers: { ...command.headers, 'x-csrf-token': '' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...command,
          headers: { ...command.headers, origin: 'https://other.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    const previewCommand = { ...command, url: '/v1/account/invitations/preview' };
    expect(
      (await app.inject({ ...previewCommand, headers: { ...command.headers, 'x-csrf-token': '' } }))
        .statusCode,
    ).toBe(403);
    const preview = await app.inject(previewCommand);
    expect(preview.statusCode).toBe(200);
    assertContract('OrganizationInvitationPreview', preview.json());
    expect(await membership()).toBeUndefined();
    expect((await app.inject(command)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { cookie, 'x-imbox-tenant-id': fixture.tenantId },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: command.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/account', headers: { cookie } })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
it('previews only the bound recipient’s grant without joining, and rejects metadata after access is disabled', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  await expect(
    service.previewInvitation(fixture.bob.principalId, { code: created.code! }),
  ).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  const preview = await service.previewInvitation(recipient, { code: created.code! });
  assertContract('OrganizationInvitationPreview', preview);
  expect(preview).toMatchObject({
    tenant_id: fixture.tenantId,
    workspace_id: fixture.workspaceId,
    role: 'member',
    status: 'pending',
  });
  expect(await membership()).toBeUndefined();
  await service.acceptInvitation(recipient, { code: created.code! });
  expect((await service.previewInvitation(recipient, { code: created.code! })).status).toBe(
    'accepted',
  );
  await service.setTenantMember(
    fixture.alice,
    recipient,
    { role: 'member', status: 'disabled', reason: 'End organization access' },
    '1',
    randomUUID(),
  );
  await expect(service.previewInvitation(recipient, { code: created.code! })).rejects.toMatchObject(
    { code: 'FORBIDDEN' },
  );
});
it('rechecks expiry after slow durable consumption and rolls back the entire membership grant', async () => {
  const created = await service.createInvitation(fixture.alice, input(), randomUUID());
  await withTenant(databases.owner, fixture.tenantId, (tx) =>
    sql`update organization_invitations set expires_at=clock_timestamp()+interval '2 seconds' where id=${created.invitation.id}`.execute(
      tx,
    ),
  );
  let appended = false;
  const slow = createOrganizationService(databases.db, secret, {
    policyLedger: {
      ...ledger,
      append: async (record) => {
        await ledger.append(record);
        appended = true;
        await new Promise((resolve) => setTimeout(resolve, 2300));
      },
    },
  });
  await expect(slow.acceptInvitation(recipient, { code: created.code! })).rejects.toMatchObject({
    code: 'INVITATION_UNAVAILABLE',
  });
  expect(appended).toBe(true);
  expect(await membership()).toBeUndefined();
  expect((await service.listInvitations(fixture.alice)).items[0]!.status).toBe('expired');
});
