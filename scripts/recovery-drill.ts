import {createNotificationDispatcher} from '@imbox/notifications';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createDatabase, migrateToLatest, sql, withTenant } from '@imbox/db';
import { bootstrapDevelopmentRole } from '@imbox/db/testing';
import {
  createFilePolicyLedger,
  createMessagingService,
  createOutboxProcessor,
  replayPolicyLedger,
} from '@imbox/application';
import { createKnowledgeService, knowledgeResourceIndex } from '@imbox/knowledge';
import {
  createResourceService,
  createS3ObjectStore,
  createResourceCleanup,
} from '@imbox/resources';
import { tenantFixture } from '../tests/helpers/database.js';

/** A real isolated PostgreSQL + S3 restore drill. Never points pg_restore at an existing DB. */
export async function runRecoveryDrill() {
  const required = [
    'TEST_DATABASE_URL',
    'TEST_APP_DATABASE_URL',
    'TEST_IDENTITY_DATABASE_URL',
  ] as const;
  const urls = required.map((name) => new URL(process.env[name] ?? ''));
  if (
    urls.some((u) => !['127.0.0.1', 'localhost'].includes(u.hostname) || u.port !== '55432') ||
    urls[0]!.pathname !== '/imbox_test'
  )
    throw new Error('Recovery drill requires the isolated local test cluster');
  const suffix = randomUUID().replaceAll('-', ''),
    sourceName = `imbox_drill_${suffix}`,
    restoreName = `imbox_restore_${suffix}`;
  const url = (index: number, name: string) => {
    const value = new URL(urls[index]!.href);
    value.pathname = `/${name}`;
    return value.href;
  };
  const management = createDatabase(urls[0]!.href, { max: 1 });
  const directory = await mkdtemp(join(tmpdir(), 'imbox-real-restore-'));
  const ledger = await createFilePolicyLedger({
    directory: join(directory, 'independent-ledger'),
    signingKey: 'recovery-drill-policy-key-independent-of-db-more-than-32-characters',
  });
  const dbs: ReturnType<typeof createDatabase>[] = [];
  const store = createS3ObjectStore({
    endpoint: process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333',
    region: 'us-east-1',
    bucket: 'imbox-resources-test',
    accessKeyId: 'imbox_local_s3_app',
    secretAccessKey: 'imbox_local_s3_app_secret',
  });
  let objectKey: string | undefined;
  const cleanupKeys = new Set<string>();
  async function postgres(args: string[], mode: 'dump' | 'restore', file: string) {
    const process = spawn(
      'docker',
      ['compose', '-f', 'infra/compose.yaml', 'exec', '-T', 'postgres', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let error = '';
    process.stderr.on('data', (chunk) => {
      if (error.length < 4000) error += String(chunk);
    });
    const completion = new Promise<void>((resolve, reject) => {
      process.once('error', reject);
      process.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Postgres drill command failed (${code}): ${error}`)),
      );
    });
    const transfer =
      mode === 'dump'
        ? pipeline(process.stdout, createWriteStream(file, { mode: 0o600 }))
        : pipeline(createReadStream(file), process.stdin);
    if (mode === 'dump') process.stdin.end();
    else process.stdout.resume();
    await Promise.all([completion, transfer]);
  }
  async function openDatabase(name: string, initialize: boolean) {
    const owner = createDatabase(url(0, name), { max: 3 }),
      db = createDatabase(url(1, name), { max: 5 });
    dbs.push(owner, db);
    if (initialize) await migrateToLatest(owner);
    await bootstrapDevelopmentRole(owner, {
      environment: 'test',
      kind: 'application',
      role: urls[1]!.username,
      password: decodeURIComponent(urls[1]!.password),
    });
    return { owner, db };
  }
  const key = () => randomUUID(),
    secret = 'restore-drill-cursor-secret-at-least-32-characters';
  try {
    await sql.raw(`create database "${sourceName}"`).execute(management);
    const original = await openDatabase(sourceName, true),
      f = await tenantFixture(original.owner);
    const messaging = createMessagingService(original.db, secret, { policyLedger: ledger });
    const knowledge = createKnowledgeService({
      db: original.db,
      cursorSecret: secret,
      policyLedger: ledger,
    });
    const resources = createResourceService({
      db: original.db,
      store,
      cursorSecret: secret,
      policyLedger: ledger,
      textIndex: knowledgeResourceIndex(),
    });
    const chat = await messaging.createConversation(
      f.alice,
      {
        workspace_id: f.workspaceId,
        kind: 'group',
        title: 'Isolated recovery drill',
        member_ids: [f.bob.principalId],
        history_policy: 'all',
      },
      key(),
    );
    const message = await messaging.createMessage(
      f.alice,
      chat.id,
      { client_message_id: key(), body: 'DRILL_DELETED_MESSAGE' },
      key(),
    );
    const derived = await knowledge.createMemory(
      f.alice,
      {
        scope: 'personal',
        body: 'DRILL_DERIVED_MEMORY',
        confirmation: 'confirmed',
        confidence: 100,
        source_refs: [
          {
            kind: 'message',
            id: message.id,
            version: message.version,
            sha256: createHash('sha256').update(message.body).digest('hex'),
          },
        ],
      },
      key(),
    );
    const memory = await knowledge.createMemory(
      f.alice,
      {
        scope: 'personal',
        body: 'DRILL_EXPLICIT_MEMORY',
        confirmation: 'confirmed',
        confidence: 100,
        source_refs: [],
      },
      key(),
    );
    const bytes = Buffer.from('DRILL_DELETED_OBJECT'),
      hash = createHash('sha256').update(bytes).digest('hex');
    const ticket = await resources.createUpload(
      f.alice,
      {
        conversation_id: chat.id,
        filename: 'drill.txt',
        content_type: 'text/plain',
        byte_size: bytes.length,
        sha256: hash,
      },
      key(),
    );
    await withTenant(original.db, f.tenantId, async (tx) => {
      const row = (
        await sql<{
          staging_key: string;
          object_key: string;
        }>`select staging_key,object_key from resource_uploads where id=${ticket.id}`.execute(tx)
      ).rows[0]!;
      cleanupKeys.add(row.staging_key);
      cleanupKeys.add(row.object_key);
    });
    assert.equal(
      (
        await fetch(ticket.upload_url, {
          method: 'PUT',
          headers: ticket.upload_headers,
          body: bytes,
        })
      ).status,
      200,
    );
    const resource = await resources.completeUpload(f.alice, ticket.id, key());
    objectKey = await withTenant(
      original.db,
      f.tenantId,
      async (tx) =>
        (
          await sql<{
            object_key: string;
          }>`select object_key from resources where id=${resource.id}`.execute(tx)
        ).rows[0]!.object_key,
    );
    await writeFile(join(directory, 'object.backup'), bytes, { mode: 0o600 });
    const outbox = createOutboxProcessor({ db: original.db });
    for (let i = 0; i < 4; i++) await outbox.processBatch(f.tenantId);
    const backupStarted = Date.now();
    await postgres(
      ['pg_dump', '-U', 'imbox_owner', '-d', sourceName, '-Fc', '--no-owner', '--no-acl'],
      'dump',
      join(directory, 'database.dump'),
    );
    // These accepted deletes and the ACL revocation are deliberately newer than the backup.
    await messaging.changeMessage(f.alice, message.id, null, message.version, key());
    await knowledge.deleteMemory(f.alice, memory.id, memory.version, key());
    await resources.deleteResource(f.alice, resource.id, resource.version, key());
    const current = await messaging.getConversation(f.alice, chat.id);
    await messaging.changeMember(
      f.alice,
      chat.id,
      f.bob.principalId,
      'remove',
      current.version,
      key(),
    );
    const lost = await messaging.createMessage(
      f.alice,
      chat.id,
      { client_message_id: key(), body: 'POST_BACKUP_EXPECTED_LOSS' },
      key(),
    );
    await createResourceCleanup({ db: original.db, store })(f.tenantId);
    await assert.rejects(() => store.read(objectKey!));
    const lossWindowMs = Date.now() - backupStarted;
    const recoveryStart = performance.now();
    await sql.raw(`create database "${restoreName}"`).execute(management);
    await postgres(
      [
        'pg_restore',
        '-U',
        'imbox_owner',
        '-d',
        restoreName,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
      ],
      'restore',
      join(directory, 'database.dump'),
    );
    const restored = await openDatabase(restoreName, false);
    await store.putImmutable(
      objectKey,
      await readFile(join(directory, 'object.backup')),
      'text/plain',
      hash,
    );
    const restoredMessaging = createMessagingService(restored.db, secret, { policyLedger: ledger });
    const restoredKnowledge = createKnowledgeService({
      db: restored.db,
      cursorSecret: secret,
      policyLedger: ledger,
    });
    const restoredResources = createResourceService({
      db: restored.db,
      store,
      cursorSecret: secret,
      policyLedger: ledger,
      textIndex: knowledgeResourceIndex(),
    });
    // Isolated DB has no listeners: prove old data exists before executing the mandatory replay gate.
    assert.equal(
      (await restoredMessaging.getMessage(f.alice, message.id)).body,
      'DRILL_DELETED_MESSAGE',
    );
    assert.equal((await replayPolicyLedger(restored.db, ledger)).applied, 4);
    assert.equal((await restoredMessaging.getMessage(f.alice, message.id)).body, '');
    for (const id of [memory.id, derived.id])
      await assert.rejects(() => restoredKnowledge.getMemory(f.alice, id));
    await assert.rejects(() => restoredMessaging.getConversation(f.bob, chat.id));
    await assert.rejects(() => restoredResources.openDownload(f.alice, resource.id));
    await assert.rejects(() => restoredMessaging.getMessage(f.alice, lost.id));
    await createResourceCleanup({ db: restored.db, store })(f.tenantId);
    await assert.rejects(() => store.read(objectKey!));
    assert.equal((await replayPolicyLedger(restored.db, ledger)).applied, 0);
    await withTenant(restored.db, f.tenantId, async (tx) => {
      const cached = (
        await sql<{
          dto: unknown;
        }>`select dto from projections where entity_id=${message.id}`.execute(tx)
      ).rows;
      assert(!JSON.stringify(cached).includes('DRILL_DELETED_MESSAGE'));
      assert(
        (await sql<{ body: string }>`select body from memory_revisions`.execute(tx)).rows.every(
          (r) => r.body === '',
        ),
      );
    });
    const restoredOutbox = createOutboxProcessor({ db: restored.db });
    const notificationDispatch=createNotificationDispatcher({db:restored.db});
    for (let i = 0; i < 15; i++) {
      await notificationDispatch(f.tenantId,{limit:50,fanoutLimit:100});
      const result = await restoredOutbox.processBatch(f.tenantId);
      assert.equal(result.failed, 0);
      await withTenant(restored.owner, f.tenantId, async (tx) => {
        await sql`update outbox set available_at=clock_timestamp() where status='pending'`.execute(
          tx,
        );
      });
    }
    await withTenant(restored.db, f.tenantId, async (tx) => {
      assert.deepEqual(
        (await sql`select status,last_error_code from outbox where status<>'completed'`.execute(tx))
          .rows,
        [],
      );
    });
    const report = {
      version: 1,
      completed_at: new Date().toISOString(),
      result: 'passed',
      method:
        'isolated PostgreSQL custom-format dump/restore plus restored S3 object and independent signed policy ledger',
      recovery_ms: Math.round(performance.now() - recoveryStart),
      observed_backup_gap_ms: lossWindowMs,
      expected_post_backup_message_loss: 1,
      policy_facts_replayed: 4,
      derived_bodies_erased: true,
      permission_revocation_reapplied: true,
      restored_object_purged: true,
      outbox_reconciled: true,
      point_in_time_wal_recovery_verified: false,
      production_rpo_rto_claim: false,
    };
    await mkdir(resolve('.artifacts'), { recursive: true });
    await writeFile(
      resolve('.artifacts/recovery-drill.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
    return report;
  } finally {
    if (objectKey) cleanupKeys.add(objectKey);
    for (const key of cleanupKeys) await store.delete(key).catch(() => {});
    store.destroy();
    await Promise.all(dbs.map((db) => db.destroy()));
    for (const name of [restoreName, sourceName]) {
      for (let i = 0; i < 50; i++) {
        const remaining = (
          await sql<{
            n: string;
          }>`select count(*) as n from pg_stat_activity where datname=${name}`.execute(management)
        ).rows[0]!;
        if (remaining.n === '0') break;
        await delay(50);
      }
      await sql.raw(`drop database if exists "${name}"`).execute(management);
    }
    await management.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}
