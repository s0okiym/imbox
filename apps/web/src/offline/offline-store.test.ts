import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Conversation } from '@imbox/contracts';
import type { ChatMessage, Session } from '../api.js';
import { ApiError } from '../api.js';
import { drainOutbox, type OutboxGateway } from './offline-outbox.js';
import {
  OfflineStore,
  OFFLINE_RETENTION_MS,
  OUTBOX_LEASE_MS,
  namespaceKey,
  type OfflineScope,
} from './offline-store.js';

const policy = {
  offline_queue_allowed: true,
  offline_message_cache_allowed: true,
  offline_queue_max_days: 7 as const,
};
const scope: OfflineScope = {
  tenantId: 'tenant',
  principalId: 'alice',
  workspaceId: 'workspace',
  conversationId: 'conversation',
  viewScope: 'conversation',
  authzGeneration: '1',
};
const session = {
  tenant_id: 'tenant',
  principal: { id: 'alice', kind: 'human', display_name: 'Alice', status: 'active' },
  authz_revision: '1',
  csrf_token: 'must-never-persist',
  session_id: 'must-never-persist-id',
  session_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [],
  workspaces: [{ id: 'workspace', name: 'Work', role: 'member' }],
} as Session;
const conversation = {
  id: 'conversation',
  workspace_id: 'workspace',
  view_scope: 'conversation',
  authz_generation: '1',
  title: 'Private conversation',
} as Conversation;
const intent = (now = Date.now()) => ({
  clientMessageId: crypto.randomUUID(),
  idempotencyKey: crypto.randomUUID(),
  body: 'A deliberate draft',
  createdAt: now,
});
const stores: OfflineStore[] = [];
async function store(name = crypto.randomUUID()) {
  const value = new OfflineStore(name);
  stores.push(value);
  await value.setPreferences(scope, { queue: true, history: true }, policy);
  await value.rememberSession(session);
  return value;
}
afterEach(async () => {
  const open = stores.splice(0);
  for (const item of open) item.close();
  for (const item of open) await item.delete();
});
const callbacks = () => ({ saved: () => {}, rejected: () => {}, sessionLost: () => {} });
function gateway(send: OutboxGateway['send']): OutboxGateway {
  return {
    session: async () => session,
    policy: async () => policy,
    conversation: async () => conversation,
    send,
  };
}
const receipt = (id: string) =>
  ({
    id: 'server-message',
    client_message_id: id,
    conversation_id: scope.conversationId,
    actor: session.principal,
    view_scope: scope.viewScope,
    authz_generation: scope.authzGeneration,
  }) as ChatMessage;

