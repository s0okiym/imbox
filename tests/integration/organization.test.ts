import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import {
  createOrganizationService,
  createFilePolicyLedger,
  replayPolicyLedger,
  authorizeWorkspace,
  authorizeTenant,
  type AuthContext,
} from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import { assertContract } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { modelFixture } from '../helpers/model.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const secret = 'organization-test-secret-over-thirty-two-characters';
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let directory: string;
let service: ReturnType<typeof createOrganizationService>;
let ledger: Awaited<ReturnType<typeof createFilePolicyLedger>>;
beforeAll(async () => {
  databases = await testDatabases();
  directory = await mkdtemp(join(tmpdir(), 'imbox-organization-'));
  ledger = await createFilePolicyLedger({ directory, signingKey: secret });
  service = createOrganizationService(databases.db, secret, { policyLedger: ledger });
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
});
afterAll(async () => {
  await databases?.close();
  await rm(directory, { recursive: true, force: true });
});
const input = (
  principal_id: string,
  role: 'admin' | 'member' | 'guest' = 'member',
  status: 'active' | 'disabled' = 'active',
) => ({ principal_id, role, status, reason: 'Reviewed workspace membership change' });
const refresh = async (auth: AuthContext) =>
  withTenant(databases.db, auth.tenantId, async (tx) => ({
    ...auth,
    authzRevision: (
      await sql<{
        authz_revision: string;
      }>`select authz_revision from tenant_principals where principal_id=${auth.principalId}`.execute(
        tx,
      )
    ).rows[0]!.authz_revision,
  }));
