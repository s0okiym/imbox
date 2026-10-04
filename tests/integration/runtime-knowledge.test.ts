import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createKnowledgeService,
  knowledgeResourceIndex,
  knowledgeRuntimeSourcePort,
  type KnowledgeService,
} from '@imbox/knowledge';
import {
  createRuntimeService,
  createRuntimeWorker,
  type RuntimeService,
  type RuntimeWorker,
  type CreateRunInput,
} from '@imbox/runtime';
import { createMessagingService, type MessagingService } from '@imbox/application';
import { createResourceService, createS3ObjectStore, type ResourceService } from '@imbox/resources';
import { createSchedulingService } from '@imbox/scheduling';
import { createIdentityService, registerAuthRoutes } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuntimeRoutes } from '../../apps/api/src/runtime-routes.js';
const key = () => randomUUID();
const secret = 'runtime-knowledge-test-secret-longer-than-thirty-two-bytes';
const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333';
const store = createS3ObjectStore({
  endpoint,
  region: 'us-east-1',
  bucket: 'imbox-resources-test',
  accessKeyId: 'imbox_local_s3_app',
  secretAccessKey: 'imbox_local_s3_app_secret',
});
const admin = createS3ObjectStore({
  endpoint,
  region: 'us-east-1',
  bucket: 'imbox-resources-test',
  accessKeyId: 'imbox_local_s3_admin',
  secretAccessKey: 'imbox_local_s3_admin_secret',
});
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let knowledge: KnowledgeService;
let resources: ResourceService;
let runtime: RuntimeService;
let worker: RuntimeWorker;
let messaging: MessagingService;
let agentPrincipal: string;
let installationId: string;
beforeAll(async () => {
  databases = await testDatabases();
  await admin.ensureDevelopmentBucket('test');
});
afterAll(async () => {
  store.destroy();
  admin.destroy();
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  knowledge = createKnowledgeService({ db: databases.db, cursorSecret: secret });
  resources = createResourceService({
    db: databases.db,
    store,
    cursorSecret: secret,
    textIndex: knowledgeResourceIndex(),
  });
  const sources = knowledgeRuntimeSourcePort(knowledge);
  runtime = createRuntimeService({ db: databases.db, cursorSecret: secret, sources });
  worker = createRuntimeWorker({ db: databases.db, workerId: 'trusted-context-worker', sources });
  messaging = createMessagingService(databases.db, secret);
  agentPrincipal = key();
  await databases.identityDb
    .insertInto('principals')
    .values({ id: agentPrincipal, kind: 'agent', display_name: 'Context Agent' })
    .execute();
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await tx
      .insertInto('tenant_principals')
      .values({ tenant_id: fixture.tenantId, principal_id: agentPrincipal, role: 'agent' })
      .execute();
    await tx
      .insertInto('memberships')
      .values({
        tenant_id: fixture.tenantId,
        workspace_id: fixture.workspaceId,
        principal_id: agentPrincipal,
        role: 'member',
      })
      .execute();
  });
  installationId = (
    await runtime.installAgent(
      fixture.alice,
      {
        principal_id: agentPrincipal,
        revision: '1',
        mode: 'hosted',
        config: { model: 'test-only-context-validation' },
        capabilities: ['conversation_reply'],
      },
      key(),
    )
  ).id;
});
const conversation = () =>
  messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Shared context',
      kind: 'group',
      member_ids: [agentPrincipal, fixture.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
const memory = (scope: { conversation_id: string } | { task_id: string }) =>
  knowledge.createMemory(
    fixture.alice,
    {
      scope: 'task_id' in scope ? 'task' : 'conversation',
      ...scope,
      body: 'Explicit remembered preference: 核验所有来源。',
      source_refs: [],
      confirmation: 'confirmed',
      confidence: 100,
    },
    key(),
  );
const ref = (value: Awaited<ReturnType<typeof memory>>): CreateRunInput['context'][number] => ({
  type: 'memory',
  id: value.id,
  version: value.version,
  sha256: value.sha256,
  required: true,
});
const input = (
  scope: { conversation_id: string } | { task_id: string },
  context: CreateRunInput['context'],
): CreateRunInput => ({
  agent_id: installationId,
  agent_revision: '1',
  ...scope,
  context,
  purpose: 'Read exactly the explicitly selected fixed sources',
  destination: 'model:local',
  budget: { currency: 'USD', limit_microunits: '100' },
});
async function artifact(conversationId: string, body = 'Fixed Artifact source model input') {
  const bytes = Buffer.from(body);
  const ticket = await resources.createUpload(
    fixture.alice,
    {
      conversation_id: conversationId,
      filename: 'model-context.md',
      content_type: 'text/markdown',
      byte_size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    key(),
  );
  expect(
    (await fetch(ticket.upload_url, { method: 'PUT', headers: ticket.upload_headers, body: bytes }))
      .status,
  ).toBe(200);
  const content = await resources.completeUpload(fixture.alice, ticket.id, key());
  return resources.createArtifact(
    fixture.alice,
    { resource_id: content.id, title: 'Fixed model context' },
    key(),
  );
}
async function task() {
  const id = key();
  await withTenant(databases.owner, fixture.tenantId, async (tx) => {
    await tx
      .insertInto('tasks')
      .values({
        tenant_id: fixture.tenantId,
        id,
        root_task_id: id,
        workspace_id: fixture.workspaceId,
        owner_principal_id: fixture.alice.principalId,
        accountable_principal_id: fixture.alice.principalId,
        created_by: fixture.alice.principalId,
        title: 'Scheduled context task',
        goal: 'Honor the exact source until dispatch',
        acceptance_criteria: sql`${JSON.stringify(['Current authorized source only'])}::jsonb`,
        reviewer_ids: sql`${JSON.stringify([fixture.alice.principalId])}::jsonb`,
      })
      .execute();
    await tx
      .insertInto('task_participants')
      .values([
        {
          tenant_id: fixture.tenantId,
          task_id: id,
          principal_id: fixture.alice.principalId,
          role: 'owner',
        },
        {
          tenant_id: fixture.tenantId,
          task_id: id,
          principal_id: agentPrincipal,
          role: 'contributor',
        },
      ])
      .execute();
    await sql`insert into task_budgets(tenant_id,task_id,currency,limit_microunits) values(${fixture.tenantId},${id},'USD',100)`.execute(
      tx,
    );
  });
  return id;
}
describe('Runtime fixed Memory/Artifact source port on all execution boundaries', () => {
  it('persists exact source hashes and supplies verified untrusted content through a real worker claim', async () => {
    const chat = await conversation();
    const saved = await memory({ conversation_id: chat.id });
    const file = await artifact(chat.id);
    const run = await runtime.createRun(
      fixture.alice,
      input({ conversation_id: chat.id }, [
        ref(saved),
        {
          type: 'artifact_version',
          id: file.version_id,
          version: file.head_version,
          sha256: file.resource.sha256,
          required: true,
        },
      ]),
      key(),
    );
    const claim = await worker.claim(fixture.tenantId, run.id);
    if (!claim) throw new Error('Expected runnable claim');
    const execution = await worker.getExecution(claim);
    expect(execution.items.map((i) => i.source_sha256)).toEqual([
      saved.sha256,
      file.resource.sha256,
    ]);
    expect(execution.items.every((i) => i.trust_level === 'untrusted_user_content')).toBe(true);
    expect(JSON.stringify(execution.items)).toContain('Fixed Artifact source');
    const replacement = await artifact(chat.id, 'New Artifact head');
    await resources.createArtifactVersion(
      fixture.alice,
      file.id,
      { resource_id: replacement.resource.id },
      file.version,
      key(),
    );
    expect(JSON.stringify((await worker.getExecution(claim)).items)).toContain(
      'Fixed Artifact source',
    );
    await knowledge.deleteMemory(fixture.alice, saved.id, saved.version, key());
    await expect(
      worker.report(
        claim,
        {
          status: 'completed',
          summary: 'Must not publish after source deletion',
          checkpoint: { result: 'unpublished stale candidate' },
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const retained = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        payload: unknown;
      }>`select payload from context_items where manifest_id=${run.context_manifest_id}`.execute(
        tx,
      ),
    );
    expect(retained.rows.every((r) => JSON.stringify(r.payload) === '{}')).toBe(true);
  });
  it('rejects hash forgery, private memory disclosure, another conversation scope and an Agent missing source access', async () => {
    const chat = await conversation();
    const saved = await memory({ conversation_id: chat.id });
    const invalid = { ...ref(saved), sha256: '0'.repeat(64) };
    await expect(
      runtime.createRun(fixture.alice, input({ conversation_id: chat.id }, [invalid]), key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const own = await knowledge.createMemory(
      fixture.alice,
      {
        scope: 'personal',
        body: 'Private personal memory',
        source_refs: [],
        confirmation: 'confirmed',
        confidence: 100,
      },
      key(),
    );
    await expect(
      runtime.createRun(fixture.alice, input({ conversation_id: chat.id }, [ref(own)]), key()),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    const other = await conversation();
    await expect(
      runtime.createRun(fixture.alice, input({ conversation_id: other.id }, [ref(saved)]), key()),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    await messaging.changeMember(
      fixture.alice,
      chat.id,
      agentPrincipal,
      'remove',
      chat.version,
      key(),
    );
    await expect(
      runtime.createRun(fixture.alice, input({ conversation_id: chat.id }, [ref(saved)]), key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rechecks memory confirmation and expiry when claiming, reading, resuming and dispatching a scheduled Run', async () => {
    const taskId = await task();
    const saved = await memory({ task_id: taskId });
    const run = await runtime.createRun(
      fixture.alice,
      input({ task_id: taskId }, [ref(saved)]),
      key(),
    );
    const paused = await runtime.controlRun(fixture.alice, run.id, 'pause', run.version, key());
    const schedules = createSchedulingService({
      db: databases.db,
      cursorSecret: secret,
      sources: knowledgeRuntimeSourcePort(knowledge),
    });
    const schedule = await schedules.create(
      fixture.alice,
      {
        task_id: taskId,
        run_id: run.id,
        timezone: 'UTC',
        trigger: { kind: 'once' },
        start_at: new Date(Date.now() + 60000).toISOString(),
        deadline: new Date(Date.now() + 3600000).toISOString(),
        missed_policy: 'coalesce',
        maximum_wakeups: 1,
      },
      key(),
    );
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await sql`update memory_items set expires_at=clock_timestamp()-interval '1 second' where id=${saved.id}`.execute(
        tx,
      );
      await sql`update schedules set start_at=clock_timestamp()-interval '1 second',next_at=clock_timestamp()-interval '1 second' where id=${schedule.id}`.execute(
        tx,
      );
    });
    await expect(
      runtime.controlRun(fixture.alice, run.id, 'resume', paused.version, key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await schedules.collectDue(fixture.tenantId);
    await schedules.dispatchPending(fixture.tenantId);
    const occurrence = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        status: string;
      }>`select status from schedule_occurrences where schedule_id=${schedule.id}`.execute(tx),
    );
    expect(occurrence.rows[0]?.status).toBe('denied');
    const state = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{ status: string }>`select status from agent_runs where id=${run.id}`.execute(tx),
    );
    expect(state.rows[0]?.status).toBe('paused');
    const second = await memory({ task_id: taskId });
    const queued = await runtime.createRun(
      fixture.alice,
      input({ task_id: taskId }, [ref(second)]),
      key(),
    );
    await knowledge.updateMemory(
      fixture.alice,
      second.id,
      {
        scope: 'task',
        task_id: taskId,
        body: second.body,
        source_refs: [],
        confirmation: 'conflicted',
        confidence: 100,
        status: 'active',
      },
      second.version,
      key(),
    );
    await expect(worker.claim(fixture.tenantId, queued.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('validates extended references at HTTP ingress and denies a stale context after current source removal', async () => {
    const chat = await conversation();
    const saved = await memory({ conversation_id: chat.id });
    const origin = 'http://runtime-context.test';
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId],
    });
    const app = createApp({ readiness: async () => {} });
    app.register(async (scope) => {
      await registerAuthRoutes(scope, { identity });
      await registerRuntimeRoutes(scope, { identity, runtime });
    });
    await app.ready();
    try {
      const session = await identity.devLogin({ principalId: fixture.alice.principalId, origin });
      const headers = {
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
        origin,
        'x-csrf-token': session.csrfToken,
        'idempotency-key': key(),
      };
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agent-runs',
        headers,
        payload: input({ conversation_id: chat.id }, [ref(saved)]),
      });
      expect(response.statusCode, response.body).toBe(201);
      const id = response.json().id;
      const context = await app.inject({
        method: 'GET',
        url: `/v1/agent-runs/${id}/context-manifest`,
        headers,
      });
      expect(context.statusCode, context.body).toBe(200);
      expect(context.json().items[0].source_sha256).toBe(saved.sha256);
      await knowledge.deleteMemory(fixture.alice, saved.id, saved.version, key());
      expect(
        (await app.inject({ method: 'GET', url: `/v1/agent-runs/${id}/context-manifest`, headers }))
          .statusCode,
      ).toBe(404);
      const bad = await app.inject({
        method: 'POST',
        url: '/v1/agent-runs',
        headers: { ...headers, 'idempotency-key': key() },
        payload: input({ conversation_id: chat.id }, [
          {
            type: 'memory',
            id: saved.id,
            version: saved.version,
            required: true,
          } as CreateRunInput['context'][number],
        ]),
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
