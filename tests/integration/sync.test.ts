import { randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModelDriver, createOllamaAdapter } from '@imbox/model-runtime';
import { createResourceService, createS3ObjectStore } from '@imbox/resources';
import { modelFixture } from '../helpers/model.js';
import { registerMessagingRoutes } from '../../apps/api/src/messaging-routes.js';
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
const workerProcesses: ChildProcess[] = [];
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
  for (const child of workerProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
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
async function server(maxPendingAcks = 256, includeMessaging = false) {
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
    if (includeMessaging) await registerMessagingRoutes(scope, { identity, messaging });
    await registerSyncRoutes(scope, { identity, sync, pollIntervalMs: 20, maxPendingAcks });
  });
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, address, identity };
}
/** Fork the real worker entrypoint as an independent OS process bound to this test tenant. */
function forkWorkerProcess(leaseSeconds: number) {
  const appUrl = process.env.TEST_APP_DATABASE_URL;
  const identityUrl = process.env.TEST_IDENTITY_DATABASE_URL;
  if (!appUrl || !identityUrl)
    throw new Error('TEST_APP_DATABASE_URL and TEST_IDENTITY_DATABASE_URL are required');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../../apps/worker/src/main.ts', import.meta.url))],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: appUrl,
        IDENTITY_DATABASE_URL: identityUrl,
        WORKER_TENANT_IDS: fixture.tenantId,
        WORKER_POLL_INTERVAL_MS: '20',
        WORKER_LEASE_SECONDS: String(leaseSeconds),
        ENABLE_LOCAL_MODEL: 'false',
      },
    },
  );
  workerProcesses.push(child);
  const diagnostics: string[] = [];
  let announceReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    announceReady = resolve;
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        if (diagnostics.length < 200) diagnostics.push(line);
        if (line.includes('"worker_ready"')) announceReady?.();
      }
    });
  }
  const exit = once(child, 'exit');
  const startupFailure = exit.then(([code, signal]) => {
    throw new Error(
      `Worker process exited early (code ${code}, signal ${signal}): ${diagnostics.slice(-20).join(' | ')}`,
    );
  });
  return {
    child,
    ready: Promise.race([ready, startupFailure]),
    exit,
    diagnostics,
  };
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
  let closed = false;
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
    closed = true;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Socket closed before expected frame'));
    }
  });
  function next(predicate: (frame: Frame) => boolean, label = 'frame') {
    const index = inbox.findIndex(predicate);
    if (index !== -1) return Promise.resolve(inbox.splice(index, 1)[0]!);
    if (closed) return Promise.reject(new Error(`Socket closed before expected ${label}`));
    return new Promise<Frame>((resolve, reject) => {
      const entry = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i !== -1) waiters.splice(i, 1);
          reject(
            new Error(
              `Expected websocket ${label} timed out; queued frame types: ${inbox.map((frame) => frame.type).join(',')}`,
            ),
          );
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
  it('skips delivery queries only at an authenticated current head and still rejects revoked members', async () => {
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.bob, conversation.id);
    let deliveryQueries = 0;
    const observed = createSyncService({
      db: databases.db.withPlugin({
        transformQuery(args) {
          if (JSON.stringify(args.node).includes('projection_deliveries')) deliveryQueries++;
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      }),
      cursorSecret: secret,
    });
    const empty = await observed.events(fixture.bob, conversation.id, { cursor: baseline.cursor });
    expect(empty).toMatchObject({ items: [], cursor: baseline.cursor, has_more: false });
    expect(deliveryQueries).toBe(0);
    await send(conversation.id, 'New head requires an actual delivery read');
    await drain();
    const changed = await observed.events(fixture.bob, conversation.id, {
      cursor: baseline.cursor,
    });
    expect(
      changed.items.some(
        (item) => item.payload.message?.body === 'New head requires an actual delivery read',
      ),
    ).toBe(true);
    expect(deliveryQueries).toBe(1);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update conversation_members set status='removed',version=version+1 where conversation_id=${conversation.id} and principal_id=${fixture.bob.principalId}`.execute(
        tx,
      ),
    );
    await expect(
      observed.events(fixture.bob, conversation.id, { cursor: changed.cursor }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deliveryQueries).toBe(1);
  });
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
  it('preserves HTTP messages through simultaneous model, object upload, socket and projector outages', async () => {
    const modelContext = await modelFixture(databases);
    fixture = modelContext;
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.bob, conversation.id);
    const host = await server(256, true);
    const alice = await host.identity.devLogin({ principalId: fixture.alice.principalId, origin });
    const bob = await host.identity.devLogin({ principalId: fixture.bob.principalId, origin });
    const first = connect(host.address, bob.token);
    await first.hello();
    first.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
    );
    await first.next((frame) => frame.type === 'subscribed', 'initial subscription');
    first.socket.terminate();
    await once(first.socket, 'close');

    let blocked = true;
    let objectFailures = 0;
    const s3Target = new URL(process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:18333');
    const objectProxy = createServer((request, response) => {
      if (blocked) {
        objectFailures++;
        request.resume();
        response.writeHead(503).end('Injected object transport outage');
        return;
      }
      // Preserve the signed Host header while forwarding to the real isolated S3 service.
      const upstream = httpRequest(
        new URL(request.url!, s3Target),
        {
          method: request.method,
          headers: request.headers,
        },
        (reply) => {
          response.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on('error', () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
    });
    let modelRequests = 0;
    let heldResponse: ServerResponse | undefined;
    let observed!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const digest = 'sha256:' + 'a'.repeat(64);
    const modelServer = createServer((request, response) => {
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'qwen3:0.6b', digest }] }));
        return;
      }
      request.resume();
      request.on('end', () => {
        modelRequests++;
        heldResponse = response;
        observed();
      });
    });
    let store: ReturnType<typeof createS3ObjectStore> | undefined;
    let execution: Promise<unknown> | undefined;
    try {
      objectProxy.listen(0, '127.0.0.1');
      modelServer.listen(0, '127.0.0.1');
      await Promise.all([once(objectProxy, 'listening'), once(modelServer, 'listening')]);
      store = createS3ObjectStore({
        endpoint: `http://127.0.0.1:${(objectProxy.address() as AddressInfo).port}`,
        region: 'us-east-1',
        bucket: 'imbox-resources-test',
        accessKeyId: 'imbox_local_s3_app',
        secretAccessKey: 'imbox_local_s3_app_secret',
      });
      const resources = createResourceService({ db: databases.db, store, cursorSecret: secret });
      const bytes = Buffer.from('Resource survives isolated transport recovery');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const upload = await resources.createUpload(
        fixture.alice,
        {
          conversation_id: conversation.id,
          filename: 'joint-fault.txt',
          content_type: 'text/plain',
          byte_size: bytes.length,
          sha256,
        },
        key(),
      );
      const adapter = createOllamaAdapter({
        origin: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`,
        model: 'qwen3:0.6b',
        digest,
        allowLoopbackHttp: true,
        timeoutMs: 20000,
      });
      const driver = createModelDriver({
        worker: modelContext.worker,
        models: new Map([['local', adapter]]),
        heartbeatMs: 25,
      });
      const run = await modelContext.createRun();
      execution = driver.execute(fixture.tenantId, run.id);
      await Promise.race([
        generationStarted,
        execution.then(() => {
          throw new Error('Model ended before generation barrier');
        }),
      ]);
      const failedUpload = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: upload.upload_headers,
        body: bytes,
      });
      expect(failedUpload.status).toBe(503);
      await failedUpload.arrayBuffer();
      const saved: Array<{ id: string; body: string }> = [];
      const post = async (body: string, command: string, clientId: string) => {
        const reply = await fetch(`${host.address}/v1/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: {
            origin,
            cookie: `imbox_session=${alice.token}`,
            'x-csrf-token': alice.csrfToken,
            'x-imbox-tenant-id': fixture.tenantId,
            'idempotency-key': command,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ client_message_id: clientId, body }),
        });
        expect(reply.status).toBe(201);
        return (await reply.json()) as { id: string; body: string };
      };
      // The projection worker remains stopped throughout the fault interval.
      for (let index = 0; index < 60; index++) {
        const command = key(),
          clientId = key(),
          body = `joint-fault-message-${index}`;
        const message = await post(body, command, clientId);
        saved.push(message);
        if (index % 10 === 0) expect((await post(body, command, clientId)).id).toBe(message.id);
      }
      expect(objectFailures).toBe(1);
      expect(modelRequests).toBe(1);
      expect(
        (await sync.events(fixture.bob, conversation.id, { cursor: baseline.cursor })).items,
      ).toHaveLength(0);
      const pending = await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql<{
          count: string;
        }>`select count(*)::text as count from outbox where status='pending'`.execute(tx),
      );
      expect(Number(pending.rows[0]!.count)).toBeGreaterThanOrEqual(60);
      heldResponse!.destroy();
      expect(await execution).toBe('waiting');
      expect(await modelContext.runtime.getRun(fixture.alice, run.id)).toMatchObject({
        status: 'waiting_dependency',
        output: null,
      });
      const reservations = await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select status from runtime_reservations where run_id=${run.id}`.execute(tx),
      );
      expect(reservations.rows).toEqual([{ status: 'unknown' }]);
      await driver.execute(fixture.tenantId, run.id);
      expect(modelRequests).toBe(1);

      blocked = false;
      const uploaded = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: upload.upload_headers,
        body: bytes,
      });
      expect(uploaded.status).toBe(200);
      await uploaded.arrayBuffer();
      const resource = await resources.completeUpload(fixture.alice, upload.id, key());
      expect(resource.sha256).toBe(sha256);
      worker = createOutboxProcessor({ db: databases.db });
      await drain();
      const second = connect(host.address, bob.token);
      const delivered: string[] = [];
      second.socket.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as { payload?: { message?: { id: string } } };
        if (frame.payload?.message?.id) delivered.push(frame.payload.message.id);
      });
      await second.hello();
      second.socket.send(
        JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
      );
      await second.next((frame) => frame.type === 'subscribed', 'recovered subscription');
      for (const message of saved) {
        const delivery = await second.next(
          (frame) => frame.payload?.message?.id === message.id,
          `replayed message ${saved.indexOf(message)}`,
        );
        expect(delivery.payload?.message?.body).toBe(message.body);
        second.socket.send(
          JSON.stringify({ type: 'ack', stream_id: conversation.id, cursor: delivery.cursor }),
        );
      }
      const live = await post('after-joint-recovery', key(), key());
      await drain();
      await second.next((frame) => frame.payload?.message?.id === live.id, 'live message');
      second.socket.send(JSON.stringify({ type: 'ping', nonce: 'recovery-barrier' }));
      await second.next((frame) => frame.type === 'pong', 'recovery barrier');
      expect(delivered).toHaveLength(61);
      expect(new Set(delivered)).toEqual(new Set([...saved.map((message) => message.id), live.id]));
      const rows = await withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`select id from messages where conversation_id=${conversation.id}`.execute(tx),
      );
      expect(rows.rows).toHaveLength(61);
      expect(modelRequests).toBe(1);
    } finally {
      heldResponse?.destroy();
      modelServer.closeAllConnections();
      objectProxy.closeAllConnections();
      await Promise.all([
        new Promise<void>((done) => modelServer.close(() => done())),
        new Promise<void>((done) => objectProxy.close(() => done())),
      ]);
      await execution?.catch(() => {});
      store?.destroy();
    }
  }, 60000);

  it('recovers outbox stranded by a killed independent worker process through lease expiry without loss or duplication', async () => {
    const conversation = await group();
    await drain();
    const baseline = await sync.snapshot(fixture.bob, conversation.id);
    const host = await server(256, true);
    const alice = await host.identity.devLogin({ principalId: fixture.alice.principalId, origin });
    const bob = await host.identity.devLogin({ principalId: fixture.bob.principalId, origin });
    const saved: Array<{ id: string; body: string }> = [];
    const post = async (body: string, command: string, clientId: string) => {
      const reply = await fetch(`${host.address}/v1/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: {
          origin,
          cookie: `imbox_session=${alice.token}`,
          'x-csrf-token': alice.csrfToken,
          'x-imbox-tenant-id': fixture.tenantId,
          'idempotency-key': command,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ client_message_id: clientId, body }),
      });
      expect(reply.status).toBe(201);
      return (await reply.json()) as { id: string; body: string };
    };
    // No projector of any kind runs while the backlog accumulates.
    for (let index = 0; index < 40; index++) {
      saved.push(await post(`worker-crash-message-${index}`, key(), key()));
    }
    const pendingBefore = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        count: string;
      }>`select count(*)::text as count from outbox where status='pending'`.execute(tx),
    );
    expect(Number(pendingBefore.rows[0]!.count)).toBeGreaterThanOrEqual(40);
    expect(
      (await sync.events(fixture.bob, conversation.id, { cursor: baseline.cursor })).items,
    ).toHaveLength(0);

    // Hold the conversation row lock the projector takes, so the real worker leases the
    // whole backlog and then blocks inside its first projection transaction.
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holdConversationLock = withTenant(databases.db, fixture.tenantId, async (tx) => {
      await tx
        .selectFrom('conversations')
        .select('id')
        .where('id', '=', conversation.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      signalLocked();
      await gate;
    });
    await locked;

    const crashed = forkWorkerProcess(12);
    await crashed.ready;
    await expect
      .poll(
        async () =>
          Number(
            (
              await withTenant(databases.db, fixture.tenantId, (tx) =>
                sql<{
                  count: string;
                }>`select count(*)::text as count from outbox where status='leased'`.execute(tx),
              )
            ).rows[0]!.count,
          ),
        { timeout: 30000, interval: 100 },
      )
      .toBe(40);

    // Hard-kill the independent process mid-projection: no failure handler runs.
    const crashedExit = once(crashed.child, 'exit');
    expect(crashed.child.kill('SIGKILL')).toBe(true);
    const [crashedCode, crashedSignal] = (await crashedExit) as [
      number | null,
      NodeJS.Signals | null,
    ];
    expect(crashedCode).toBeNull();
    expect(crashedSignal).toBe('SIGKILL');
    releaseLock();
    await holdConversationLock;

    // Stranded leases stay leased with a live lease, no dead letters and no projector receipts.
    // Receipts are shared across consumers, so scope to the conversation projector; the
    // independent notification loop may legitimately consume message events meanwhile.
    const stranded = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        leased: string;
        holders: string;
        live: boolean;
        dead: string;
        receipts: string;
      }>`select count(distinct o.id) filter (where o.status='leased')::text as leased,
                count(distinct o.lease_holder) filter (where o.status='leased')::text as holders,
                bool_and(o.lease_expires_at > clock_timestamp()) filter (where o.status='leased') as live,
                count(distinct o.id) filter (where o.status='dead')::text as dead,
                count(distinct cr.event_id)::text as receipts
         from outbox o
         join domain_events e on e.id = o.event_id
         left join consumer_receipts cr on cr.event_id = o.event_id and cr.consumer = 'conversation-projector:v1'
         where e.aggregate_type = 'message'`.execute(tx),
    );
    expect(stranded.rows[0]).toMatchObject({
      leased: '40',
      holders: '1',
      live: true,
      dead: '0',
      receipts: '0',
    });
    expect(
      (await sync.events(fixture.bob, conversation.id, { cursor: baseline.cursor })).items,
    ).toHaveLength(0);

    // A fresh independent worker cannot touch the stranded rows before lease expiry and
    // then reclaims them exactly once afterwards.
    const replacement = forkWorkerProcess(12);
    await replacement.ready;
    await expect
      .poll(
        async () =>
          Number(
            (
              await withTenant(databases.db, fixture.tenantId, (tx) =>
                sql<{
                  count: string;
                }>`select count(*)::text as count from outbox where status in ('pending','leased','dead')`.execute(
                  tx,
                ),
              )
            ).rows[0]!.count,
          ),
        { timeout: 45000, interval: 200 },
      )
      .toBe(0);
    const recovered = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        status: string;
        attempts: string;
        receipts: string;
      }>`select o.status, o.attempts::text as attempts,
                (select count(*)::text from consumer_receipts cr where cr.event_id = o.event_id and cr.consumer = 'conversation-projector:v1') as receipts
         from outbox o join domain_events e on e.id = o.event_id
         where e.aggregate_type = 'message'`.execute(tx),
    );
    expect(recovered.rows).toHaveLength(40);
    for (const row of recovered.rows) {
      expect(row).toMatchObject({ status: 'completed', attempts: '2', receipts: '1' });
    }

    // The receiver resumes from its original cursor and gets every message exactly once.
    const client = connect(host.address, bob.token);
    const delivered: string[] = [];
    client.socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { payload?: { message?: { id: string } } };
      if (frame.payload?.message?.id) delivered.push(frame.payload.message.id);
    });
    await client.hello();
    client.socket.send(
      JSON.stringify({ type: 'subscribe', stream_id: conversation.id, cursor: baseline.cursor }),
    );
    await client.next((frame) => frame.type === 'subscribed', 'recovered subscription');
    for (const message of saved) {
      const delivery = await client.next(
        (frame) => frame.payload?.message?.id === message.id,
        `replayed message ${saved.indexOf(message)}`,
      );
      expect(delivery.payload?.message?.body).toBe(message.body);
      client.socket.send(
        JSON.stringify({ type: 'ack', stream_id: conversation.id, cursor: delivery.cursor }),
      );
    }
    const live = await post('after-worker-crash-recovery', key(), key());
    await client.next((frame) => frame.payload?.message?.id === live.id, 'live message');
    client.socket.send(JSON.stringify({ type: 'ping', nonce: 'worker-crash-barrier' }));
    await client.next((frame) => frame.type === 'pong', 'recovery barrier');
    expect(delivered).toHaveLength(41);
    expect(new Set(delivered)).toEqual(new Set([...saved.map((message) => message.id), live.id]));
    const stored = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        count: string;
      }>`select count(*)::text as count from messages where conversation_id=${conversation.id}`.execute(
        tx,
      ),
    );
    expect(Number(stored.rows[0]!.count)).toBe(41);

    // The replacement worker still shuts down gracefully through its normal stop path.
    const replacementExit = once(replacement.child, 'exit');
    expect(replacement.child.kill('SIGTERM')).toBe(true);
    const [replacementCode] = (await replacementExit) as [number | null, unknown];
    expect(replacementCode).toBe(0);
  }, 90000);

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
  it('rejects an ACK pipelined with hello before any subscription or delivery', async () => {
    const host = await server();
    const session = await host.identity.devLogin({
      principalId: fixture.alice.principalId,
      origin,
    });
    const client = connect(host.address, session.token);
    await once(client.socket, 'open');
    const closed = once(client.socket, 'close');
    client.socket.send(JSON.stringify({ type: 'hello', protocol_version: 1, client_id: key() }));
    client.socket.send(JSON.stringify({ type: 'ack', stream_id: key(), cursor: 'not-delivered' }));
    expect((await closed)[0]).toBe(1008);
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
