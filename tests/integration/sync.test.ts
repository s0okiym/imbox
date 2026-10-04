import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  createMessagingService,
  createOutboxProcessor,
  createSyncService,
  type MessagingService,
  type OutboxProcessor,
  type SyncService,
} from '@imbox/application';
import { createIdentityService, registerAuthRoutes } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { createApp } from '../../apps/api/src/app.js';
import { registerSyncRoutes } from '../../apps/api/src/sync-routes.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let messaging: MessagingService;
let sync: SyncService;
let worker: OutboxProcessor;
const secret = 'sync-test-secret-at-least-thirty-two-bytes-long';
const origin = 'http://imbox.test';
const apps: ReturnType<typeof createApp>[] = [];
const sockets: WebSocket[] = [];
beforeAll(async () => {
  databases = await testDatabases();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  messaging = createMessagingService(databases.db, secret);
  sync = createSyncService({ db: databases.db, cursorSecret: secret });
  worker = createOutboxProcessor({ db: databases.db });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
afterAll(async () => {
  await databases?.close();
});
const key = () => randomUUID();
const group = () =>
  messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: '同步测试',
      kind: 'group',
      member_ids: [fixture.bob.principalId],
      history_policy: 'since_join',
    },
    key(),
  );
const send = (id: string, body = '原始正文') =>
  messaging.createMessage(fixture.alice, id, { client_message_id: key(), body }, key());
async function drain() {
  for (let i = 0; i < 20; i++) {
    const result = await worker.processBatch(fixture.tenantId);
    expect(result.failed).toBe(0);
    if (!result.claimed) return;
    if (result.deferred)
      await withTenant(databases.owner, fixture.tenantId, (tx) =>
        tx
          .updateTable('outbox')
          .set({ available_at: sql`clock_timestamp()` })
          .where('status', '=', 'pending')
          .execute(),
      );
  }
  throw new Error('Outbox did not drain');
}
async function server(maxPendingAcks = 256) {
  const identity = createIdentityService({
    db: databases.db,
    identityDb: databases.identityDb,
    publicOrigin: origin,
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [fixture.alice.principalId, fixture.bob.principalId],
  });
  const app = createApp({ readiness: async () => {} });
  app.register(async (scope) => {
    await registerAuthRoutes(scope, { identity });
    await registerSyncRoutes(scope, { identity, sync, pollIntervalMs: 20, maxPendingAcks });
  });
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, identity };
}
function connect(address: string, token: string) {
  const socket = new WebSocket(
    `${address.replace('http:', 'ws:')}/v1/ws?tenant_id=${fixture.tenantId}`,
    { headers: { origin, cookie: `imbox_session=${token}` } },
  );
  sockets.push(socket);
  type Frame = {
    type: string;
    cursor?: string;
    payload?: { message?: { id: string; body: string } };
    stream_id?: string;
    reason?: string;
  };
  const inbox: Frame[] = [];
  const waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as Frame;
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index === -1) inbox.push(frame);
    else {
      const waiter = waiters.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  });
  socket.on('close', () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Socket closed before expected frame'));
    }
  });
  function next(predicate: (frame: Frame) => boolean) {
    const index = inbox.findIndex(predicate);
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]!);
    return new Promise<Frame>((resolve, reject) => {
      const entry = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i !== -1) waiters.splice(i, 1);
          reject(new Error('Expected websocket frame timed out'));
        }, 5000),
      };
      waiters.push(entry);
    });
  }
  return {
    socket,
    next,
    async hello() {
      await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'hello', protocol_version: 1, client_id: key() }));
      await next((frame) => frame.type === 'welcome');
    },
  };
}

