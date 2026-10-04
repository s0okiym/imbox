import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createResourceService,
  createS3ObjectStore,
  resourceApplicationHooks,
  type ResourceService,
} from '@imbox/resources';
import {
  createMessagingService,
  createTaskService,
  createSyncService,
  createOutboxProcessor,
  type MessagingService,
  type TaskService,
  type SyncService,
  type OutboxProcessor,
} from '@imbox/application';
import type { ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';

const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333';
const secret = 'resource-links-test-secret-longer-than-thirty-two-characters';
const key = () => randomUUID();
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
let resources: ResourceService;
let messaging: MessagingService;
let tasks: TaskService;
let sync: SyncService;
let worker: OutboxProcessor;
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
  resources = createResourceService({ db: databases.db, store, cursorSecret: secret });
  const hooks = resourceApplicationHooks();
  messaging = createMessagingService(databases.db, secret, { resources: hooks.messages });
  tasks = createTaskService(databases.db, secret, { artifacts: hooks.artifacts });
  sync = createSyncService({ db: databases.db, cursorSecret: secret });
  worker = createOutboxProcessor({ db: databases.db });
});
const group = (history_policy: 'all' | 'since_join' = 'all') =>
  messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      kind: 'group',
      title: 'Resources in a conversation',
      member_ids: [fixture.bob.principalId],
      history_policy,
    },
    key(),
  );
async function ready(
  scope: { conversation_id: string } | { task_id: string },
  text = 'A fixed evidence source',
) {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await resources.createUpload(
    fixture.alice,
    {
      ...scope,
      filename: 'evidence.md',
      content_type: 'text/markdown',
      byte_size: bytes.byteLength,
      sha256,
    },
    key(),
  );
  const uploaded = await fetch(ticket.upload_url, {
    method: 'PUT',
    headers: ticket.upload_headers,
    body: bytes,
  });
  expect(uploaded.status, await uploaded.text()).toBe(200);
  return resources.completeUpload(fixture.alice, ticket.id, key());
}
const send = (conversationId: string, resourceId: string, token = key()) =>
  messaging.createMessage(
    fixture.alice,
    conversationId,
    { client_message_id: token, body: 'See this fixed attachment', attachment_ids: [resourceId] },
    token,
  );
const task = () =>
  tasks.createTask(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Evidence task',
      goal: 'Review the fixed report',
      acceptance_criteria: ['Report hash matches the submitted source'],
      reviewer_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '1000000' },
    },
    key(),
  );
const evidence = (
  artifact: Awaited<ReturnType<ResourceService['createArtifact']>>,
): C['ArtifactEvidenceRef'] => ({
  type: 'artifact_version',
  artifact_id: artifact.id,
  version_id: artifact.version_id,
  sha256: artifact.resource.sha256,
});
async function drain() {
  for (let i = 0; i < 30; i++) {
    const batch = await worker.processBatch(fixture.tenantId);
    expect(batch.failed).toBe(0);
    if (!batch.claimed) return;
    if (batch.deferred)
      await withTenant(databases.owner, fixture.tenantId, (tx) =>
        tx
          .updateTable('outbox')
          .set({ available_at: sql`clock_timestamp()` })
          .where('status', '=', 'pending')
          .execute(),
      );
  }
  throw new Error('Projection outbox did not drain');
}

