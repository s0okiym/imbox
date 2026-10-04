import { createHash, randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { createAgentService } from '@imbox/agents';
import { ImboxAgentClient } from '@imbox/agent-sdk';
import { createKnowledgeService } from '@imbox/knowledge';
import { createMessagingService } from '@imbox/application';
import { createIdentityService } from '@imbox/auth';
import { createApp } from '../../apps/api/src/app.js';
import { testDatabases, tenantFixture } from '../helpers/database.js';

it('machine knowledge HTTP and SDK require explicit scope and current source membership without exposing personal memory', async () => {
  const db = await testDatabases(),
    f = await tenantFixture(db.owner),
    secret = 'machine-knowledge-source-permissions-secret-over-thirty-two';
  const agents = createAgentService({ db: db.db, identityDb: db.identityDb, secret }),
    knowledge = createKnowledgeService({ db: db.db, cursorSecret: secret }),
    messages = createMessagingService(db.db, secret);
  const identity = createIdentityService({
    db: db.db,
    identityDb: db.identityDb,
    publicOrigin: 'http://127.0.0.1:4700',
    environment: 'test',
    enableDevAuth: true,
    devPrincipalIds: f.ids.slice(),
    sessionSecret: secret,
  });
  const app = createApp({
    identity,
    agents,
    knowledge,
    messaging: messages,
    readiness: async () => {},
  });
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const installed = await agents.register(
      f.alice,
      {
        workspace_id: f.workspaceId,
        display_name: 'Knowledge reader',
        mode: 'external',
        scopes: ['knowledge.read', 'knowledge.search', 'agents.read'],
        capabilities: ['text_generation'],
        config: {},
      },
      randomUUID(),
    );
    const credential = await agents.issueCredential(
      f.alice,
      installed.id,
      { scopes: ['knowledge.read', 'knowledge.search', 'agents.read'], lifetime_seconds: 3600 },
      randomUUID(),
    );
    const client = new ImboxAgentClient({ origin, tenantId: f.tenantId, allowLoopbackHttp: true });
    await client.exchange({
      credential: credential.secret!,
      scopes: ['knowledge.read', 'knowledge.search'],
    });
    const conversation = await messages.createConversation(
      f.alice,
      {
        workspace_id: f.workspaceId,
        kind: 'group',
        member_ids: [installed.principal_id],
        history_policy: 'all',
      },
      randomUUID(),
    );
    const marker = 'MachineKnowledge' + randomUUID(),
      m = await messages.createMessage(
        f.alice,
        conversation.id,
        { body: marker, client_message_id: randomUUID() },
        randomUUID(),
      );
    const shared = await knowledge.createMemory(
      f.alice,
      {
        scope: 'conversation',
        conversation_id: conversation.id,
        body: marker + ' memory',
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
      randomUUID(),
    );
    const personal = await knowledge.createMemory(
      f.alice,
      {
        scope: 'personal',
        body: marker + ' PRIVATE_MEMORY',
        confirmation: 'confirmed',
        confidence: 100,
        source_refs: [],
      },
      randomUUID(),
    );
    expect((await client.getMemory(shared.id)).body).toBe(shared.body);
    expect(
      (await client.listMemories({ conversation_id: conversation.id, limit: 1 })).items[0]!.id,
    ).toBe(shared.id);
    const result = await client.search({ q: marker, workspace_id: f.workspaceId, limit: 10 });
    expect(JSON.stringify(result)).toContain(m.id);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MEMORY');
    await expect(client.getMemory(personal.id)).rejects.toMatchObject({ status: 404 });
    await client.exchange({ credential: credential.secret!, scopes: ['agents.read'] });
    await expect(client.getMemory(shared.id)).rejects.toMatchObject({ status: 403 });
    await expect(client.search({ q: marker })).rejects.toMatchObject({ status: 403 });
    const token = await agents.exchange({
      credential: credential.secret!,
      scopes: ['knowledge.read'],
    });
    const response = await fetch(origin + '/v1/machine/memories/' + shared.id, {
      headers: {
        authorization: 'Bearer ' + token.access_token,
        'x-imbox-tenant-id': f.tenantId,
        cookie: 'irrelevant=1',
      },
    });
    expect(response.status).toBe(401);
    await client.exchange({
      credential: credential.secret!,
      scopes: ['knowledge.read', 'knowledge.search'],
    });
    const current = await messages.getConversation(f.alice, conversation.id);
    await messages.changeMember(
      f.alice,
      conversation.id,
      installed.principal_id,
      'remove',
      current.version,
      randomUUID(),
    );
    await expect(client.getMemory(shared.id)).rejects.toMatchObject({ status: 404 });
    const after = await client.search({ q: marker });
    expect(after.items).toEqual([]);
  } finally {
    app.server.closeAllConnections();
    await app.close();
    await db.close();
  }
});
