import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMessagingService, type MessagingService } from '@imbox/application';
import { withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';

let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let messaging: MessagingService;
beforeAll(async () => {
  databases = await testDatabases();
  messaging = createMessagingService(
    databases.db,
    'a-test-cursor-secret-with-more-than-thirty-two-chars',
  );
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
});
const newKey = () => randomUUID();
const group = (key = newKey()) =>
  messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: '工程协作',
      kind: 'group',
      member_ids: [fixture.bob.principalId],
      history_policy: 'since_join',
    },
    key,
  );
const send = (id: string, body = '你好，世界') =>
  messaging.createMessage(fixture.alice, id, { client_message_id: randomUUID(), body }, newKey());

describe('real PostgreSQL messaging commands and current permissions', () => {
  it('concurrent command retries commit one conversation and one event/outbox', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 6 }, () => group(key)));
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect(await tx.selectFrom('conversations').select('id').execute()).toHaveLength(1);
      expect(await tx.selectFrom('domain_events').select('id').execute()).toHaveLength(1);
      expect(await tx.selectFrom('outbox').select('id').execute()).toHaveLength(1);
    });
    await expect(
      messaging.createConversation(
        fixture.alice,
        {
          workspace_id: fixture.workspaceId,
          title: 'Changed',
          kind: 'group',
          member_ids: [fixture.bob.principalId],
        },
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('bounds database round trips as a plain history page grows without skipping message rows', async () => {
    const c = await group();
    for (let index = 0; index < 100; index++) await send(c.id, `Page row ${index}`);
    let queries = 0;
    const observed = createMessagingService(
      databases.db.withPlugin({
        transformQuery(args) {
          queries++;
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      }),
      'page-query-budget-secret-more-than-thirty-two-characters',
    );
    const small = await observed.listMessages(fixture.bob, c.id, { limit: 10 });
    const smallQueries = queries;
    queries = 0;
    const large = await observed.listMessages(fixture.bob, c.id, { limit: 100 });
    expect(small.items.map((item) => item.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Page row ${90 + i}`),
    );
    expect(large.items.map((item) => item.body)).toEqual(
      Array.from({ length: 100 }, (_, i) => `Page row ${i}`),
    );
    // A page may perform authorization queries, but must not issue queries per ordinary row.
    expect(queries).toBeLessThanOrEqual(20);
    expect(queries).toBeLessThanOrEqual(smallQueries + 1);
    await expect(observed.listMessages(fixture.charlie, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('membership and tenant isolation apply to both lookup and enumeration', async () => {
    const c = await group();
    const outsider = await tenantFixture(databases.owner);
    await expect(messaging.getConversation(fixture.charlie, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(messaging.getConversation(outsider.alice, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await messaging.listConversations(fixture.charlie)).items).toEqual([]);
    expect((await messaging.listConversations(fixture.bob)).items.map((item) => item.id)).toEqual([
      c.id,
    ]);
  });
  it('concurrent repeated sends allocate once and reject reused client message identity', async () => {
    const c = await group();
    const input = { client_message_id: randomUUID(), body: 'exactly once locally' };
    const key = newKey();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => messaging.createMessage(fixture.alice, c.id, input, key)),
    );
    expect(new Set(results.map((item) => item.id)).size).toBe(1);
    expect(results[0]?.seq).toBe('1');
    await expect(
      messaging.createMessage(fixture.alice, c.id, input, newKey()),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await messaging.listMessages(fixture.bob, c.id)).items).toHaveLength(1);
  });
  it('latest-first pagination is caller-bound, and stale authorization cursors require resync', async () => {
    const c = await group();
    for (let i = 0; i < 4; i++) await send(c.id, `message ${i}`);
    const page = await messaging.listMessages(fixture.alice, c.id, { limit: 2 });
    expect(page.items.map((item) => item.seq)).toEqual(['3', '4']);
    expect(page.next_cursor).toBeDefined();
    expect(
      (
        await messaging.listMessages(fixture.alice, c.id, { cursor: page.next_cursor!, limit: 2 })
      ).items.map((item) => item.seq),
    ).toEqual(['1', '2']);
    await expect(
      messaging.listMessages(fixture.bob, c.id, { cursor: page.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await messaging.changeMember(
      fixture.alice,
      c.id,
      fixture.charlie.principalId,
      'add',
      c.version,
      newKey(),
    );
    await expect(
      messaging.listMessages(fixture.alice, c.id, { cursor: page.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      messaging.listMessages(fixture.alice, c.id, { cursor: 'tampered' }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  });
  it('since-join history blocks earlier bodies and reply references', async () => {
    const c = await group();
    const old = await send(c.id, 'before Charlie joined');
    await messaging.changeMember(
      fixture.alice,
      c.id,
      fixture.charlie.principalId,
      'add',
      c.version,
      newKey(),
    );
    const fresh = await send(c.id, 'after Charlie joined');
    expect(
      (await messaging.listMessages(fixture.charlie, c.id)).items.map((item) => item.id),
    ).toEqual([fresh.id]);
    await expect(
      messaging.createMessage(
        fixture.charlie,
        c.id,
        {
          client_message_id: randomUUID(),
          body: 'cannot quote hidden',
          reply_to_id: old.id,
          reply_to_version: old.version,
        },
        newKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('concurrent edits require the same current version and retain the old revision', async () => {
    const c = await group();
    const m = await send(c.id, 'original');
    const outcomes = await Promise.allSettled(
      ['left', 'right'].map((body) =>
        messaging.changeMessage(fixture.alice, m.id, { body }, '1', newKey()),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    const current = (await messaging.listMessages(fixture.bob, c.id)).items[0]!;
    expect(current.version).toBe('2');
    await expect(
      messaging.changeMessage(fixture.bob, m.id, { body: 'impersonated edit' }, '2', newKey()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect(
        (
          await tx
            .selectFrom('message_revisions')
            .select('body')
            .where('message_id', '=', m.id)
            .execute()
        ).map((item) => item.body),
      ).toEqual(['original']);
    });
    const deleted = await messaging.changeMessage(fixture.alice, m.id, null, '2', newKey());
    expect(deleted).toMatchObject({ body: '', deleted: true, version: '3' });
  });
  it('revocation blocks reads, new sends, and previously successful command replays', async () => {
    const c = await group();
    const key = newKey();
    const input = { client_message_id: randomUUID(), body: 'sent before revocation' };
    await messaging.createMessage(fixture.bob, c.id, input, key);
    await messaging.changeMember(
      fixture.alice,
      c.id,
      fixture.bob.principalId,
      'remove',
      '1',
      newKey(),
    );
    await expect(messaging.listMessages(fixture.bob, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(messaging.createMessage(fixture.bob, c.id, input, key)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      messaging.createMessage(
        fixture.bob,
        c.id,
        { client_message_id: randomUUID(), body: 'after revocation' },
        newKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('workspace membership revocation closes old conversation access and enumeration', async () => {
    const c = await group();
    await send(c.id);
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await tx
        .updateTable('memberships')
        .set({ status: 'disabled' })
        .where('workspace_id', '=', fixture.workspaceId)
        .where('principal_id', '=', fixture.bob.principalId)
        .execute();
    });
    expect((await messaging.listConversations(fixture.bob)).items).toEqual([]);
    await expect(messaging.getConversation(fixture.bob, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(messaging.listMessages(fixture.bob, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      messaging.createMessage(
        fixture.bob,
        c.id,
        { client_message_id: randomUUID(), body: 'revoked workspace' },
        newKey(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('read cursors remain monotonic and reject positions outside the visible stream', async () => {
    const c = await group();
    await send(c.id);
    await send(c.id);
    expect(await messaging.markRead(fixture.bob, c.id, '2', newKey())).toEqual({
      last_read_seq: '2',
    });
    expect(await messaging.markRead(fixture.bob, c.id, '1', newKey())).toEqual({
      last_read_seq: '2',
    });
    await expect(messaging.markRead(fixture.bob, c.id, '3', newKey())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
