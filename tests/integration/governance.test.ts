import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createFilePolicyLedger,
  recordPolicy,
  replayPolicyLedger,
  createMessagingService,
  createOutboxProcessor,
  type PolicyLedger,
} from '@imbox/application';
import { createKnowledgeService } from '@imbox/knowledge';
import { sql, withTenant } from '@imbox/db';
import { testDatabases, tenantFixture } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>,
  f: Awaited<ReturnType<typeof tenantFixture>>,
  ledger: PolicyLedger,
  directory: string;
const secret = 'governance-secret-longer-than-thirty-two-characters',
  key = () => randomUUID();
const messaging = () => createMessagingService(db.db, secret, { policyLedger: ledger });
const knowledge = () =>
  createKnowledgeService({ db: db.db, cursorSecret: secret, policyLedger: ledger });
const group = () =>
  messaging().createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: 'Governance',
      member_ids: [f.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
beforeAll(async () => {
  db = await testDatabases();
});
beforeEach(async () => {
  f = await tenantFixture(db.owner);
  directory = await mkdtemp(join(tmpdir(), 'imbox-governance-'));
  ledger = await createFilePolicyLedger({ directory, signingKey: secret });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});
describe('deletion and permission recovery', () => {
  it('records only authorized deletion and synchronously removes derived memory and projection bodies', async () => {
    const c = await group(),
      m = await messaging().createMessage(
        f.alice,
        c.id,
        { body: 'secret-delete-me', client_message_id: key() },
        key(),
      );
    const mem = await knowledge().createMemory(
      f.alice,
      {
        scope: 'personal',
        body: 'Derived secret-delete-me',
        confirmation: 'confirmed',
        confidence: 100,
        source_refs: [
          {
            kind: 'message',
            id: m.id,
            version: m.version,
            sha256: createHash('sha256').update(m.body).digest('hex'),
          },
        ],
      },
      key(),
    );
    const worker = createOutboxProcessor({ db: db.db });
    await worker.processBatch(f.tenantId);
    await worker.processBatch(f.tenantId);
    await expect(
      messaging().changeMessage(f.bob, m.id, null, m.version, key()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ledger.records(f.tenantId)).toHaveLength(0);
    await messaging().changeMessage(f.alice, m.id, null, m.version, key());
    expect(await ledger.records(f.tenantId)).toHaveLength(1);
    await expect(knowledge().getMemory(f.alice, mem.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await withTenant(db.db, f.tenantId, async (tx) => {
      expect(
        (
          await sql<{
            body: string;
          }>`select body from memory_revisions where memory_id=${mem.id}`.execute(tx)
        ).rows.every((r) => r.body === ''),
      ).toBe(true);
      expect(
        (
          await sql<{ dto: unknown }>`select dto from projections where entity_id=${m.id}`.execute(
            tx,
          )
        ).rows.every((r) => !JSON.stringify(r.dto).includes('secret-delete-me')),
      ).toBe(true);
      expect((await sql`select id from policy_receipts`.execute(tx)).rows).toHaveLength(1);
    });
    expect(await replayPolicyLedger(db.db, ledger)).toEqual({ applied: 0 });
  });
  it('replays the independent accepted intent after an interrupted database transaction', async () => {
    const c = await group(),
      m = await messaging().createMessage(
        f.alice,
        c.id,
        { body: 'rollback-private', client_message_id: key() },
        key(),
      );
    await expect(
      withTenant(db.db, f.tenantId, async (tx) => {
        await recordPolicy(tx, f.alice, ledger, {
          kind: 'deletion.message',
          target_id: m.id,
          target_version: m.version,
        });
        throw new Error('injected database rollback');
      }),
    ).rejects.toThrow('injected');
    expect((await messaging().getMessage(f.alice, m.id)).body).toBe('rollback-private');
    expect(await replayPolicyLedger(db.db, ledger)).toEqual({ applied: 1 });
    expect((await messaging().getMessage(f.alice, m.id)).deleted).toBe(true);
    expect(await replayPolicyLedger(db.db, ledger)).toEqual({ applied: 0 });
  });
  it('restored old message and memory bodies are erased before reads resume, with concurrent replay once', async () => {
    const c = await group(),
      m = await messaging().createMessage(
        f.alice,
        c.id,
        { body: 'before-backup', client_message_id: key() },
        key(),
      );
    const mem = await knowledge().createMemory(
      f.alice,
      {
        scope: 'personal',
        body: 'remember-before-backup',
        confirmation: 'confirmed',
        confidence: 100,
        source_refs: [],
      },
      key(),
    );
    await messaging().changeMessage(f.alice, m.id, null, m.version, key());
    await knowledge().deleteMemory(f.alice, mem.id, mem.version, key());
    // Fixture restores the pre-delete rows and loses PG receipts; separate pg_dump drill covers full restore.
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update messages set body='before-backup',deleted_at=null,version=1 where id=${m.id}`.execute(
        tx,
      );
      await sql`update memory_items set status='active',deleted_at=null,version=1 where id=${mem.id}`.execute(
        tx,
      );
      await sql`update memory_revisions set body='remember-before-backup',redacted_at=null where memory_id=${mem.id}`.execute(
        tx,
      );
      await sql`delete from policy_receipts where tenant_id=${f.tenantId}`.execute(tx);
      await sql`delete from outbox where event_id in(select id from domain_events where aggregate_id=any(${[m.id, mem.id]}::uuid[]) and aggregate_version>1)`.execute(
        tx,
      );
      // Restore also rolls back the queue row created atomically with each lost domain event.
      await sql`delete from notification_event_queue where tenant_id=${f.tenantId} and event_id in(select id from domain_events where aggregate_id=any(${[m.id, mem.id]}::uuid[]) and aggregate_version>1)`.execute(
        tx,
      );
      await sql`delete from domain_events where aggregate_id=any(${[m.id, mem.id]}::uuid[]) and aggregate_version>1`.execute(
        tx,
      );
    });
    const results = await Promise.all([
      replayPolicyLedger(db.db, ledger),
      replayPolicyLedger(db.db, ledger),
    ]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(2);
    expect((await messaging().getMessage(f.alice, m.id)).body).toBe('');
    await expect(knowledge().getMemory(f.alice, mem.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('restores revocations while preserving a later explicit regrant', async () => {
    let c = await group();
    c = await messaging().changeMember(
      f.alice,
      c.id,
      f.bob.principalId,
      'remove',
      c.version,
      key(),
    );
    expect(await ledger.records(f.tenantId)).toHaveLength(1);
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update conversation_members set status='active',version=1,left_at=null where conversation_id=${c.id} and principal_id=${f.bob.principalId}`.execute(
        tx,
      );
      await sql`delete from policy_receipts where tenant_id=${f.tenantId}`.execute(tx);
    });
    await replayPolicyLedger(db.db, ledger);
    await expect(messaging().getConversation(f.bob, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    c = await messaging().getConversation(f.alice, c.id);
    await messaging().changeMember(f.alice, c.id, f.bob.principalId, 'add', c.version, key());
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`delete from policy_receipts where tenant_id=${f.tenantId}`.execute(tx);
    });
    await replayPolicyLedger(db.db, ledger);
    expect((await messaging().getConversation(f.bob, c.id)).id).toBe(c.id);
  });
  it('ledger failure prevents acknowledgment and database mutation', async () => {
    const c = await group(),
      m = await messaging().createMessage(
        f.alice,
        c.id,
        { body: 'survives-failed-intent', client_message_id: key() },
        key(),
      );
    const failing: PolicyLedger = {
      ...ledger,
      append: async () => {
        throw new Error('ledger unavailable');
      },
    };
    await expect(
      createMessagingService(db.db, secret, { policyLedger: failing }).changeMessage(
        f.alice,
        m.id,
        null,
        m.version,
        key(),
      ),
    ).rejects.toThrow('ledger unavailable');
    expect((await messaging().getMessage(f.alice, m.id)).body).toBe(m.body);
    expect(await ledger.records(f.tenantId)).toHaveLength(0);
  });
});