describe('transactional message attachments and fixed Task Artifact evidence', () => {
  it('persists one fixed same-scope attachment across retries and projects it through snapshots', async () => {
    const conversation = await group();
    const content = await ready({ conversation_id: conversation.id });
    const token = key();
    const message = await send(conversation.id, content.id, token);
    expect((await send(conversation.id, content.id, token)).id).toBe(message.id);
    expect(message.attachment_ids).toEqual([content.id]);
    expect(
      (await messaging.listMessages(fixture.bob, conversation.id)).items[0]?.attachment_ids,
    ).toEqual([content.id]);
    const links = await withTenant(databases.db, fixture.tenantId, (tx) =>
      sql<{
        resource_version: string;
      }>`select resource_version from message_resources where message_id=${message.id}`.execute(tx),
    );
    expect(links.rows).toEqual([{ resource_version: '1' }]);
    await drain();
    const snapshot = await sync.snapshot(fixture.bob, conversation.id);
    expect(
      snapshot.items.find((item) => item.entity.id === message.id)?.payload.message?.attachment_ids,
    ).toEqual([content.id]);
  });
  it('does not disclose another readable conversation or Task resource by attaching its ID', async () => {
    const source = await group();
    const target = await group();
    const content = await ready({ conversation_id: source.id });
    await expect(send(target.id, content.id)).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    const work = await task();
    const taskContent = await ready({ task_id: work.id });
    await expect(send(target.id, taskContent.id)).rejects.toMatchObject({
      code: 'DISCLOSURE_DENIED',
    });
    expect((await messaging.listMessages(fixture.alice, target.id)).items).toHaveLength(0);
    await expect(
      messaging.createMessage(
        fixture.alice,
        source.id,
        { client_message_id: key(), body: 'duplicates', attachment_ids: [content.id, content.id] },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('invalidates old snapshots immediately on source deletion and emits an attachment-free replacement', async () => {
    const conversation = await group();
    const content = await ready({ conversation_id: conversation.id });
    const message = await send(conversation.id, content.id);
    await drain();
    const before = await sync.snapshot(fixture.bob, conversation.id, { limit: 1 });
    expect(before.next_cursor).toBeDefined();
    await resources.deleteResource(fixture.alice, content.id, content.version, key());
    await expect(
      sync.snapshot(fixture.bob, conversation.id, { cursor: before.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      sync.events(fixture.bob, conversation.id, { cursor: before.cursor }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    expect(
      (await messaging.listMessages(fixture.bob, conversation.id)).items[0]?.attachment_ids,
    ).toEqual([]);
    const fresh = await sync.snapshot(fixture.bob, conversation.id);
    expect(JSON.stringify(fresh)).not.toContain(content.id);
    await drain();
    const updates = await sync.events(fixture.bob, conversation.id, { cursor: fresh.cursor });
    expect(
      updates.items.find((item) => item.entity.id === message.id)?.payload.message?.attachment_ids,
    ).toEqual([]);
    await expect(resources.getResource(fixture.bob, content.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('allows only an explicit new message to disclose an older same-conversation upload to a new member', async () => {
    let conversation = await group('since_join');
    const content = await ready({ conversation_id: conversation.id });
    conversation = await messaging.changeMember(
      fixture.alice,
      conversation.id,
      fixture.charlie.principalId,
      'add',
      conversation.version,
      key(),
    );
    await expect(resources.getResource(fixture.charlie, content.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      (await resources.listResources(fixture.charlie, { conversation_id: conversation.id })).items,
    ).toEqual([]);
    await send(conversation.id, content.id);
    expect((await resources.getResource(fixture.charlie, content.id)).id).toBe(content.id);
    expect(
      (
        await resources.listResources(fixture.charlie, { conversation_id: conversation.id })
      ).items.map((r) => r.id),
    ).toEqual([content.id]);
  });
  it('keeps the submitted Artifact version fixed when its head changes and refuses deleted-source acceptance', async () => {
    let work = await task();
    work = await tasks.changeState(
      fixture.alice,
      work.id,
      { state: 'active' },
      work.version,
      key(),
    );
    const first = await ready({ task_id: work.id }, 'Evidence version one');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Report' },
      key(),
    );
    const submitted = await tasks.submit(
      fixture.alice,
      work.id,
      {
        goal_version: work.goal_version,
        summary: 'Review fixed v1',
        evidence: [evidence(artifact)],
      },
      work.version,
      key(),
    );
    const second = await ready({ task_id: work.id }, 'Evidence version two');
    const changed = await resources.createArtifactVersion(
      fixture.alice,
      artifact.id,
      { resource_id: second.id },
      artifact.version,
      key(),
    );
    expect(changed.head_version).toBe('2');
    expect((await tasks.submissions(fixture.alice, work.id)).items[0]?.evidence).toEqual([
      evidence(artifact),
    ]);
    await resources.deleteResource(fixture.alice, first.id, first.version, key());
    await expect(tasks.submissions(fixture.alice, work.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    work = await tasks.getTask(fixture.alice, work.id);
    await expect(
      tasks.review(
        fixture.alice,
        work.id,
        {
          submission_id: submitted.id,
          decision: 'accept',
          comment: 'Cannot accept removed evidence',
        },
        work.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await tasks.getTask(fixture.alice, work.id)).status).toBe('in_review');
    const returned = await tasks.review(
      fixture.alice,
      work.id,
      { submission_id: submitted.id, decision: 'return', comment: 'Replace the removed evidence' },
      work.version,
      key(),
    );
    expect(returned.decision).toBe('return');
    expect((await tasks.getTask(fixture.alice, work.id)).status).toBe('active');
  });
  it('requires the exact Task and SHA-256, even when the submitter can read both Tasks', async () => {
    const source = await task();
    let target = await task();
    target = await tasks.changeState(
      fixture.alice,
      target.id,
      { state: 'active' },
      target.version,
      key(),
    );
    const content = await ready({ task_id: source.id });
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: content.id, title: 'Private source' },
      key(),
    );
    await expect(
      tasks.submit(
        fixture.alice,
        target.id,
        {
          goal_version: target.goal_version,
          summary: 'Cross Task',
          evidence: [evidence(artifact)],
        },
        target.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    const local = await ready({ task_id: target.id });
    const localArtifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: local.id, title: 'Local source' },
      key(),
    );
    await expect(
      tasks.submit(
        fixture.alice,
        target.id,
        {
          goal_version: target.goal_version,
          summary: 'Wrong hash',
          evidence: [{ ...evidence(localArtifact), sha256: '0'.repeat(64) }],
        },
        target.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('filters discovery before paging and binds cursors to the current reader and scope generation', async () => {
    let conversation = await group();
    for (let i = 0; i < 3; i++) {
      const content = await ready({ conversation_id: conversation.id }, `Listing ${i}`);
      await resources.createArtifact(
        fixture.alice,
        { resource_id: content.id, title: `Report ${i}` },
        key(),
      );
    }
    const page = await resources.listResources(fixture.bob, {
      conversation_id: conversation.id,
      limit: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeDefined();
    const next = await resources.listResources(fixture.bob, {
      conversation_id: conversation.id,
      cursor: page.next_cursor!,
      limit: 1,
    });
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    await expect(
      resources.listResources(fixture.alice, {
        conversation_id: conversation.id,
        cursor: page.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    const artifacts = await resources.listArtifacts(fixture.bob, {
      conversation_id: conversation.id,
      limit: 1,
    });
    expect(artifacts.next_cursor).toBeDefined();
    conversation = await messaging.changeMember(
      fixture.alice,
      conversation.id,
      fixture.bob.principalId,
      'remove',
      conversation.version,
      key(),
    );
    await messaging.changeMember(
      fixture.alice,
      conversation.id,
      fixture.bob.principalId,
      'add',
      conversation.version,
      key(),
    );
    await expect(
      resources.listResources(fixture.bob, {
        conversation_id: conversation.id,
        cursor: page.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      resources.listArtifacts(fixture.bob, {
        conversation_id: conversation.id,
        cursor: artifacts.next_cursor!,
      }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
  });
});