describe('durable outbox projection and caller-bound fixed snapshots', () => {
  it('projects an independent conversation while another conversation is locked', async () => {
    const blockedChat = await group(),
      freeChat = await group();
    await drain();
    await send(blockedChat.id, 'Blocked stream');
    const freeMessage = await send(freeChat.id, 'Independent stream');
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await tx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', blockedChat.id)
        .forUpdate()
        .execute();
      locked();
      await unlock;
    });
    await held;
    const processing = worker.processBatch(fixture.tenantId);
    try {
      await expect
        .poll(async () =>
          withTenant(
            databases.db,
            fixture.tenantId,
            async (tx) =>
              !!(await tx
                .selectFrom('projections')
                .select('id')
                .where('entity_id', '=', freeMessage.id)
                .executeTakeFirst()),
          ),
        )
        .toBe(true);
    } finally {
      release();
      await lock;
    }
    expect((await processing).failed).toBe(0);
  });

  it('lets multiple workers share SKIP LOCKED leases while preserving committed stream order', async () => {
    const conversation = await group();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => send(conversation.id, `并发消息${index}`)),
    );
    const workers = Array.from({ length: 4 }, (_, index) =>
      createOutboxProcessor({ db: databases.db, holder: `parallel-${index}` }),
    );
    const results = await Promise.all(
      workers.map((processor) => processor.processBatch(fixture.tenantId, { limit: 4 })),
    );
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    await drain();
    const rows = await withTenant(databases.db, fixture.tenantId, (tx) =>
      tx
        .selectFrom('projection_deliveries')
        .select('delivery_seq')
        .where('stream_id', '=', conversation.id)
        .orderBy('delivery_seq')
        .execute(),
    );
    expect(rows.map((row) => row.delivery_seq)).toEqual(
      Array.from({ length: 13 }, (_, index) => String(index + 1)),
    );
    const snapshot = await sync.snapshot(fixture.alice, conversation.id);
    expect(snapshot.items.filter((item) => item.entity.type === 'message')).toHaveLength(12);
  });
  it('rolls back failed projection/checkpoint/receipt together and retries from durable outbox', async () => {
    const conversation = await group();
    await drain();
    const message = await send(conversation.id);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('messages')
        .set({ body: 'x'.repeat(20000) })
        .where('id', '=', message.id)
        .execute(),
    );
    const claim = (await worker.claimBatch(fixture.tenantId))[0]!;
    expect(await worker.processClaim(claim)).toBe('failed');
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect(
        await tx.selectFrom('projections').select('id').where('id', '=', message.id).execute(),
      ).toEqual([]);
      expect(
        await tx
          .selectFrom('projection_checkpoints')
          .select('aggregate_id')
          .where('aggregate_id', '=', message.id)
          .execute(),
      ).toEqual([]);
      expect(
        await tx
          .selectFrom('outbox')
          .select(['status', 'last_error_code'])
          .where('id', '=', claim.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ status: 'pending', last_error_code: 'PROJECTION_FAILED' });
    });
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await tx
        .updateTable('messages')
        .set({ body: '修复后重试' })
        .where('id', '=', message.id)
        .execute();
      await tx
        .updateTable('outbox')
        .set({ available_at: sql`clock_timestamp()` })
        .where('id', '=', claim.id)
        .execute();
    });
    await drain();
    const snapshot = await sync.snapshot(fixture.alice, conversation.id);
    expect(
      snapshot.items.find((item) => item.entity.id === message.id)?.payload.message?.body,
    ).toBe('修复后重试');
  });
  it('defers out-of-order events and attributes current content to its real authoritative event/version', async () => {
    const conversation = await group();
    const message = await send(conversation.id);
    await messaging.changeMessage(fixture.alice, message.id, { body: '最新正文' }, '1', key());
    const claims = await worker.claimBatch(fixture.tenantId);
    const events = await withTenant(databases.db, fixture.tenantId, (tx) =>
      tx
        .selectFrom('outbox as o')
        .innerJoin('domain_events as e', (join) =>
          join.onRef('e.tenant_id', '=', 'o.tenant_id').onRef('e.id', '=', 'o.event_id'),
        )
        .select(['o.id', 'e.id as event_id', 'e.aggregate_type', 'e.aggregate_version'])
        .execute(),
    );
    const second = events.find(
      (event) => event.aggregate_type === 'message' && event.aggregate_version === '2',
    )!;
    const first = events.find(
      (event) => event.aggregate_type === 'message' && event.aggregate_version === '1',
    )!;
    expect(await worker.processClaim(claims.find((claim) => claim.id === second.id)!)).toBe(
      'deferred',
    );
    expect(await worker.processClaim(claims.find((claim) => claim.id === first.id)!)).toBe(
      'completed',
    );
    for (const claim of claims.filter((item) => ![first.id, second.id].includes(item.id)))
      expect(await worker.processClaim(claim)).toBe('completed');
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('outbox')
        .set({ available_at: sql`clock_timestamp()` })
        .where('id', '=', second.id)
        .execute(),
    );
    await drain();
    const snapshot = await sync.snapshot(fixture.alice, conversation.id);
    const projected = snapshot.items.find((item) => item.entity.id === message.id)!;
    expect(projected).toMatchObject({
      event_id: second.event_id,
      entity: { version: '2' },
      projection_revision: '2',
      payload: { message: { body: '最新正文', version: '2' } },
    });
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect(
        await tx
          .selectFrom('projection_deliveries')
          .selectAll()
          .where('projection_id', '=', message.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await tx
            .selectFrom('projection_checkpoints')
            .select('last_event_version')
            .where('aggregate_id', '=', message.id)
            .executeTakeFirstOrThrow()
        ).last_event_version,
      ).toBe('2');
      expect(await tx.selectFrom('consumer_receipts').selectAll().execute()).toHaveLength(3);
    });
  });
  it('deduplicates replayed delivery and fences an expired/stolen worker lease', async () => {
    const conversation = await group();
    const old = (await worker.claimBatch(fixture.tenantId))[0]!;
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('outbox')
        .set({ lease_expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where('id', '=', old.id)
        .execute(),
    );
    const replacement = createOutboxProcessor({ db: databases.db, holder: 'replacement-worker' });
    const current = (await replacement.claimBatch(fixture.tenantId))[0]!;
    expect(BigInt(current.generation)).toBe(BigInt(old.generation) + 1n);
    expect(await worker.processClaim(old)).toBe('stale');
    expect(await replacement.processClaim(current)).toBe('completed');
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('outbox')
        .set({ status: 'pending', available_at: sql`clock_timestamp()` })
        .where('id', '=', old.id)
        .execute(),
    );
    await drain();
    const snapshot = await sync.snapshot(fixture.alice, conversation.id);
    expect(snapshot.items).toHaveLength(1);
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect(
        (
          await tx
            .selectFrom('projection_streams')
            .select('head_seq')
            .where('id', '=', conversation.id)
            .executeTakeFirstOrThrow()
        ).head_seq,
      ).toBe('1');
      expect(await tx.selectFrom('consumer_receipts').selectAll().execute()).toHaveLength(1);
    });
  });
  it('keeps all snapshot pages at one materialized view while edits/new messages arrive, then catches up from its fixed head', async () => {
    const conversation = await group();
    const old = await send(conversation.id);
    await drain();
    const first = await sync.snapshot(fixture.alice, conversation.id, { limit: 1 });
    expect(first.complete).toBe(false);
    await messaging.changeMessage(fixture.alice, old.id, { body: '更改后的正文' }, '1', key());
    const added = await send(conversation.id, '快照后新增');
    await drain();
    const second = await sync.snapshot(fixture.alice, conversation.id, {
      cursor: first.next_cursor!,
      limit: 1,
    });
    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(second.cursor).toBe(first.cursor);
    expect(second.complete).toBe(true);
    expect(second.items[0]!.payload.message?.body).toBe('原始正文');
    const updates = await sync.events(fixture.alice, conversation.id, { cursor: second.cursor });
    expect(updates.items.map((item) => item.entity.id)).toEqual([old.id, added.id]);
    expect(updates.items[0]!.payload.message?.body).toBe('更改后的正文');
    const empty = await sync.events(fixture.alice, conversation.id, { cursor: updates.cursor });
    expect(empty.items).toEqual([]);
    expect(empty.has_more).toBe(false);
    expect(empty.cursor).toBe(updates.cursor);
    await expect(
      sync.events(fixture.bob, conversation.id, { cursor: updates.cursor }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      sync.events(fixture.alice, conversation.id, {
        cursor: updates.cursor.slice(0, -1) + (updates.cursor.endsWith('A') ? 'B' : 'A'),
      }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  });
  it('invalidates snapshots/cursors immediately on content withdrawal and never exposes stale projected bodies', async () => {
    const conversation = await group();
    const message = await send(conversation.id, '必须立即撤回的秘密');
    await drain();
    const first = await sync.snapshot(fixture.alice, conversation.id, { limit: 1 });
    await messaging.changeMessage(fixture.alice, message.id, null, '1', key());
    // Worker has intentionally not projected the deletion yet.
    await expect(
      sync.snapshot(fixture.alice, conversation.id, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      sync.events(fixture.alice, conversation.id, { cursor: first.cursor }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    const fresh = await sync.snapshot(fixture.alice, conversation.id);
    expect(JSON.stringify(fresh)).not.toContain('必须立即撤回的秘密');
    await drain();
    const updates = await sync.events(fixture.alice, conversation.id, { cursor: fresh.cursor });
    expect(JSON.stringify(updates)).not.toContain('必须立即撤回的秘密');
    expect(updates.items.find((item) => item.entity.id === message.id)).toMatchObject({
      type: 'projection.remove',
      payload: { message: { body: '', deleted: true } },
    });
  });
  it('enforces since-join history, workspace membership, permission generation, snapshot TTL and retention generation', async () => {
    const conversation = await group();
    const hidden = await send(conversation.id, '加入前不能读取');
    await drain();
    const baseline = await sync.snapshot(fixture.alice, conversation.id, { limit: 1 });
    const changed = await messaging.changeMember(
      fixture.alice,
      conversation.id,
      fixture.charlie.principalId,
      'add',
      conversation.version,
      key(),
    );
    await expect(
      sync.events(fixture.alice, conversation.id, { cursor: baseline.cursor }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await send(conversation.id, '加入后可以读取');
    await drain();
    const snapshot = await sync.snapshot(fixture.charlie, conversation.id);
    expect(snapshot.items.some((item) => item.entity.id === hidden.id)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('加入前不能读取');
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('memberships')
        .set({ status: 'disabled' })
        .where('principal_id', '=', fixture.charlie.principalId)
        .execute(),
    );
    await expect(
      sync.events(fixture.charlie, conversation.id, { cursor: snapshot.cursor }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const paged = await sync.snapshot(fixture.alice, conversation.id, { limit: 1 });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('sync_snapshot_sessions')
        .set({ expires_at: sql`clock_timestamp() - interval '1 second'` })
        .where('id', '=', paged.snapshot_id)
        .execute(),
    );
    await expect(
      sync.snapshot(fixture.alice, conversation.id, { cursor: paged.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await worker.purgeExpiredSnapshots(fixture.tenantId);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('projection_streams')
        .set({ retention_generation: '2' })
        .where('id', '=', conversation.id)
        .execute(),
    );
    await expect(
      sync.events(fixture.alice, conversation.id, { cursor: paged.cursor }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    expect(changed.authz_generation).toBe('2');
  });
});

describe('HTTP snapshots and real WebSocket delivery/recovery', () => {
  it('delivers persistent events, accepts transport ACK without changing read state, and resumes after disconnection', async () => {
    const conversation = await group();
    await drain();
    const host = await server();
    const session = await host.identity.devLogin({
      principalId: fixture.alice.principalId,
      origin,
    });
    const httpSnapshot = await host.app.inject({
      url: `/v1/streams/${conversation.id}/snapshot`,
      headers: { cookie: `imbox_session=${session.token}`, 'x-imbox-tenant-id': fixture.tenantId },
    });
    expect(httpSnapshot.statusCode).toBe(200);
    const first = connect(host.address, session.token);
    await first.hello();
    first.socket.send(
      JSON.stringify({
        type: 'subscribe',
        stream_id: conversation.id,
        cursor: httpSnapshot.json().cursor,
      }),
    );
    await first.next((frame) => frame.type === 'subscribed');
    const sent = await send(conversation.id, '在线推送');
    await drain();
    const delivery = await first.next((frame) => frame.payload?.message?.id === sent.id);
    first.socket.send(
      JSON.stringify({ type: 'ack', stream_id: conversation.id, cursor: delivery.cursor }),
    );
    first.socket.send(JSON.stringify({ type: 'ping', nonce: 'ack-barrier' }));
    await first.next((frame) => frame.type === 'pong');
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        tx.selectFrom('read_cursors').selectAll().execute(),
      ),
    ).toEqual([]);
    first.socket.close();
    await once(first.socket, 'close');
    const offline = await send(conversation.id, '离线期间的消息');
    await drain();
    const second = connect(host.address, session.token);
    await second.hello();
    second.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: delivery.cursor }),
    );
    await second.next((frame) => frame.type === 'subscribed');
    const replay = await second.next((frame) => frame.payload?.message?.id === offline.id);
    expect(replay.payload?.message?.body).toBe('离线期间的消息');
  });
  it('notifies revoked subscribers and rejects a cross-origin upgrade', async () => {
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.bob, conversation.id);
    const host = await server();
    const session = await host.identity.devLogin({ principalId: fixture.bob.principalId, origin });
    const client = connect(host.address, session.token);
    await client.hello();
    client.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
    );
    await client.next((frame) => frame.type === 'subscribed');
    await messaging.changeMember(
      fixture.alice,
      conversation.id,
      fixture.bob.principalId,
      'remove',
      conversation.version,
      key(),
    );
    expect(await client.next((frame) => frame.type === 'access_revoked')).toMatchObject({
      stream_id: conversation.id,
      reason: 'authorization_changed',
    });
    const malicious = new WebSocket(
      `${host.address.replace('http:', 'ws:')}/v1/ws?tenant_id=${fixture.tenantId}`,
      { headers: { origin: 'https://evil.test', cookie: `imbox_session=${session.token}` } },
    );
    sockets.push(malicious);
    const status = await new Promise<number>((resolve) => {
      malicious.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode!);
        response.resume();
        malicious.terminate();
      });
      malicious.on('error', () => {});
    });
    expect(status).toBe(403);
  });
  it('rejects an ACK never delivered on this socket without granting read state', async () => {
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.alice, conversation.id);
    const host = await server();
    const session = await host.identity.devLogin({
      principalId: fixture.alice.principalId,
      origin,
    });
    const client = connect(host.address, session.token);
    await client.hello();
    client.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
    );
    await client.next((frame) => frame.type === 'subscribed');
    const closed = once(client.socket, 'close');
    client.socket.send(
      JSON.stringify({ type: 'ack', stream_id: conversation.id, cursor: 'never-delivered-cursor' }),
    );
    expect((await closed)[0]).toBe(1008);
    expect(
      await withTenant(databases.db, fixture.tenantId, (tx) =>
        tx.selectFrom('read_cursors').selectAll().execute(),
      ),
    ).toHaveLength(0);
  });
  it('bounds unacknowledged deliveries and closes slow consumers with a resync signal', async () => {
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.alice, conversation.id);
    const host = await server(1);
    const session = await host.identity.devLogin({
      principalId: fixture.alice.principalId,
      origin,
    });
    const client = connect(host.address, session.token);
    await client.hello();
    client.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
    );
    await client.next((frame) => frame.type === 'subscribed');
    await send(conversation.id, '没有确认的消息');
    await drain();
    await client.next((frame) => frame.type === 'projection.upsert');
    expect(await client.next((frame) => frame.type === 'resync_required')).toMatchObject({
      reason: 'slow_consumer',
    });
  });
});

