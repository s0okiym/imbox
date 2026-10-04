import type { ContractTypes as C } from '@imbox/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMessagingService } from '@imbox/application';
import { tenantFixture, testDatabases } from '../helpers/database.js';
let databases: Awaited<ReturnType<typeof testDatabases>>;
beforeAll(async () => {
  databases = await testDatabases();
});
afterAll(async () => {
  await databases?.close();
});
it('keeps direct conversations to two authorized participants and prevents conversion through member mutation', async () => {
  const f = await tenantFixture(databases.owner);
  const messaging = createMessagingService(
    databases.db,
    'direct-messaging-secret-at-least-32-characters',
  );
  const input: C['CreateConversationInput'] = {
    workspace_id: f.workspaceId,
    kind: 'direct' as const,
    member_ids: [f.bob.principalId],
  };
  const chat = await messaging.createConversation(f.alice, input, randomUUID());
  expect(chat.kind).toBe('direct');
  expect(
    (await messaging.conversationMembers(f.bob, chat.id)).items.map((p) => p.principal.id).sort(),
  ).toEqual([f.alice.principalId, f.bob.principalId].sort());
  await messaging.createMessage(
    f.alice,
    chat.id,
    { client_message_id: randomUUID(), body: 'Private direct message' },
    randomUUID(),
  );
  await messaging.createMessage(
    f.bob,
    chat.id,
    { client_message_id: randomUUID(), body: 'Private reply' },
    randomUUID(),
  );
  expect((await messaging.listMessages(f.alice, chat.id)).items.map((m) => m.body)).toEqual([
    'Private direct message',
    'Private reply',
  ]);
  expect((await messaging.listMessages(f.bob, chat.id)).items).toHaveLength(2);
  expect((await messaging.listConversations(f.charlie)).items).toEqual([]);
  await expect(messaging.listMessages(f.charlie, chat.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(
    messaging.changeMember(
      f.alice,
      chat.id,
      f.charlie.principalId,
      'add',
      chat.version,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(
    messaging.changeMember(
      f.alice,
      chat.id,
      f.bob.principalId,
      'remove',
      chat.version,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  for (const member_ids of [[f.alice.principalId], [f.bob.principalId, f.charlie.principalId]] as [
    string,
    ...string[],
  ][])
    await expect(
      messaging.createConversation(f.alice, { ...input, member_ids }, randomUUID()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});