describe('IndexedDB queue authority and crash recovery', () => {
  it('does not resurrect cached content or profile after local erasure races pending writes', async () => {
    const db = await store();
    await Promise.all([
      db.eraseIdentity(scope),
      db.saveDraft(scope, 'late draft'),
      db.saveHistory(session, conversation, [
        { ...receipt('late'), body: 'late cache' } as ChatMessage,
      ]),
      db.rememberSession(session),
    ]);
    expect(await db.preferences.count()).toBe(0);
    expect(await db.profiles.count()).toBe(0);
    expect(await db.history.count()).toBe(0);
    expect(await db.drafts.count()).toBe(0);
  });

  it('requires both device consent and server policy and persists no credentials', async () => {
    const db = new OfflineStore(crypto.randomUUID());
    stores.push(db);
    await expect(db.enqueue(scope, '1', intent())).rejects.toThrow('OFFLINE_QUEUE_NOT_ALLOWED');
    await db.setPreferences(
      scope,
      { queue: true, history: true },
      { ...policy, offline_queue_allowed: false, offline_message_cache_allowed: false },
    );
    await expect(db.enqueue(scope, '1', intent())).rejects.toThrow('OFFLINE_QUEUE_NOT_ALLOWED');
    await db.setPreferences(scope, { queue: true, history: true }, policy);
    await db.rememberSession(session);
    expect(JSON.stringify(await db.profiles.toArray())).not.toContain('must-never-persist');
    expect(await db.preferences.get(namespaceKey(scope))).toMatchObject({
      queue: true,
      history: true,
    });
  });
  it('serializes competing tab claims and reclaims a crashed sender with the original key', async () => {
    const db = await store(),
      now = Date.now(),
      command = intent(now);
    await db.enqueue(scope, '1', command, now);
    const anotherTab = new OfflineStore(db.name);
    stores.push(anotherTab);
    const claims = await Promise.all([
      db.claim(command.clientMessageId, scope, 'tab-a', now),
      anotherTab.claim(command.clientMessageId, scope, 'tab-b', now),
    ]);
    const first = claims.find((value) => value !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await db.claim(command.clientMessageId, scope, 'tab-c', now + OUTBOX_LEASE_MS - 1),
    ).toBeNull();
    const next = await db.claim(command.clientMessageId, scope, 'tab-c', now + OUTBOX_LEASE_MS);
    expect(next).toMatchObject({
      id: command.clientMessageId,
      idempotencyKey: command.idempotencyKey,
      body: command.body,
    });
    await db.acknowledge(first); // Late receipt from an old lease cannot delete the new claim.
    expect(await db.outbox.get(command.clientMessageId)).toMatchObject({
      leaseToken: next!.leaseToken,
    });
    await db.acknowledge(next!);
    expect(await db.outbox.count()).toBe(0);
  });
  it('isolates tenants and principals even when a caller supplies a real queued identifier', async () => {
    const db = await store(),
      command = intent();
    await db.enqueue(scope, '1', command);
    const other = { ...scope, principalId: 'bob' };
    await db.setPreferences(other, { queue: true, history: true }, policy);
    expect(await db.claim(command.clientMessageId, other, 'wrong-tab')).toBeNull();
    expect(await db.pending(other)).toHaveLength(0);
    expect(await db.pending({ ...scope, tenantId: 'another-tenant' })).toHaveLength(0);
    await expect(db.enqueue(other, '1', command)).rejects.toThrow('OFFLINE_INTENT_CHANGED');
  });
  it('rejects changed commands and stops seven-day-old messages instead of creating fresh keys', async () => {
    const db = await store(),
      now = Date.now(),
      command = intent(now);
    await db.enqueue(scope, '1', command, now);
    await expect(
      db.enqueue(scope, '1', { ...command, body: 'Altered intent' }, now),
    ).rejects.toThrow('OFFLINE_INTENT_CHANGED');
    expect(await db.pending(scope, now + OFFLINE_RETENTION_MS)).toHaveLength(0);
    expect(await db.outbox.get(command.clientMessageId)).toMatchObject({
      status: 'expired',
      body: '',
      idempotencyKey: command.idempotencyKey,
    });
  });
  it('redacts histories, drafts and unsent command content when the authorization generation changes', async () => {
    const db = await store(),
      command = intent();
    await db.saveHistory(session, conversation, []);
    await db.saveDraft(scope, 'Sensitive draft');
    await db.enqueue(scope, '1', command);
    await db.saveDraft(scope, 'Another sensitive draft');
    await db.saveHistory(session, { ...conversation, authz_generation: '2' }, []);
    expect(await db.outbox.get(command.clientMessageId)).toMatchObject({
      status: 'rejected',
      body: '',
      error: 'AUTHORIZATION_CHANGED',
    });
    expect(await db.drafts.count()).toBe(0);
    expect((await db.history.toArray()).map((value) => value.scope.authzGeneration)).toEqual(['2']);
  });
  it('keeps uncertain delivery on the same key and reconciles a single remote effect', async () => {
    const db = await store(),
      command = intent();
    await db.enqueue(scope, '1', command);
    const seen = new Set<string>();
    let sends = 0,
      saved = 0;
    const service = gateway(async (message) => {
      sends++;
      seen.add(message.idempotencyKey);
      if (sends === 1) throw new TypeError('Response lost after remote commit');
      return receipt(message.id);
    });
    const hooks = { ...callbacks(), saved: () => saved++ };
    await drainOutbox(db, scope, service, new AbortController().signal, hooks);
    expect(await db.outbox.get(command.clientMessageId)).toMatchObject({
      status: 'queued',
      error: 'RESPONSE_UNCONFIRMED',
    });
    await drainOutbox(db, scope, service, new AbortController().signal, hooks);
    expect(seen.size).toBe(1);
    expect(saved).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });
  it('does not send when membership was revoked and removes local plaintext immediately', async () => {
    const db = await store(),
      command = intent();
    await db.enqueue(scope, '1', command);
    await db.saveHistory(session, conversation, []);
    let sends = 0;
    const service = gateway(async (message) => {
      sends++;
      return receipt(message.id);
    });
    service.conversation = async () => {
      throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
    };
    await drainOutbox(db, scope, service, new AbortController().signal, callbacks());
    expect(sends).toBe(0);
    expect(await db.history.count()).toBe(0);
    expect(await db.outbox.get(command.clientMessageId)).toMatchObject({
      status: 'rejected',
      body: '',
      error: 'ACCESS_REVOKED',
    });
  });
  it('pauses on 401 and only resumes after the same authenticated principal returns', async () => {
    const db = await store(),
      command = intent();
    await db.enqueue(scope, '1', command);
    let sends = 0,
      expired = 0;
    const service = gateway(async (message) => {
      sends++;
      return receipt(message.id);
    });
    service.session = async () => {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Session expired');
    };
    await drainOutbox(db, scope, service, new AbortController().signal, {
      ...callbacks(),
      sessionLost: () => expired++,
    });
    expect(sends).toBe(0);
    expect(expired).toBe(1);
    expect((await db.pending(scope)).length).toBe(1);
    service.session = async () => ({ ...session, principal: { ...session.principal, id: 'bob' } });
    await drainOutbox(db, scope, service, new AbortController().signal, callbacks());
    expect(sends).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.profiles.count()).toBe(0);
  });
});
