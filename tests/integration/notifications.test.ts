import { randomUUID, randomBytes, createECDH } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createNotificationService,
  createNotificationDispatcher,
  type NotificationService,
  type PushConfiguration,
  type PushTransport,
} from '@imbox/notifications';
import {
  createMessagingService,
  createTaskService,
  appendEvent,
  type MessagingService,
  type TaskService,
} from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
const secret = 'notification-real-database-secret-at-least-thirty-two-bytes';
let db: Awaited<ReturnType<typeof testDatabases>>;
let f: Awaited<ReturnType<typeof tenantFixture>>;
let notifications: NotificationService;
let dispatch: ReturnType<typeof createNotificationDispatcher>;
let messaging: MessagingService;
let tasks: TaskService;
const key = () => randomUUID();
const sessionActive = async (principalId: string, sessionId: string) =>
  !!(await db.identityDb
    .selectFrom('sessions')
    .innerJoin('principals', 'principals.id', 'sessions.principal_id')
    .select('sessions.id')
    .where('sessions.id', '=', sessionId)
    .where('principal_id', '=', principalId)
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.expires_at', '>', sql<Date>`clock_timestamp()`)
    .where('principals.status', '=', 'active')
    .executeTakeFirst());
beforeAll(async () => {
  db = await testDatabases();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  f = await tenantFixture(db.owner);
  notifications = createNotificationService({ db: db.db, cursorSecret: secret, sessionActive });
  dispatch = createNotificationDispatcher({ db: db.db });
  messaging = createMessagingService(db.db, secret);
  tasks = createTaskService(db.db, secret);
});
const conversation = (all = false) =>
  messaging.createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: 'Never copy this private title',
      member_ids: all ? [f.bob.principalId, f.charlie.principalId] : [f.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
const send = (id: string, body = 'Never disclose this secret notification body') =>
  messaging.createMessage(f.alice, id, { body, client_message_id: key() }, key());
const task = () =>
  tasks.createTask(
    f.alice,
    {
      workspace_id: f.workspaceId,
      title: 'Confidential task title',
      goal: 'Private task goal',
      acceptance_criteria: ['A verified result'],
      reviewer_principal_ids: [f.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    key(),
  );
async function login(actor = f.bob) {
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    publicOrigin: 'http://notifications.test',
    sessionSecret: secret,
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: [actor.principalId],
  });
  const session = await identity.devLogin({
    principalId: actor.principalId,
    origin: 'http://notifications.test',
  });
  const auth = await identity.authenticate({ cookie: session.token, tenantId: f.tenantId });
  return { identity, session, auth };
}
async function block(id: string) {
  await withTenant(db.db, f.tenantId, async (tx) => {
    await sql`update tasks set status='blocked',version=version+1 where id=${id}`.execute(tx);
    await appendEvent(tx, f.alice, {
      aggregateType: 'task',
      aggregateId: id,
      version: '2',
      type: 'task.blocked',
      payload: {},
      target: `task:${id}`,
    });
  });
}
describe('durable authorization-aware notification intents', () => {
  it('reports a full partial-fanout batch until every current recipient is handled exactly once', async () => {
    const c = await conversation(true);
    await dispatch(f.tenantId);
    await send(c.id);
    const first = await dispatch(f.tenantId, { limit: 1, fanoutLimit: 1 });
    expect(first).toMatchObject({ processed: 1, completed: 0, recipients: 1, batch_full: true });
    const second = await dispatch(f.tenantId, { limit: 1, fanoutLimit: 1 });
    expect(second).toMatchObject({ processed: 1, completed: 1, recipients: 1, batch_full: true });
    const empty = await dispatch(f.tenantId, { limit: 1, fanoutLimit: 1 });
    expect(empty).toMatchObject({ processed: 0, completed: 0, recipients: 0, batch_full: false });
    await withTenant(db.db, f.tenantId, async (tx) => {
      const rows = (
        await sql<{
          recipient_id: string;
        }>`select recipient_id from notification_intents where source_kind='message' order by recipient_id`.execute(
          tx,
        )
      ).rows;
      expect(rows.map((r) => r.recipient_id)).toEqual(
        [f.bob.principalId, f.charlie.principalId].sort(),
      );
    });
  });
  it('coalesces conversation notifications, tolerates duplicates and late older work without taking projector outbox rows', async () => {
    const c = await conversation();
    const first = await send(c.id);
    const second = await send(c.id);
    await Promise.all([dispatch(f.tenantId), dispatch(f.tenantId)]);
    const inbox = await notifications.list(f.bob);
    expect(inbox.items).toHaveLength(1);
    const notification = inbox.items[0]!;
    expect((await notifications.open(f.bob, notification.id)).target.id).toBe(second.id);
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 1 });
    const old = (
      await withTenant(db.db, f.tenantId, (tx) =>
        sql<{ id: string }>`select id from domain_events where aggregate_id=${first.id}`.execute(
          tx,
        ),
      )
    ).rows[0]!;
    await withTenant(db.db, f.tenantId, (tx) =>
      sql`update notification_event_queue set status='pending',after_recipient=null where event_id=${old.id}`.execute(
        tx,
      ),
    );
    await dispatch(f.tenantId);
    expect((await notifications.list(f.bob)).items[0]!.version).toBe(notification.version);
    await withTenant(db.db, f.tenantId, async (tx) => {
      const durable = JSON.stringify(
        (await sql`select * from notification_intents`.execute(tx)).rows,
      );
      expect(durable).not.toContain('secret notification body');
      expect(durable).not.toContain('private title');
      expect(
        (
          await sql`select * from outbox where target like 'conversation:%' and status='pending'`.execute(
            tx,
          )
        ).rows.length,
      ).toBeGreaterThan(0);
      expect(
        (
          await sql`select * from consumer_receipts where consumer='conversation-projector:v1'`.execute(
            tx,
          )
        ).rows,
      ).toEqual([]);
    });
    await notifications.markRead(f.bob, notification.id, notification.version);
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 0 });
    await send(c.id);
    await dispatch(f.tenantId);
    await expect(
      notifications.markRead(f.bob, notification.id, notification.version),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 1 });
  });
  it('closes non-conversation outbox with explicit invalidation receipts, and read never resolves a Task blocker', async () => {
    const t = await task();
    await block(t.id);
    const opaqueId = key();
    await withTenant(db.db, f.tenantId, (tx) =>
      appendEvent(tx, f.alice, {
        aggregateType: 'memory',
        aggregateId: opaqueId,
        version: '1',
        type: 'memory.deleted',
        payload: {},
        target: `memory:${opaqueId}`,
      }),
    );
    await dispatch(f.tenantId);
    const inbox = await notifications.list(f.alice);
    expect(inbox.items).toHaveLength(1);
    await notifications.markRead(f.alice, inbox.items[0]!.id, inbox.items[0]!.version);
    expect((await tasks.getTask(f.alice, t.id)).status).toBe('blocked');
    expect((await notifications.list(f.bob)).items).toEqual([]);
    await withTenant(db.db, f.tenantId, async (tx) => {
      expect(
        (
          await sql`select * from outbox where target not like 'conversation:%' and status<>'completed'`.execute(
            tx,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql`select * from consumer_receipts where consumer='notification-invalidation:v1'`.execute(
            tx,
          )
        ).rows,
      ).toHaveLength(3);
      await sql`update tasks set status='active',version=version+1 where id=${t.id}`.execute(tx);
    });
    expect((await notifications.list(f.alice)).items).toEqual([]);
  });
  it('checks workspace and conversation ACL before paging, unread counts and opening, including removal and re-add', async () => {
    const c = await conversation();
    await send(c.id);
    await dispatch(f.tenantId);
    const row = (await notifications.list(f.bob)).items[0]!;
    await withTenant(db.owner, f.tenantId, (tx) =>
      sql`update memberships set status='disabled',version=version+1 where workspace_id=${f.workspaceId} and principal_id=${f.bob.principalId}`.execute(
        tx,
      ),
    );
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 0 });
    expect((await notifications.list(f.bob)).items).toEqual([]);
    await expect(notifications.open(f.bob, row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenant(db.owner, f.tenantId, (tx) =>
      sql`update memberships set status='active',version=version+1 where workspace_id=${f.workspaceId} and principal_id=${f.bob.principalId}`.execute(
        tx,
      ),
    );
    expect((await notifications.list(f.bob)).items).toEqual([]);
    const m = await send(c.id);
    await dispatch(f.tenantId);
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 1 });
    await messaging.changeMessage(f.alice, m.id, null, m.version, key());
    expect(await notifications.unread(f.bob)).toEqual({ unread_count: 0 });
    const other = await tenantFixture(db.owner);
    await expect(notifications.open(other.bob, row.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('does not lose an earlier-started event that commits after a newer event was dispatched', async () => {
    const one = await task(),
      two = await task();
    await dispatch(f.tenantId);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (ready = r));
    const late = withTenant(db.db, f.tenantId, async (tx) => {
      await sql`update tasks set status='blocked',version=2 where id=${one.id}`.execute(tx);
      await appendEvent(tx, f.alice, {
        aggregateType: 'task',
        aggregateId: one.id,
        version: '2',
        type: 'task.blocked',
        payload: {},
        target: `task:${one.id}`,
      });
      ready();
      await gate;
    });
    await entered;
    try {
      await block(two.id);
      await dispatch(f.tenantId);
      expect((await notifications.list(f.alice)).items).toHaveLength(1);
    } finally {
      release();
      await late;
    }
    await dispatch(f.tenantId);
    expect((await notifications.list(f.alice)).items).toHaveLength(2);
  });
  it('fans out large audiences in bounded resumable pages and receipts make retries harmless', async () => {
    const c = await conversation(true);
    await dispatch(f.tenantId);
    await send(c.id);
    const first = await dispatch(f.tenantId, { limit: 1, fanoutLimit: 1 });
    expect(first.recipients).toBe(1);
    expect(first.completed).toBe(0);
    const next = await dispatch(f.tenantId, { limit: 1, fanoutLimit: 1 });
    expect(next.recipients).toBe(1);
    expect(next.completed).toBe(1);
    expect((await notifications.list(f.bob)).items).toHaveLength(1);
    expect((await notifications.list(f.charlie)).items).toHaveLength(1);
    expect((await dispatch(f.tenantId)).recipients).toBe(0);
  });
  it('backfills old audit facts without generating stale reminders and still closes their non-conversation outbox', async () => {
    const t = await task();
    await block(t.id);
    await withTenant(db.db, f.tenantId, async (tx) => {
      await sql`delete from notification_event_queue`.execute(tx);
      await sql`update domain_events set created_at=clock_timestamp()-interval '2 days'`.execute(
        tx,
      );
    });
    const result = await dispatch(f.tenantId);
    expect(result.backfilled).toBe(2);
    expect(result.outbox_completed).toBe(2);
    expect((await notifications.list(f.alice)).items).toEqual([]);
  });
  it('keeps unread during DND, mute and category suppression, with per-device gating and sensitive-free payloads', async () => {
    const c = await conversation();
    await send(c.id);
    await dispatch(f.tenantId);
    const { auth } = await login();
    const d = await notifications.setDevice(auth, true);
    let p = await notifications.getPreferences(auth);
    p = await notifications.setPreferences(
      auth,
      {
        categories: p.categories,
        dnd: { enabled: true, time_zone: 'America/New_York', start: '00:00', end: '00:00' },
      },
      p.version,
    );
    expect(await notifications.prepareDelivery(f.tenantId, d.id)).toBeNull();
    expect(await notifications.unread(auth)).toEqual({ unread_count: 1 });
    p = await notifications.setPreferences(
      auth,
      { categories: p.categories, dnd: { ...p.dnd, enabled: false } },
      p.version,
    );
    await notifications.mute(auth, c.id, true);
    expect((await notifications.list(auth)).items[0]!.silent).toBe(true);
    expect(await notifications.prepareDelivery(f.tenantId, d.id)).toBeNull();
    await notifications.mute(auth, c.id, false);
    p = await notifications.setPreferences(
      auth,
      { categories: { ...p.categories, message: false }, dnd: p.dnd },
      p.version,
    );
    expect(await notifications.prepareDelivery(f.tenantId, d.id)).toBeNull();
    await notifications.setPreferences(
      auth,
      { categories: { ...p.categories, message: true }, dnd: p.dnd },
      p.version,
    );
    await notifications.setDevice(auth, false);
    expect(await notifications.prepareDelivery(f.tenantId, d.id)).toBeNull();
    await notifications.setDevice(auth, true);
    const delivery = await notifications.prepareDelivery(f.tenantId, d.id);
    expect(delivery).not.toBeNull();
    expect(Object.keys(delivery!.payload).sort()).toEqual(['body', 'locator', 'title', 'version']);
    expect(JSON.stringify(delivery)).not.toContain('secret notification body');
    expect(
      await notifications.revalidateDelivery(
        f.tenantId,
        delivery!.delivery_id,
        delivery!.lease_token,
      ),
    ).toBe(true);
    await notifications.settleDelivery(
      f.tenantId,
      delivery!.delivery_id,
      delivery!.lease_token,
      'sent',
    );
    expect(await notifications.prepareDelivery(f.tenantId, d.id)).toBeNull();
    expect(await notifications.unread(auth)).toEqual({ unread_count: 1 });
  });
  it('rechecks ACL and revoked sessions before transport, cleans only that device binding, and denies other users device mutation', async () => {
    const c = await conversation();
    await send(c.id);
    await dispatch(f.tenantId);
    const one = await login(),
      two = await login();
    const d1 = await notifications.setDevice(one.auth, true),
      d2 = await notifications.setDevice(two.auth, true);
    await expect(notifications.disableDevice(f.alice, d1.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const pending = await notifications.prepareDelivery(f.tenantId, d1.id);
    await notifications.mute(one.auth, c.id, true);
    expect(
      await notifications.revalidateDelivery(
        f.tenantId,
        pending!.delivery_id,
        pending!.lease_token,
      ),
    ).toBe(false);
    await notifications.mute(one.auth, c.id, false);
    await one.identity.revokeSession(one.auth, one.auth.sessionId);
    expect(
      await notifications.revalidateDelivery(
        f.tenantId,
        pending!.delivery_id,
        pending!.lease_token,
      ),
    ).toBe(false);
    expect((await notifications.devices(two.auth)).items.find((d) => d.id === d1.id)?.enabled).toBe(
      false,
    );
    expect(await notifications.prepareDelivery(f.tenantId, d2.id)).not.toBeNull();
    await two.identity.revokeSession(two.auth, two.auth.sessionId);
    expect((await notifications.cleanupDevices(f.tenantId)).disabled).toBe(1);
  });
  it('binds cursors to the caller and enforces real HTTP session/CSRF with opaque click resolution', async () => {
    const c = await conversation();
    await send(c.id);
    const c2 = await conversation();
    await send(c2.id);
    await dispatch(f.tenantId);
    const first = await notifications.list(f.bob, { limit: 1 });
    expect(first.next_cursor).toBeDefined();
    await expect(notifications.list(f.alice, { cursor: first.next_cursor! })).rejects.toMatchObject(
      { code: 'RESYNC_REQUIRED' },
    );
    const { identity, session } = await login();
    const app = createApp({ readiness: async () => {}, identity, notifications });
    await app.ready();
    try {
      const headers = { cookie: `imbox_session=${session.token}`, 'x-imbox-tenant-id': f.tenantId };
      const list = await app.inject({ method: 'GET', url: '/v1/notifications', headers });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.body).not.toContain(c.id);
      const row = first.items[0]!;
      const bad = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${row.id}/read`,
        headers: { ...headers, 'if-match': `"${row.version}"` },
      });
      expect(bad.statusCode).toBe(403);
      const read = await app.inject({
        method: 'POST',
        url: `/v1/notifications/${row.id}/read`,
        headers: {
          ...headers,
          'if-match': `"${row.version}"`,
          origin: 'http://notifications.test',
          'x-csrf-token': session.csrfToken,
        },
      });
      expect(read.statusCode, read.body).toBe(200);
      const open = await app.inject({
        method: 'GET',
        url: `/v1/notifications/${row.id}/open`,
        headers,
      });
      expect(open.statusCode, open.body).toBe(200);
      expect(open.json().target.type).toBe('message');
      expect(
        (await app.inject({ method: 'GET', url: '/v1/notifications/unread' })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});

function pushFixture() {
  const server = createECDH('prime256v1');
  server.generateKeys();
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  const config: PushConfiguration = {
    encryptionKey: randomBytes(32).toString('base64url'),
    publicKey: server.getPublicKey().toString('base64url'),
    privateKey: Buffer.concat([
      Buffer.alloc(32 - server.getPrivateKey().length),
      server.getPrivateKey(),
    ]).toString('base64url'),
    subject: 'mailto:ops@example.com',
    hosts: ['fcm.googleapis.com'],
  };
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/push/private-subscription-fixture',
    keys: {
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
  return { config, subscription };
}
describe('encrypted Web Push subscription and bounded durable delivery', () => {
  it('encrypts the endpoint and keys, replaces the session binding, and removes ciphertext when disabled', async () => {
    const { config, subscription } = pushFixture();
    const service = createNotificationService({
      db: db.db,
      cursorSecret: secret,
      sessionActive,
      push: config,
    });
    const first = await login(),
      next = await login();
    const device = await service.subscribe(first.auth, subscription);
    const stored = (
      await sql<{
        subscription_ciphertext: string;
      }>`select subscription_ciphertext from notification_devices where id=${device.id}`.execute(
        db.owner,
      )
    ).rows[0]!;
    expect(stored.subscription_ciphertext).not.toContain(subscription.endpoint);
    expect(stored.subscription_ciphertext).not.toContain(subscription.keys.auth);
    expect(Object.keys(device).sort()).toEqual(['enabled', 'id', 'version']);
    const replacement = await service.subscribe(next.auth, subscription);
    expect(replacement.id).not.toBe(device.id);
    expect((await service.devices(first.auth)).items.find((d) => d.id === device.id)?.enabled).toBe(
      false,
    );
    await service.disableDevice(next.auth, replacement.id);
    const rows = (
      await sql<{
        subscription_ciphertext: string | null;
      }>`select subscription_ciphertext from notification_devices where id in (${device.id},${replacement.id})`.execute(
        db.owner,
      )
    ).rows;
    expect(rows.every((row) => row.subscription_ciphertext === null)).toBe(true);
  });
  it('caps retries across worker restarts and removes expired subscriptions on 410 outcomes', async () => {
    const { config, subscription } = pushFixture(),
      { auth } = await login();
    let calls = 0,
      invalid = false;
    const transport: PushTransport = async (actual, payload, _topic, current) => {
      expect(await current()).toBe(true);
      expect(actual).toEqual(subscription);
      expect(JSON.parse(payload)).toMatchObject({ title: 'Imbox', body: '你有新的待查看事项' });
      expect(payload).not.toContain('secret notification body');
      calls += 1;
      return invalid ? 'subscription_invalid' : 'retry';
    };
    const service = () =>
      createNotificationService({
        db: db.db,
        cursorSecret: secret,
        sessionActive,
        push: config,
        pushTransport: transport,
      });
    const device = await service().subscribe(auth, subscription),
      c = await conversation();
    await send(c.id);
    await dispatch(f.tenantId);
    for (let attempt = 0; attempt < 7; attempt++) {
      await service().pushBatch(f.tenantId);
      await sql`update notification_deliveries set available_at=clock_timestamp()-interval '1 second' where device_id=${device.id}`.execute(
        db.owner,
      );
    }
    expect(calls).toBe(5);
    expect(
      (
        await sql<{
          attempts: number;
        }>`select attempts from notification_deliveries where device_id=${device.id}`.execute(
          db.owner,
        )
      ).rows[0]?.attempts,
    ).toBe(5);
    invalid = true;
    await send(c.id);
    await dispatch(f.tenantId);
    await service().pushBatch(f.tenantId);
    expect(calls).toBe(6);
    const stored = (
      await sql<{
        enabled: boolean;
        subscription_ciphertext: string | null;
      }>`select enabled,subscription_ciphertext from notification_devices where id=${device.id}`.execute(
        db.owner,
      )
    ).rows[0]!;
    expect(stored).toEqual({ enabled: false, subscription_ciphertext: null });
  });
  it('rechecks authority immediately before transport and fences old delivery settlement after subscription rotation', async () => {
    const { config, subscription } = pushFixture(),
      { auth } = await login();
    const c = await conversation();
    let emitted = 0;
    const service = createNotificationService({
      db: db.db,
      cursorSecret: secret,
      sessionActive,
      push: config,
      pushTransport: async (_sub, _payload, _topic, current) => {
        await messaging.changeMember(f.alice, c.id, f.bob.principalId, 'remove', c.version, key());
        if (!(await current())) return 'discard';
        emitted++;
        return 'sent';
      },
    });
    const device = await service.subscribe(auth, subscription);
    await send(c.id);
    await dispatch(f.tenantId);
    const delivery = await service.prepareDelivery(f.tenantId, device.id);
    expect(delivery).not.toBeNull();
    await service.subscribe(auth, subscription);
    expect(
      await service.revalidateDelivery(f.tenantId, delivery!.delivery_id, delivery!.lease_token),
    ).toBe(false);
    await service.settleDelivery(
      f.tenantId,
      delivery!.delivery_id,
      delivery!.lease_token,
      'subscription_invalid',
    );
    expect((await service.devices(auth)).items[0]?.enabled).toBe(true);
    await send(c.id);
    await dispatch(f.tenantId);
    await service.pushBatch(f.tenantId);
    expect(emitted).toBe(0);
  });
});

describe('Web Push public HTTP boundary', () => {
  it('requires session CSRF and validates configured provider endpoints without exposing private keys', async () => {
    const { config, subscription } = pushFixture(),
      { identity, session } = await login();
    const service = createNotificationService({
      db: db.db,
      cursorSecret: secret,
      sessionActive,
      push: config,
    });
    const app = createApp({
      identity,
      messaging,
      tasks,
      notifications: service,
      logger: false,
      readiness: async () => {},
    });
    const headers = { cookie: `imbox_session=${session.token}`, 'x-imbox-tenant-id': f.tenantId };
    try {
      const keyResponse = await app.inject({
        method: 'GET',
        url: '/v1/notification-push-key',
        headers,
      });
      expect(keyResponse.statusCode).toBe(200);
      expect(keyResponse.json()).toEqual({ enabled: true, public_key: config.publicKey });
      const rejected = await app.inject({
        method: 'PUT',
        url: '/v1/notification-subscription',
        headers,
        payload: subscription,
      });
      expect(rejected.statusCode).toBe(403);
      const writeHeaders = {
        ...headers,
        origin: 'http://notifications.test',
        'x-csrf-token': session.csrfToken,
      };
      const invalid = await app.inject({
        method: 'PUT',
        url: '/v1/notification-subscription',
        headers: writeHeaders,
        payload: { ...subscription, endpoint: 'https://127.0.0.1/push' },
      });
      expect(invalid.statusCode).toBe(400);
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/notification-subscription',
        headers: writeHeaders,
        payload: subscription,
      });
      expect(saved.statusCode).toBe(200);
      expect(Object.keys(saved.json()).sort()).toEqual(['enabled', 'id', 'version']);
    } finally {
      await app.close();
    }
  });
});
