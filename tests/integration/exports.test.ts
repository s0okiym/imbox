import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { createGovernanceService } from '@imbox/governance';
import { createMessagingService, createTaskService } from '@imbox/application';
import { createKnowledgeService } from '@imbox/knowledge';
import { createIdentityService } from '@imbox/auth';
import { assertContract } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>, f: Awaited<ReturnType<typeof tenantFixture>>;
const secret = 'export-secret-with-at-least-thirty-two-characters',
  key = () => randomUUID();
const messaging = () => createMessagingService(db.db, secret);
const knowledge = () => createKnowledgeService({ db: db.db, cursorSecret: secret });
const service = () =>
  createGovernanceService({
    db: db.db,
    messaging: messaging(),
    tasks: createTaskService(db.db, secret),
    knowledge: knowledge(),
    independentLedger: false,
  });
const group = () =>
  messaging().createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: 'Export scope',
      member_ids: [f.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
const send = (id: string, body: string) =>
  messaging().createMessage(f.alice, id, { body, client_message_id: key() }, key());
beforeAll(async () => {
  db = await testDatabases();
});
beforeEach(async () => {
  f = await tenantFixture(db.owner);
});
afterAll(async () => {
  await db?.close();
});
describe('scoped live exports', () => {
  it('exports current authorized messages with integrity marker; creation is idempotent and actor bound', async () => {
    const c = await group();
    await send(c.id, 'Exported text');
    const k = key(),
      input = { scope: 'conversation' as const, scope_id: c.id };
    const job = await service().createExport(f.alice, input, k);
    expect((await service().createExport(f.alice, input, k)).id).toBe(job.id);
    assertContract('ExportJob', job);
    await expect(service().getExport(f.bob, job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const lines = [];
    for await (const line of (await service().content(f.alice, job.id)).records()) lines.push(line);
    const records = lines.map((s) => JSON.parse(s));
    expect(records.find((r) => r.type === 'message').data.body).toBe('Exported text');
    expect(records.at(-1)).toEqual({
      type: 'complete',
      data: {
        records: lines.length - 1,
        sha256: createHash('sha256').update(lines.slice(0, -1).join('')).digest('hex'),
      },
    });
    expect(JSON.stringify(records)).not.toContain('authorization_snapshot');
  });
  it('stops a download at revocation and never emits a successful complete marker', async () => {
    const c = await group();
    await send(c.id, 'first-visible');
    await send(c.id, 'second-must-not-leak');
    const job = await service().createExport(
      f.bob,
      { scope: 'conversation', scope_id: c.id },
      key(),
    );
    const iterator = (await service().content(f.bob, job.id)).records();
    const seen = [];
    while (true) {
      const item = await iterator.next();
      if (item.done) break;
      const parsed = JSON.parse(item.value);
      seen.push(parsed);
      if (parsed.type === 'message') {
        const current = await messaging().getConversation(f.alice, c.id);
        await messaging().changeMember(
          f.alice,
          c.id,
          f.bob.principalId,
          'remove',
          current.version,
          key(),
        );
      }
    }
    expect(seen.at(-1)).toEqual({ type: 'error', data: { code: 'EXPORT_INTERRUPTED' } });
    expect(seen.some((r) => r.type === 'complete')).toBe(false);
    expect(JSON.stringify(seen)).not.toContain('second-must-not-leak');
    await expect(service().getExport(f.bob, job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('personal export excludes shared memories and respects expiry and invalid scopes', async () => {
    const c = await group();
    for (const scope of ['personal', 'conversation'] as const)
      await knowledge().createMemory(
        f.alice,
        {
          scope,
          ...(scope === 'conversation' ? { conversation_id: c.id } : {}),
          body: `${scope}-entry`,
          source_refs: [],
          confirmation: 'confirmed',
          confidence: 100,
        },
        key(),
      );
    const job = await service().createExport(f.alice, { scope: 'personal' }, key()),
      lines = [];
    for await (const line of (await service().content(f.alice, job.id)).records())
      lines.push(JSON.parse(line));
    expect(lines.filter((l) => l.type === 'memory').map((l) => l.data.body)).toEqual([
      'personal-entry',
    ]);
    await expect(
      service().createExport(f.alice, { scope: 'personal', scope_id: c.id }, key()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service().createExport(f.charlie, { scope: 'conversation', scope_id: c.id }, key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update governance_exports set expires_at=clock_timestamp()-interval '1 second' where id=${job.id}`.execute(
        tx,
      );
    });
    await expect(service().content(f.alice, job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('HTTP exposes policy, guarded creation, and an attachment stream with current-session checks', async () => {
    const identity = createIdentityService({
      db: db.db,
      identityDb: db.identityDb,
      publicOrigin: 'http://imbox.test',
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [f.alice.principalId],
    });
    const app = createApp({ readiness: async () => {}, identity, governance: service() });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev-login',
        headers: { origin: 'http://imbox.test' },
        payload: { principal_id: f.alice.principalId },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const me = await app.inject({
        url: '/v1/me',
        headers: { cookie, 'x-imbox-tenant-id': f.tenantId },
      });
      const csrf = me.json().csrf_token;
      const headers = {
        cookie,
        origin: 'http://imbox.test',
        'x-imbox-tenant-id': f.tenantId,
        'x-csrf-token': csrf,
        'idempotency-key': key(),
      };
      const response = await app.inject({
        method: 'POST',
        url: '/v1/exports',
        headers,
        payload: { scope: 'personal' },
      });
      expect(response.statusCode).toBe(201);
      assertContract('ExportJob', response.json());
      const download = await app.inject({ url: response.json().content_url, headers });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/x-ndjson');
      expect(download.headers['content-disposition']).toContain('attachment');
      expect(JSON.parse(download.body.trim().split('\n').at(-1)!)).toMatchObject({
        type: 'complete',
      });
      const policy = await app.inject({ url: '/v1/governance/policy', headers });
      expect(policy.statusCode).toBe(200);
      assertContract('GovernancePolicy', policy.json());
      const forged = await app.inject({
        method: 'POST',
        url: '/v1/exports',
        headers: { ...headers, 'idempotency-key': key() },
        payload: { scope: 'personal', created_by: f.bob.principalId },
      });
      expect(forged.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
