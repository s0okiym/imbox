import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  createMessagingService,
  createOutboxProcessor,
  createSyncService,
} from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import { assertContract } from '@imbox/contracts';
import { tenantFixture, testDatabases } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>;
let f: Awaited<ReturnType<typeof tenantFixture>>;
const key = () => randomUUID();
const secret = 'message-interactions-test-secret-longer-than-thirty-two-characters';
const messaging = () => createMessagingService(db.db, secret);
const sync = () => createSyncService({ db: db.db, cursorSecret: secret });
beforeAll(async () => {
  db = await testDatabases();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  f = await tenantFixture(db.owner);
});
const conversation = () =>
  messaging().createConversation(
    f.alice,
    {
      workspace_id: f.workspaceId,
      kind: 'group',
      title: 'Threads',
      member_ids: [f.bob.principalId],
      history_policy: 'since_join',
    },
    key(),
  );
const message = (c: string, body = 'Original') =>
  messaging().createMessage(f.alice, c, { client_message_id: key(), body }, key());
async function project() {
  const p = createOutboxProcessor({ db: db.db });
  for (let i = 0; i < 20; i++) {
    const r = await p.processBatch(f.tenantId);
    expect(r.failed).toBe(0);
    if (r.claimed === 0) return;
  }
  throw new Error('Projection did not drain');
}
describe('message threads, fixed quotes and reactions', () => {
  it('freezes quote version across edits and redacts/deletes retained source revisions on withdrawal', async () => {
    const c = await conversation();
    let original = await message(c.id);
    const quote = await messaging().createMessage(
      f.bob,
      c.id,
      {
        client_message_id: key(),
        body: 'Discuss this version',
        reply_to_id: original.id,
        reply_to_version: original.version,
      },
      key(),
    );
    expect(quote.thread_root_id).toBe(original.id);
    expect(quote.quote).toMatchObject({
      source_version: '1',
      body: 'Original',
      unavailable: false,
    });
    original = await messaging().changeMessage(
      f.alice,
      original.id,
      { body: 'Changed later' },
      original.version,
      key(),
    );
    expect((await messaging().getMessage(f.bob, quote.id)).quote?.body).toBe('Original');
    await expect(
      messaging().createMessage(
        f.bob,
        c.id,
        {
          client_message_id: key(),
          body: 'Stale',
          reply_to_id: original.id,
          reply_to_version: '1',
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await project();
    const old = await sync().snapshot(f.bob, c.id);
    await messaging().changeMessage(f.alice, original.id, null, original.version, key());
    expect((await messaging().getMessage(f.bob, quote.id)).quote).toMatchObject({
      source_version: '1',
      body: null,
      unavailable: true,
    });
    await expect(sync().events(f.bob, c.id, { cursor: old.cursor })).rejects.toMatchObject({
      code: 'RESYNC_REQUIRED',
    });
    await project();
    const current = await sync().snapshot(f.bob, c.id);
    expect(
      current.items.find((x) => x.entity.id === quote.id)?.payload.message?.quote?.body,
    ).toBeNull();
    await withTenant(db.db, f.tenantId, async (tx) =>
      expect(
        (await sql`select 1 from message_revisions where message_id=${original.id}`.execute(tx))
          .rows,
      ).toEqual([]),
    );
  });
  it('keeps paged row metadata separate and redacts fixed quotes after their source is deleted', async () => {
    const c = await conversation();
    const source = await message(c.id);
    const reply = await messaging().createMessage(
      f.bob,
      c.id,
      {
        client_message_id: key(),
        body: 'Reply',
        reply_to_id: source.id,
        reply_to_version: source.version,
      },
      key(),
    );
    const edited = await messaging().changeMessage(
      f.alice,
      source.id,
      { body: 'Edited source' },
      source.version,
      key(),
    );
    await messaging().setReaction(f.bob, reply.id, { emoji: '👀' }, true, key());
    const trailing = await message(c.id);
    const page = await messaging().listMessages(f.bob, c.id, { limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual([reply.id, trailing.id]);
    expect(page.items[0]).toMatchObject({
      actor: { id: f.bob.principalId },
      body: 'Reply',
      reactions: [{ emoji: '👀', count: '1' }],
      quote: { body: 'Original', source_version: '1', unavailable: false },
    });
    expect(page.items[0]?.edited_at).toBeUndefined();
    expect(page.items[1]).toMatchObject({
      actor: { id: f.alice.principalId },
      reactions: [],
      attachment_ids: [],
    });
    expect(page.items[1]?.quote).toBeUndefined();
    const older = await messaging().listMessages(f.bob, c.id, {
      limit: 2,
      cursor: page.next_cursor!,
    });
    expect(older.items).toHaveLength(1);
    expect(older.items[0]).toMatchObject({
      id: source.id,
      body: 'Edited source',
      edited_at: edited.edited_at,
      reactions: [],
    });
    expect(older.items[0]?.edited_at).toBeDefined();
    expect((await messaging().listThread(f.bob, source.id)).items).toEqual([page.items[0]]);
    await messaging().changeMessage(f.alice, source.id, null, edited.version, key());
    const after = await messaging().listMessages(f.bob, c.id);
    expect(after.items[0]).toMatchObject({
      deleted: true,
      body: '',
      reactions: [],
      attachment_ids: [],
    });
    expect(after.items[1]?.quote).toMatchObject({ body: null, unavailable: true });
    expect((await messaging().listThread(f.bob, source.id)).items[0]?.quote?.body).toBeNull();
  });
  it('requires precise quote versions, same-conversation sources and canonical thread roots', async () => {
    const c = await conversation(),
      other = await conversation();
    const root = await message(c.id),
      foreign = await message(other.id);
    await expect(
      messaging().createMessage(
        f.alice,
        c.id,
        { client_message_id: key(), body: 'Unfixed', reply_to_id: root.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      messaging().createMessage(
        f.alice,
        c.id,
        {
          client_message_id: key(),
          body: 'Leak',
          reply_to_id: foreign.id,
          reply_to_version: foreign.version,
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const a = await messaging().createMessage(
      f.bob,
      c.id,
      {
        client_message_id: key(),
        body: 'Reply 1',
        reply_to_id: root.id,
        reply_to_version: root.version,
      },
      key(),
    );
    const b = await messaging().createMessage(
      f.alice,
      c.id,
      { client_message_id: key(), body: 'Reply 2', reply_to_id: a.id, reply_to_version: a.version },
      key(),
    );
    expect(b.thread_root_id).toBe(root.id);
    await expect(
      messaging().createMessage(
        f.alice,
        c.id,
        { client_message_id: key(), body: 'Nested root', thread_root_id: a.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const first = await messaging().listThread(f.bob, root.id, { limit: 1 });
    expect(first.items.map((x) => x.id)).toEqual([a.id]);
    expect(first.next_cursor).toBeTruthy();
    expect(
      (await messaging().listThread(f.bob, root.id, { cursor: first.next_cursor! })).items.map(
        (x) => x.id,
      ),
    ).toEqual([b.id]);
    await expect(
      messaging().listThread(f.alice, root.id, { cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  });
  it('never leaks older quoted text or thread identifiers to members whose history starts later, including sync', async () => {
    let c = await conversation();
    const root = await message(c.id, 'Before the member joined');
    c = await messaging().changeMember(
      f.alice,
      c.id,
      f.charlie.principalId,
      'add',
      c.version,
      key(),
    );
    const reply = await messaging().createMessage(
      f.alice,
      c.id,
      {
        client_message_id: key(),
        body: 'New visible discussion',
        reply_to_id: root.id,
        reply_to_version: root.version,
      },
      key(),
    );
    const visible = await messaging().getMessage(f.charlie, reply.id);
    expect(visible.quote).toBeUndefined();
    expect(visible.reply_to_id).toBeUndefined();
    expect(visible.thread_root_id).toBeUndefined();
    await project();
    const snapshot = await sync().snapshot(f.charlie, c.id);
    expect(JSON.stringify(snapshot)).not.toContain('Before the member joined');
    expect(JSON.stringify(snapshot)).not.toContain(root.id);
    expect(
      snapshot.items.find((x) => x.entity.id === reply.id)?.payload.message,
    ).not.toHaveProperty('quote');
    await expect(messaging().listThread(f.charlie, root.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('deduplicates reactions under concurrency without changing message order and only removes the actor’s own reaction', async () => {
    const c = await conversation(),
      m = await message(c.id);
    const token = key();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        messaging().setReaction(f.alice, m.id, { emoji: '👍' }, true, token),
      ),
    );
    await messaging().setReaction(f.alice, m.id, { emoji: '👍' }, true, key());
    const b = await messaging().setReaction(f.bob, m.id, { emoji: '👍' }, true, key());
    expect(b.seq).toBe(m.seq);
    expect(b.version).toBe('3');
    expect(b.edited_at).toBeUndefined();
    expect(b.reactions).toEqual([{ emoji: '👍', count: '2' }]);
    const removed = await messaging().setReaction(f.alice, m.id, { emoji: '👍' }, false, key());
    expect(removed.reactions).toEqual([{ emoji: '👍', count: '1' }]);
    const people = await messaging().listReactions(f.alice, m.id);
    assertContract('ReactionPage', people);
    expect(people.items.map((x) => x.principal_id)).toEqual([f.bob.principalId]);
    await project();
    const snapshot = await sync().snapshot(f.bob, c.id);
    expect(snapshot.items.find((x) => x.entity.id === m.id)?.payload.message?.reactions).toEqual([
      { emoji: '👍', count: '1' },
    ]);
    const more = await messaging().setReaction(f.alice, m.id, { emoji: '🎉' }, true, key());
    await project();
    const events = await sync().events(f.bob, c.id, { cursor: snapshot.cursor });
    expect(events.items.some((x) => x.payload.message?.version === more.version)).toBe(true);
    await messaging().changeMessage(f.alice, m.id, null, more.version, key());
    await expect(
      messaging().setReaction(f.bob, m.id, { emoji: '👍' }, true, key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('denies reaction and quote reads after workspace or conversation revocation', async () => {
    const c = await conversation();
    const m = await message(c.id);
    await messaging().changeMember(f.alice, c.id, f.bob.principalId, 'remove', c.version, key());
    await expect(
      messaging().setReaction(f.bob, m.id, { emoji: '👀' }, true, key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(messaging().listReactions(f.bob, m.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(messaging().getMessage(f.bob, m.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