it('restricts organization administration and candidates to the tenant, without granting resource access', async () => {
  const { alice, bob } = fixture;
  expect(await service.access(alice)).toEqual({ can_manage: true });
  expect(await service.access(bob)).toEqual({ can_manage: false });
  await expect(service.listWorkspaces(bob)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const foreign = await tenantFixture(databases.owner);
  await expect(service.members(alice, foreign.workspaceId)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(
    service.setMember(
      alice,
      fixture.workspaceId,
      input(foreign.alice.principalId),
      '1',
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const candidates = await service.candidates(alice);
  assertContract('OrganizationCandidatePage', candidates);
  expect(candidates.items.map((x) => x.principal.id).sort()).toEqual([...fixture.ids].sort());
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await sql`update memberships set status='disabled' where principal_id=${alice.principalId}`.execute(
      tx,
    );
  });
  expect((await service.listWorkspaces(alice)).items).toHaveLength(1);
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) =>
      authorizeWorkspace(tx, alice, fixture.workspaceId),
    ),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('creates idempotently, paginates rosters, rejects cross-scope and stale cursors', async () => {
  const { alice, bob } = fixture;
  const key = randomUUID();
  const w = await service.createWorkspace(alice, { name: 'New team' }, key);
  expect(await service.createWorkspace(alice, { name: 'New team' }, key)).toEqual(w);
  await expect(service.createWorkspace(alice, { name: 'Different' }, key)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect((await service.members(alice, w.id)).items[0]).toMatchObject({
    role: 'admin',
    principal: { id: alice.principalId },
  });
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) => authorizeWorkspace(tx, bob, w.id)),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const first = await service.members(alice, fixture.workspaceId, { limit: 1 });
  expect(first.next_cursor).toBeDefined();
  const second = await service.members(alice, fixture.workspaceId, {
    limit: 1,
    cursor: first.next_cursor!,
  });
  expect(second.items[0]!.principal.id).not.toBe(first.items[0]!.principal.id);
  await expect(service.candidates(alice, { cursor: first.next_cursor! })).rejects.toMatchObject({
    code: 'RESYNC_REQUIRED',
  });
  await service.setMember(
    alice,
    fixture.workspaceId,
    input(bob.principalId, 'guest'),
    '1',
    randomUUID(),
  );
  await expect(
    service.members(alice, fixture.workspaceId, { cursor: first.next_cursor! }),
  ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
});
it('fences old authorization on disable and reactivation; preserves last administrator', async () => {
  const { alice, bob } = fixture;
  await expect(
    service.setMember(
      alice,
      fixture.workspaceId,
      input(alice.principalId, 'member'),
      '1',
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'LAST_WORKSPACE_ADMIN' });
  expect(await ledger.records(alice.tenantId)).toHaveLength(0);
  const key = randomUUID(),
    change = input(bob.principalId, 'member', 'disabled');
  const w = await service.setMember(alice, fixture.workspaceId, change, '1', key);
  expect(w.version).toBe('2');
  expect(await service.setMember(alice, w.id, change, '1', key)).toEqual(w);
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) => authorizeTenant(tx, bob)),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const disabled = await refresh(bob);
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) => authorizeWorkspace(tx, disabled, w.id)),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await service.setMember(alice, w.id, input(bob.principalId), '2', randomUUID());
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) => authorizeTenant(tx, disabled)),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  // A delayed retry of the prior disable command must not undo a later explicit restoration.
  await service.setMember(alice, w.id, change, '1', key);
  const active = await refresh(bob);
  expect(active.authzRevision).toBe('3');
  expect(
    (await service.members(alice, w.id)).items.find((m) => m.principal.id === bob.principalId)
      ?.status,
  ).toBe('active');
  await withTenant(databases.db, alice.tenantId, async (tx) => {
    await authorizeTenant(tx, active);
    await authorizeWorkspace(tx, active, w.id);
  });
  expect(await ledger.records(alice.tenantId)).toHaveLength(1);
});
it('serializes competing administrators and emits exactly one successful change for a workspace version', async () => {
  const { alice, bob, charlie } = fixture;
  await withTenant(databases.owner, alice.tenantId, async (tx) => {
    await sql`update tenant_principals set role='admin' where principal_id=${bob.principalId}`.execute(
      tx,
    );
  });
  const result = await Promise.allSettled([
    service.setMember(
      alice,
      fixture.workspaceId,
      input(charlie.principalId, 'admin'),
      '1',
      randomUUID(),
    ),
    service.setMember(
      bob,
      fixture.workspaceId,
      input(charlie.principalId, 'guest'),
      '1',
      randomUUID(),
    ),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'VERSION_CONFLICT' },
  });
  const rows = await withTenant(databases.db, alice.tenantId, (tx) =>
    sql`select id from domain_events where aggregate_id=${fixture.workspaceId} and event_type='workspace.member_changed'`.execute(
      tx,
    ),
  );
  expect(rows.rows).toHaveLength(1);
});
it('replays independent membership revocation after database rollback, but preserves an explicit newer grant', async () => {
  const { alice, bob } = fixture;
  await service.setMember(
    alice,
    fixture.workspaceId,
    input(bob.principalId, 'guest'),
    '1',
    randomUUID(),
  );
  const facts = await ledger.records(alice.tenantId);
  expect(facts[0]).toMatchObject({
    kind: 'revocation.workspace_member',
    subject_id: bob.principalId,
    target_version: '1',
  });
  await withTenant(databases.owner, alice.tenantId, async (tx) => {
    await sql`delete from policy_receipts where id=${facts[0]!.id}`.execute(tx);
    await sql`update memberships set role='member',status='active',version=1 where workspace_id=${fixture.workspaceId} and principal_id=${bob.principalId}`.execute(
      tx,
    );
    await sql`update tenant_principals set authz_revision=1 where principal_id=${bob.principalId}`.execute(
      tx,
    );
  });
  expect(await replayPolicyLedger(databases.db, ledger, alice.tenantId)).toEqual({ applied: 1 });
  expect(
    (await service.members(alice, fixture.workspaceId)).items.find(
      (x) => x.principal.id === bob.principalId,
    )?.status,
  ).toBe('disabled');
  await expect(
    withTenant(databases.db, alice.tenantId, (tx) => authorizeTenant(tx, bob)),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const w = (await service.listWorkspaces(alice)).items[0]!;
  await service.setMember(alice, w.id, input(bob.principalId), w.version, randomUUID());
  await withTenant(databases.owner, alice.tenantId, (tx) =>
    sql`delete from policy_receipts where id=${facts[0]!.id}`.execute(tx),
  );
  await replayPolicyLedger(databases.db, ledger, alice.tenantId);
  expect(
    (await service.members(alice, w.id)).items.find((x) => x.principal.id === bob.principalId)
      ?.status,
  ).toBe('active');
});
it('fails closed on ledger errors before changing membership or version', async () => {
  const broken = createOrganizationService(databases.db, secret, {
    policyLedger: {
      ...ledger,
      append: async () => {
        throw new Error('ledger unavailable');
      },
    },
  });
  await expect(
    broken.setMember(
      fixture.alice,
      fixture.workspaceId,
      input(fixture.bob.principalId, 'guest'),
      '1',
      randomUUID(),
    ),
  ).rejects.toThrow('ledger unavailable');
  expect((await service.listWorkspaces(fixture.alice)).items[0]?.version).toBe('1');
  expect(
    (await service.members(fixture.alice, fixture.workspaceId)).items.find(
      (x) => x.principal.id === fixture.bob.principalId,
    )?.role,
  ).toBe('member');
});
it('exposes cookie-authenticated, CSRF-protected organization commands with version and idempotency headers', async () => {
  const origin = 'http://localhost:5173';
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    publicOrigin: origin,
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [fixture.alice.principalId, fixture.bob.principalId],
  });
  const app = createApp({ readiness: async () => {}, identity, organization: service });
  try {
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { origin },
      payload: { principal_id: fixture.alice.principalId },
    });
    expect(login.statusCode).toBe(200);
    const headers = {
      origin,
      cookie: `imbox_session=${login.cookies.find((c) => c.name === 'imbox_session')!.value}`,
      'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token,
      'x-imbox-tenant-id': fixture.tenantId,
      'idempotency-key': randomUUID(),
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/organization/workspaces',
      headers: { ...headers, 'x-csrf-token': '' },
      payload: { name: 'HTTP team' },
    });
    expect(denied.statusCode).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/organization/workspaces',
      headers,
      payload: { name: 'HTTP team' },
    });
    expect(created.statusCode).toBe(201);
    const w = assertContract('ManagedWorkspace', created.json());
    const changed = await app.inject({
      method: 'PUT',
      url: `/v1/organization/workspaces/${w.id}/members`,
      headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      payload: input(fixture.bob.principalId),
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ version: '2' });
    const stale = await app.inject({
      method: 'PUT',
      url: `/v1/organization/workspaces/${w.id}/members`,
      headers: { ...headers, 'idempotency-key': randomUUID(), 'if-match': '"1"' },
      payload: input(fixture.bob.principalId, 'guest'),
    });
    expect(stale.statusCode).toBe(409);
  } finally {
    await app.close();
  }
});

