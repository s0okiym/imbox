import { requiredActionsClosed } from '@imbox/actions';
import { runtimeCompletionGate } from '@imbox/runtime';
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
  tasks = createTaskService(databases.db, secret, {
    artifacts: hooks.artifacts,
    requiredActionsClosed: async (tx, id) =>
      (await runtimeCompletionGate(tx, id)) && (await requiredActionsClosed(tx, id)),
  });
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
  auth = fixture.alice,
) {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ticket = await resources.createUpload(
    auth,
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
  return resources.completeUpload(auth, ticket.id, key());
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
  it('allows current task contributors to append with explicit authorship, rejects stale competing edits and fences demotion', async () => {
    let work = await task();
    work = await tasks.changeParticipant(
      fixture.alice,
      work.id,
      fixture.bob.principalId,
      'contributor',
      work.version,
      key(),
    );
    work = await tasks.changeParticipant(
      fixture.alice,
      work.id,
      fixture.charlie.principalId,
      'reviewer',
      work.version,
      key(),
    );
    const first = await ready({ task_id: work.id }, 'Original');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Shared task output' },
      key(),
    );
    expect((await resources.getArtifact(fixture.bob, artifact.id)).can_append_version).toBe(true);
    expect((await resources.getArtifact(fixture.charlie, artifact.id)).can_append_version).toBe(
      false,
    );
    const bobContent = await ready({ task_id: work.id }, 'Bob contribution', fixture.bob);
    await expect(
      resources.createArtifactVersion(
        fixture.charlie,
        artifact.id,
        { resource_id: bobContent.id },
        artifact.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const bobKey = key();
    const updated = await resources.createArtifactVersion(
      fixture.bob,
      artifact.id,
      { resource_id: bobContent.id },
      artifact.version,
      bobKey,
    );
    expect(updated.created_by).toBe(fixture.alice.principalId);
    const versions = await resources.listArtifactVersions(fixture.alice, artifact.id);
    expect(versions.items.at(-1)).toMatchObject({
      created_by: fixture.bob.principalId,
      resource: { sha256: bobContent.sha256 },
    });
    const aliceContent = await ready({ task_id: work.id }, 'Alice racing update');
    const bobNext = await ready({ task_id: work.id }, 'Bob racing update', fixture.bob);
    const results = await Promise.allSettled([
      resources.createArtifactVersion(
        fixture.alice,
        artifact.id,
        { resource_id: aliceContent.id },
        updated.version,
        key(),
      ),
      resources.createArtifactVersion(
        fixture.bob,
        artifact.id,
        { resource_id: bobNext.id },
        updated.version,
        key(),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    const current = await resources.getArtifact(fixture.alice, artifact.id);
    expect(current.head_version).toBe('3');
    await tasks.changeParticipant(
      fixture.alice,
      work.id,
      fixture.bob.principalId,
      'observer',
      work.version,
      key(),
    );
    expect((await resources.getArtifact(fixture.bob, artifact.id)).can_append_version).toBe(false);
    await expect(
      resources.createArtifactVersion(
        fixture.bob,
        artifact.id,
        { resource_id: bobContent.id },
        artifact.version,
        bobKey,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      resources.createArtifactVersion(
        fixture.bob,
        artifact.id,
        { resource_id: bobNext.id },
        current.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await resources.listArtifactVersions(fixture.alice, artifact.id)).items).toHaveLength(
      3,
    );
  });
  it('preserves a contributor branch independently and merges resolved bytes once against the explicit current head', async () => {
    let work = await task();
    work = await tasks.changeParticipant(
      fixture.alice,
      work.id,
      fixture.bob.principalId,
      'contributor',
      work.version,
      key(),
    );
    const original = await ready({ task_id: work.id }, 'Base content');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: original.id, title: 'Branched output' },
      key(),
    );
    const draft = await ready({ task_id: work.id }, 'Bob conflicting content', fixture.bob);
    const branchKey = key();
    const input = { base_version_id: artifact.version_id, resource_id: draft.id };
    const branch = await resources.createArtifactBranch(fixture.bob, artifact.id, input, branchKey);
    expect(
      (await resources.createArtifactBranch(fixture.bob, artifact.id, input, branchKey)).id,
    ).toBe(branch.id);
    expect((await resources.getArtifact(fixture.alice, artifact.id)).head_version).toBe('1');
    const updatedContent = await ready({ task_id: work.id }, 'Alice concurrent content');
    const updated = await resources.createArtifactVersion(
      fixture.alice,
      artifact.id,
      { resource_id: updatedContent.id },
      artifact.version,
      key(),
    );
    const resolved = await ready(
      { task_id: work.id },
      'Explicitly reconciled Alice and Bob changes',
    );
    const mergeInput = { branch_id: branch.id, resource_id: resolved.id };
    await expect(
      resources.mergeArtifactBranch(
        fixture.alice,
        artifact.id,
        mergeInput,
        artifact.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await resources.listArtifactBranches(fixture.bob, artifact.id)).items[0]).toMatchObject(
      { status: 'open', base_version_id: artifact.version_id, resource: { sha256: draft.sha256 } },
    );
    const mergeKey = key();
    const merged = await resources.mergeArtifactBranch(
      fixture.alice,
      artifact.id,
      mergeInput,
      updated.version,
      mergeKey,
    );
    expect(merged).toMatchObject({ head_version: '3', resource: { sha256: resolved.sha256 } });
    expect(
      (
        await resources.mergeArtifactBranch(
          fixture.alice,
          artifact.id,
          mergeInput,
          updated.version,
          mergeKey,
        )
      ).head_version,
    ).toBe('3');
    expect((await resources.listArtifactBranches(fixture.bob, artifact.id)).items[0]).toMatchObject(
      {
        status: 'merged',
        base_version_id: artifact.version_id,
        merged_against_version_id: updated.version_id,
        merged_version_id: merged.version_id,
        created_by: fixture.bob.principalId,
        merged_by: fixture.alice.principalId,
        resource: { sha256: draft.sha256 },
      },
    );
    await expect(
      resources.mergeArtifactBranch(fixture.alice, artifact.id, mergeInput, merged.version, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await resources.listArtifactVersions(fixture.alice, artifact.id)).items).toHaveLength(
      3,
    );
    await expect(
      withTenant(databases.owner, fixture.tenantId, (tx) =>
        sql`update artifact_branches set resource_id=${resolved.id} where id=${branch.id}`.execute(
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await tasks.changeParticipant(
      fixture.alice,
      work.id,
      fixture.bob.principalId,
      'observer',
      work.version,
      key(),
    );
    await expect(
      resources.createArtifactBranch(fixture.bob, artifact.id, input, branchKey),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serializes competing branch merges, rejects foreign bases and paginates only currently visible drafts', async () => {
    const work = await task();
    const first = await ready({ task_id: work.id });
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Merge competition' },
      key(),
    );
    const other = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Separate artifact' },
      key(),
    );
    await expect(
      resources.createArtifactBranch(
        fixture.alice,
        artifact.id,
        { base_version_id: other.version_id, resource_id: first.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const drafts = await Promise.all(
      ['left', 'right'].map(async (body) => {
        const content = await ready({ task_id: work.id }, body);
        return resources.createArtifactBranch(
          fixture.alice,
          artifact.id,
          { base_version_id: artifact.version_id, resource_id: content.id },
          key(),
        );
      }),
    );
    const page = await resources.listArtifactBranches(fixture.alice, artifact.id, { limit: 1 });
    expect(page.next_cursor).toBeDefined();
    expect(
      (
        await resources.listArtifactBranches(fixture.alice, artifact.id, {
          cursor: page.next_cursor!,
        })
      ).items,
    ).toHaveLength(1);
    const results = await Promise.allSettled(
      drafts.map((branch) =>
        resources.mergeArtifactBranch(
          fixture.alice,
          artifact.id,
          { branch_id: branch.id, resource_id: branch.resource.id },
          artifact.version,
          key(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'VERSION_CONFLICT' },
    });
    const rows = (await resources.listArtifactBranches(fixture.alice, artifact.id)).items;
    expect(rows.filter((r) => r.status === 'open')).toHaveLength(1);
    const open = rows.find((r) => r.status === 'open')!;
    await resources.deleteResource(fixture.alice, open.resource.id, open.resource.version, key());
    expect((await resources.listArtifactBranches(fixture.alice, artifact.id)).items).toHaveLength(
      1,
    );
    const head = await resources.getArtifact(fixture.alice, artifact.id);
    await expect(
      resources.mergeArtifactBranch(
        fixture.alice,
        artifact.id,
        { branch_id: open.id, resource_id: first.id },
        head.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('bounds live branch drafts and frees capacity after their resource is tombstoned', async () => {
    const work = await task();
    const original = await ready({ task_id: work.id });
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: original.id, title: 'Bounded drafts' },
      key(),
    );
    const content = await ready({ task_id: work.id }, 'Shared draft bytes');
    const input = { base_version_id: artifact.version_id, resource_id: content.id };
    for (let i = 0; i < 200; i++)
      await resources.createArtifactBranch(fixture.alice, artifact.id, input, key());
    await expect(
      resources.createArtifactBranch(fixture.alice, artifact.id, input, key()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const other = await tenantFixture(databases.owner);
    expect(
      (
        await withTenant(databases.db, other.tenantId, (tx) =>
          sql`select id from artifact_branches`.execute(tx),
        )
      ).rows,
    ).toHaveLength(0);
    await resources.deleteResource(fixture.alice, content.id, content.version, key());
    expect((await resources.listArtifactBranches(fixture.alice, artifact.id)).items).toHaveLength(
      0,
    );
    const replacement = await ready({ task_id: work.id }, 'New live draft');
    expect(
      await resources.createArtifactBranch(
        fixture.alice,
        artifact.id,
        { ...input, resource_id: replacement.id },
        key(),
      ),
    ).toMatchObject({ status: 'open' });
  }, 60000);
  it('keeps conversation artifacts creator-only even for another conversation writer', async () => {
    const chat = await group();
    const content = await ready({ conversation_id: chat.id });
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: content.id, title: 'Creator-owned output' },
      key(),
    );
    expect((await resources.getArtifact(fixture.bob, artifact.id)).can_append_version).toBe(false);
    await expect(
      resources.createArtifactVersion(
        fixture.bob,
        artifact.id,
        { resource_id: content.id },
        artifact.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('serializes competing Artifact versions without replacing the evidence already submitted to two reviewers', async () => {
    let work = await tasks.createTask(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        title: 'Concurrent fixed evidence',
        goal: 'Review exactly the submitted bytes',
        acceptance_criteria: ['Fixed hash and version'],
        reviewer_principal_ids: [fixture.bob.principalId, fixture.charlie.principalId],
        budget: { currency: 'USD', limit_microunits: '1000000' },
      },
      key(),
    );
    work = await tasks.changeState(
      fixture.alice,
      work.id,
      { state: 'active' },
      work.version,
      key(),
    );
    const first = await ready({ task_id: work.id }, 'Submitted immutable source');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Fixed report' },
      key(),
    );
    const submitted = await tasks.submit(
      fixture.alice,
      work.id,
      {
        goal_version: work.goal_version,
        summary: 'Review v1 only',
        evidence: [evidence(artifact)],
      },
      work.version,
      key(),
    );
    const second = await ready({ task_id: work.id }, 'Competing candidate two');
    const third = await ready({ task_id: work.id }, 'Competing candidate three');
    const changed = await Promise.allSettled(
      [second, third].map((content) =>
        resources.createArtifactVersion(
          fixture.alice,
          artifact.id,
          { resource_id: content.id },
          artifact.version,
          key(),
        ),
      ),
    );
    expect(changed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = changed.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('VERSION_CONFLICT');
    expect((await resources.getArtifact(fixture.bob, artifact.id)).head_version).toBe('2');
    for (const reviewer of [fixture.bob, fixture.charlie]) {
      expect((await tasks.submissions(reviewer, work.id)).items[0]?.evidence).toEqual([
        evidence(artifact),
      ]);
    }
    work = await tasks.getTask(fixture.bob, work.id);
    const reviewed = await tasks.review(
      fixture.bob,
      work.id,
      {
        submission_id: submitted.id,
        decision: 'accept',
        comment: 'Accept original v1, not current head',
      },
      work.version,
      key(),
    );
    expect(reviewed.submission_id).toBe(submitted.id);
    expect((await tasks.getTask(fixture.bob, work.id)).status).toBe('completed');
    expect((await tasks.submissions(fixture.charlie, work.id)).items[0]?.evidence).toEqual([
      evidence(artifact),
    ]);
  });

  it('commits exactly one reviewer decision while an Artifact head update races with acceptance', async () => {
    let work = await tasks.createTask(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        title: 'Concurrent acceptance',
        goal: 'Keep fixed evidence during acceptance',
        acceptance_criteria: ['One review and immutable evidence'],
        reviewer_principal_ids: [fixture.bob.principalId, fixture.charlie.principalId],
        budget: { currency: 'USD', limit_microunits: '1000000' },
      },
      key(),
    );
    work = await tasks.changeState(
      fixture.alice,
      work.id,
      { state: 'active' },
      work.version,
      key(),
    );
    const first = await ready({ task_id: work.id }, 'The only submitted evidence');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: first.id, title: 'Racing report' },
      key(),
    );
    const second = await ready({ task_id: work.id }, 'Unsubmitted future head');
    const submitted = await tasks.submit(
      fixture.alice,
      work.id,
      {
        goal_version: work.goal_version,
        summary: 'Fixed evidence acceptance',
        evidence: [evidence(artifact)],
      },
      work.version,
      key(),
    );
    work = await tasks.getTask(fixture.alice, work.id);
    const reviewKeys = [key(), key()];
    const input = {
      submission_id: submitted.id,
      decision: 'accept' as const,
      comment: 'Accept submitted v1',
    };
    const results = await Promise.allSettled([
      resources.createArtifactVersion(
        fixture.alice,
        artifact.id,
        { resource_id: second.id },
        artifact.version,
        key(),
      ),
      tasks.review(fixture.bob, work.id, input, work.version, reviewKeys[0]!),
      tasks.review(fixture.charlie, work.id, input, work.version, reviewKeys[1]!),
    ]);
    const reviews = results.slice(1);
    expect(reviews.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    if (results[0]?.status === 'rejected') expect(results[0].reason.code).toBe('VERSION_CONFLICT');
    for (const result of reviews)
      if (result.status === 'rejected') expect(result.reason.code).toBe('TASK_TERMINATED');
    const winner = reviews.findIndex((r) => r.status === 'fulfilled');
    const actor = [fixture.bob, fixture.charlie][winner]!;
    const retry = await tasks.review(actor, work.id, input, work.version, reviewKeys[winner]!);
    const persisted = await tasks.reviews(actor, work.id);
    expect(persisted.items).toHaveLength(1);
    expect(persisted.items[0]?.id).toBe(retry.id);
    expect(persisted.items[0]?.submission_id).toBe(submitted.id);
    const finalTask = await tasks.getTask(actor, work.id);
    expect(finalTask.status).toBe('completed');
    expect(finalTask.version).toBe(String(BigInt(work.version) + 1n));
    expect((await tasks.submissions(actor, work.id)).items[0]?.evidence).toEqual([
      evidence(artifact),
    ]);
    const head = await resources.getArtifact(actor, artifact.id);
    expect(head.head_version).toBe(results[0]?.status === 'fulfilled' ? '2' : '1');
    const counts = await withTenant(
      databases.db,
      fixture.tenantId,
      async (tx) =>
        (
          await sql<{
            n: string;
          }>`select count(*)::text as n from domain_events where aggregate_id=${work.id} and event_type='task.reviewed'`.execute(
            tx,
          )
        ).rows[0]!,
    );
    expect(counts.n).toBe('1');
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