it('materializes at most 200 recent visible messages at a fixed head and binds snapshot cursors to their window', async () => {
  const chat = await group();
  for (let i = 0; i < 205; i++) await send(chat.id, 'window-message-' + i);
  await drain();
  let page = await sync.snapshot(fixture.bob, chat.id, { window: 'recent', limit: 50 });
  expect(page.window).toBe('recent');
  expect(page.history_truncated).toBe(true);
  expect(page.complete).toBe(false);
  const cursor = page.cursor,
    snapshotId = page.snapshot_id,
    items = [...page.items];
  await expect(
    sync.snapshot(fixture.bob, chat.id, { cursor: page.next_cursor!, limit: 50 }),
  ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  const newer = await send(chat.id, 'after-recent-head');
  await drain();
  while (!page.complete) {
    page = await sync.snapshot(fixture.bob, chat.id, {
      window: 'recent',
      cursor: page.next_cursor!,
      limit: 50,
    });
    expect(page.snapshot_id).toBe(snapshotId);
    expect(page.cursor).toBe(cursor);
    items.push(...page.items);
  }
  const messageItems = items.filter((item) => item.entity.type === 'message');
  expect(messageItems).toHaveLength(200);
  expect(messageItems[0]!.payload.message!.body).toBe('window-message-5');
  expect(messageItems.at(-1)!.payload.message!.body).toBe('window-message-204');
  const next = await sync.events(fixture.bob, chat.id, { cursor, limit: 100 });
  expect(next.items.some((item) => item.entity.id === newer.id)).toBe(true);
  const count = await withTenant(
    databases.db,
    fixture.tenantId,
    async (tx) =>
      (
        await sql<{
          n: string;
        }>`select count(*)::text n from sync_snapshot_items where snapshot_id=${snapshotId}`.execute(
          tx,
        )
      ).rows[0]!.n,
  );
  expect(Number(count)).toBeLessThanOrEqual(201);
});