it('keeps a captured Run fenced after its creator is demoted and restored', async () => {
  const f = await modelFixture(databases);
  await withTenant(databases.owner, f.tenantId, async (tx) => {
    await sql`update tenant_principals set role='admin' where principal_id=${f.bob.principalId}`.execute(
      tx,
    );
    await sql`update memberships set role='admin' where workspace_id=${f.workspaceId} and principal_id=${f.bob.principalId}`.execute(
      tx,
    );
  });
  const run = await f.createRun();
  const w = await service.setMember(
    f.bob,
    f.workspaceId,
    input(f.alice.principalId, 'guest'),
    '1',
    randomUUID(),
  );
  await expect(f.worker.claim(f.tenantId, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await service.setMember(
    f.bob,
    f.workspaceId,
    input(f.alice.principalId, 'admin'),
    w.version,
    randomUUID(),
  );
  await expect(f.worker.claim(f.tenantId, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const fresh = await refresh(f.alice);
  await expect(f.runtime.getRun(fresh, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    f.runtime.controlRun(fresh, run.id, 'cancel', run.version, randomUUID()),
  ).resolves.toMatchObject({ status: 'cancelled', output: null });
  const next = await f.runtime.createRun(
    fresh,
    {
      agent_id: f.installation.id,
      agent_revision: '1',
      conversation_id: f.chat.id,
      context: [{ type: 'message', id: f.message.id, version: f.message.version, required: true }],
      purpose: 'Explicit fresh authorization',
      destination: 'model:local',
      budget: { currency: 'USD', limit_microunits: '0' },
    },
    randomUUID(),
  );
  await expect(f.worker.claim(f.tenantId, next.id)).resolves.not.toBeNull();
});
