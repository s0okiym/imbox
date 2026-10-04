import { randomUUID } from 'node:crypto';
import { createMessagingService } from '@imbox/application';
import { createRuntimeService, createRuntimeWorker } from '@imbox/runtime';
import { withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from './database.js';

export async function modelFixture(databases: Awaited<ReturnType<typeof testDatabases>>) {
  const fixture = await tenantFixture(databases.owner);
  const messaging = createMessagingService(
    databases.db,
    'model-test-cursor-secret-at-least-thirty-two-characters',
  );
  const runtime = createRuntimeService({ db: databases.db });
  const worker = createRuntimeWorker({
    db: databases.db,
    workerId: `model-fixture:${randomUUID()}`,
  });
  const agentId = randomUUID();
  await databases.identityDb
    .insertInto('principals')
    .values({ id: agentId, kind: 'agent', display_name: 'Local model assistant' })
    .execute();
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await tx
      .insertInto('tenant_principals')
      .values({ tenant_id: fixture.tenantId, principal_id: agentId, role: 'agent' })
      .execute();
    await tx
      .insertInto('memberships')
      .values({
        tenant_id: fixture.tenantId,
        workspace_id: fixture.workspaceId,
        principal_id: agentId,
        role: 'member',
      })
      .execute();
  });
  const installation = await runtime.installAgent(
    fixture.alice,
    {
      principal_id: agentId,
      revision: '1',
      mode: 'hosted',
      config: { model_alias: 'local' },
      capabilities: ['text_generation'],
    },
    randomUUID(),
  );
  const chat = await messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      kind: 'group',
      title: 'Model verification',
      member_ids: [agentId],
      history_policy: 'all',
    },
    randomUUID(),
  );
  const message = await messaging.createMessage(
    fixture.alice,
    chat.id,
    { client_message_id: randomUUID(), body: '验证标识为 IMBOX_OK。' },
    randomUUID(),
  );
  const createRun = (destination = 'model:local') =>
    runtime.createRun(
      fixture.alice,
      {
        agent_id: installation.id,
        agent_revision: '1',
        conversation_id: chat.id,
        context: [{ type: 'message', id: message.id, version: message.version, required: true }],
        purpose: '请只回复记录中的验证标识，不要写任何其他文字。',
        destination,
        budget: { currency: 'USD', limit_microunits: '0' },
      },
      randomUUID(),
    );
  return {
    ...fixture,
    messaging,
    runtime,
    worker,
    agentId,
    installation,
    chat,
    message,
    createRun,
  };
}
