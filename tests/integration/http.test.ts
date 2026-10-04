import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityService } from '@imbox/auth';
import { createMessagingService } from '@imbox/application';
import { createApp } from '../../apps/api/src/app.js';
import { tenantFixture, testDatabases } from '../helpers/database.js';

let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let app: ReturnType<typeof createApp>;
let cookie: string;
let csrf: string;
const origin = 'http://localhost:5173';
beforeAll(async () => {
  databases = await testDatabases();
  fixture = await tenantFixture(databases.owner);
  const secret = 'http-integration-test-session-secret-longer-than-thirty-two';
  app = createApp({
    readiness: async () => {},
    messaging: createMessagingService(databases.db, secret),
    identity: createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId],
    }),
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    headers: { origin },
    payload: { principal_id: fixture.alice.principalId },
  });
  expect(login.statusCode).toBe(200);
  csrf = login.json<{ csrf_token: string }>().csrf_token;
  cookie = login.cookies.find((item) => item.name === 'imbox_session')!.value;
});
afterAll(async () => {
  await app?.close();
  await databases?.close();
});
const headers = () => ({
  origin,
  cookie: `imbox_session=${cookie}`,
  'x-csrf-token': csrf,
  'x-imbox-tenant-id': fixture.tenantId,
  'idempotency-key': randomUUID(),
});
const conversationInput = () => ({
  workspace_id: fixture.workspaceId,
  kind: 'group',
  title: 'HTTP 测试',
  member_ids: [fixture.bob.principalId],
});
describe('HTTP contracts, real sessions and persisted messaging', () => {
  it('requires a current session, exposes only active capabilities and preserves security headers', async () => {
    const noSession = await app.inject({
      url: '/v1/conversations',
      headers: { 'x-imbox-tenant-id': fixture.tenantId },
    });
    expect(noSession.statusCode).toBe(401);
    const me = await app.inject({ url: '/v1/me', headers: headers() });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      tenant_id: fixture.tenantId,
      principal: { id: fixture.alice.principalId, kind: 'human' },
    });
    expect(me.json().capabilities).not.toContain('agent.run');
    expect(me.headers['cache-control']).toContain('no-store');
    expect(me.headers['x-content-type-options']).toBe('nosniff');
    expect(me.body).not.toContain('token_hash');
    expect(me.body).not.toContain('csrf_token_hash');
  });
  it('rejects unsafe cross-origin requests and forged actor fields before persistence', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...headers(), origin: 'https://attacker.invalid' },
      payload: conversationInput(),
    });
    expect(denied.statusCode).toBe(403);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: headers(),
      payload: { ...conversationInput(), actor_id: fixture.bob.principalId },
    });
    expect(forged.statusCode).toBe(400);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...headers(), 'x-csrf-token': '' },
      payload: conversationInput(),
    });
    expect(noCsrf.statusCode).toBe(403);
  });
  it('sends, reads, edits and retracts messages with strong ETags and server-authoritative authors', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: headers(),
      payload: conversationInput(),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const send = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/messages`,
      headers: headers(),
      payload: { client_message_id: randomUUID(), body: '<script>alert(1)</script> 中文' },
    });
    expect(send.statusCode).toBe(201);
    expect(send.headers.etag).toBe('"1"');
    expect(send.json()).toMatchObject({
      actor: { id: fixture.alice.principalId },
      seq: '1',
      deleted: false,
    });
    const messageId = send.json<{ id: string }>().id;
    const missingVersion = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${messageId}`,
      headers: headers(),
      payload: { body: 'edit' },
    });
    expect(missingVersion.statusCode).toBe(400);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${messageId}`,
      headers: { ...headers(), 'if-match': '"1"' },
      payload: { body: '修改正文' },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.headers.etag).toBe('"2"');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/messages/${messageId}`,
      headers: { ...headers(), 'if-match': '"1"' },
      payload: { body: 'lost update' },
    });
    expect(stale.statusCode).toBe(409);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${messageId}`,
      headers: { ...headers(), 'if-match': '"2"' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ body: '', deleted: true });
    const messages = await app.inject({
      url: `/v1/conversations/${id}/messages?limit=50`,
      headers: headers(),
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items).toHaveLength(1);
    expect(messages.body).not.toContain('修改正文');
  });
  it('normalizes malformed, oversized and unknown endpoint errors without stack or credential leaks', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    const large = await app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'x'.repeat(270_000) }),
    });
    expect(large.statusCode).toBe(413);
    const missing = await app.inject({ url: '/v1/no-such-endpoint' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    for (const response of [malformed, large, missing]) {
      expect(response.body).not.toContain('postgres://');
      expect(response.body).not.toContain('stack');
    }
  });
});
