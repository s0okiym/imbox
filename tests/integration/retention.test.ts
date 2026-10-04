import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect } from 'vitest';
import { createRetentionWorker, configuredRetentionPolicy } from '@imbox/governance';
import { createRuntimeMaintenance } from '@imbox/runtime';
import {
  createFilePolicyLedger,
  createOutboxProcessor,
  type PolicyLedger,
} from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import { modelFixture } from '../helpers/model.js';
import { testDatabases } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>,
  f: Awaited<ReturnType<typeof modelFixture>>,
  ledger: PolicyLedger,
  directory: string;
const policy = { messageDays: 365, resourceDays: 365, runContentDays: 7 };
beforeAll(async () => {
  db = await testDatabases();
});
beforeEach(async () => {
  f = await modelFixture(db);
  directory = await mkdtemp(join(tmpdir(), 'imbox-retention-'));
  ledger = await createFilePolicyLedger({
    directory,
    signingKey: 'retention-test-independent-signing-key-more-than-thirty-two-characters',
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});
describe('bounded retention and Run lifetime maintenance', () => {
  it('deletes expired content once, persists a recovery tombstone, and leaves subsequent outbox processing usable', async () => {
    const current = await f.messaging.createMessage(
      f.alice,
      f.chat.id,
      { body: 'keep-this-message', client_message_id: randomUUID() },
      randomUUID(),
    );
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update messages set created_at=clock_timestamp()-interval '366 days' where id=${f.message.id}`.execute(
        tx,
      );
    });
    const retention = createRetentionWorker({ db: db.db, ledger, policy });
    const result = await Promise.all([retention(f.tenantId), retention(f.tenantId)]);
    expect(result.reduce((n, r) => n + r.deleted, 0)).toBe(1);
    expect((await f.messaging.getMessage(f.alice, f.message.id)).deleted).toBe(true);
    expect((await f.messaging.getMessage(f.alice, current.id)).body).toBe('keep-this-message');
    expect(await ledger.records(f.tenantId)).toHaveLength(1);
    const chat = await f.messaging.getConversation(f.alice, f.chat.id);
    await f.messaging.changeMember(
      f.alice,
      chat.id,
      f.bob.principalId,
      'add',
      chat.version,
      randomUUID(),
    );
    const processor = createOutboxProcessor({ db: db.db });
    for (let i = 0; i < 12; i++) {
      const r = await processor.processBatch(f.tenantId);
      expect(r.failed).toBe(0);
      if (!r.claimed) break;
      await withTenant(db.owner, f.tenantId, async (tx) => {
        await sql`update outbox set available_at=clock_timestamp() where status='pending'`.execute(
          tx,
        );
      });
    }
    await withTenant(db.db, f.tenantId, async (tx) => {
      expect(
        (await sql`select id from outbox where status<>'completed'`.execute(tx)).rows,
      ).toHaveLength(0);
    });
  });
  it('removes terminal Run input, output and checkpoint bodies after retention without deleting usage evidence', async () => {
    const run = await f.createRun(),
      claim = (await f.worker.claim(f.tenantId, run.id))!;
    await f.worker.report(
      claim,
      {
        status: 'completed',
        checkpoint: { private: 'checkpoint-secret' },
        summary: 'summary-secret',
        output: 'output-secret',
      },
      randomUUID(),
    );
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update agent_runs set updated_at=clock_timestamp()-interval '8 days' where id=${run.id}`.execute(
        tx,
      );
    });
    expect(await createRetentionWorker({ db: db.db, ledger, policy })(f.tenantId)).toEqual({
      deleted: 1,
    });
    await withTenant(db.db, f.tenantId, async (tx) => {
      const r = (
        await sql<{
          output: null;
          summary: string;
          content_redacted_at: Date;
        }>`select output,summary,content_redacted_at from agent_runs where id=${run.id}`.execute(tx)
      ).rows[0]!;
      expect(r.output).toBeNull();
      expect(r.summary).toBe('');
      expect(r.content_redacted_at).toBeInstanceOf(Date);
      expect(
        (
          await sql<{
            payload: unknown;
          }>`select payload from run_checkpoints where run_id=${run.id}`.execute(tx)
        ).rows.every((r) => JSON.stringify(r.payload) === '{}'),
      ).toBe(true);
      expect(
        (
          await sql<{
            payload: unknown;
          }>`select payload from context_items where manifest_id=${run.context_manifest_id}`.execute(
            tx,
          )
        ).rows.every((r) => JSON.stringify(r.payload) === '{}'),
      ).toBe(true);
    });
    expect((await ledger.records(f.tenantId))[0]?.kind).toBe('deletion.run');
    expect(await createRetentionWorker({ db: db.db, ledger, policy })(f.tenantId)).toEqual({
      deleted: 0,
    });
  });
  it('expires work at the durable lifetime and keeps unresolved reservations unknown', async () => {
    const run = await f.createRun(),
      claim = (await f.worker.claim(f.tenantId, run.id))!;
    const hold = await f.worker.reserve(claim, {
      reservation_key: 'pending-model-reservation',
      amount_microunits: '0',
      currency: 'USD',
    });
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update agent_runs set created_at=clock_timestamp()-interval '25 hours' where id=${run.id}`.execute(
        tx,
      );
    });
    const maintenance = createRuntimeMaintenance(db.db),
      results = await Promise.all([maintenance(f.tenantId), maintenance(f.tenantId)]);
    expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
    await expect(
      f.worker.report(
        claim,
        { status: 'completed', checkpoint: {}, output: 'stale-result' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await withTenant(db.db, f.tenantId, async (tx) => {
      expect(
        (
          await sql`select status,budget_blocked,lease_holder from agent_runs where id=${run.id}`.execute(
            tx,
          )
        ).rows[0],
      ).toEqual({ status: 'expired', budget_blocked: true, lease_holder: null });
      expect(
        (
          await sql<{
            status: string;
          }>`select status from runtime_reservations where id=${hold.id}`.execute(tx)
        ).rows[0]?.status,
      ).toBe('unknown');
    });
  });
  it('rejects invalid policy configuration and batch sizes', async () => {
    expect(configuredRetentionPolicy({})).toEqual(policy);
    expect(() => configuredRetentionPolicy({ RETENTION_MESSAGE_DAYS: '0' })).toThrow();
    expect(() => configuredRetentionPolicy({ RETENTION_RESOURCE_DAYS: '1.5' })).toThrow();
    await expect(
      createRetentionWorker({ db: db.db, ledger, policy })(f.tenantId, 0),
    ).rejects.toThrow('batch');
  });
});
