import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createArtifactCollaborationService,
  createResourceService,
  createS3ObjectStore,
  type ArtifactCollaborationService,
  type ResourceService,
} from '@imbox/resources';
import { knowledgeResourceIndex } from '@imbox/knowledge';
import {
  createMessagingService,
  createFilePolicyLedger,
  replayPolicyLedger,
  type MessagingService,
  type PolicyLedger,
} from '@imbox/application';
import { createIdentityService, registerAuthRoutes } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerArtifactCollaborationRoutes } from '../../apps/api/src/artifact-collaboration-routes.js';
const secret = 'artifact-collaboration-test-secret-longer-than-thirty-two-bytes';
const key = () => randomUUID();
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
let resources: ResourceService;
let collaboration: ArtifactCollaborationService;
let messaging: MessagingService;
let directory: string;
let ledger: PolicyLedger;
beforeAll(async () => {
  databases = await testDatabases();
  await admin.ensureDevelopmentBucket('test');
  directory = await mkdtemp(join(tmpdir(), 'imbox-artifact-policy-'));
  ledger = await createFilePolicyLedger({ directory, signingKey: secret });
});
afterAll(async () => {
  store.destroy();
  admin.destroy();
  await databases?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  resources = createResourceService({
    db: databases.db,
    store,
    cursorSecret: secret,
    textIndex: knowledgeResourceIndex(),
    policyLedger: ledger,
  });
  collaboration = createArtifactCollaborationService({
    db: databases.db,
    store,
    cursorSecret: secret,
    policyLedger: ledger,
  });
  messaging = createMessagingService(databases.db, secret);
});
const group = (member = fixture.charlie.principalId) =>
  messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      title: 'Source or target scope',
      kind: 'group',
      member_ids: [member],
      history_policy: 'all',
    },
    key(),
  );
async function artifact(
  conversationId: string,
  body = '你好😀 world: fixed source with explicit sharing',
) {
  const bytes = Buffer.from(body);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await resources.createUpload(
    fixture.alice,
    {
      conversation_id: conversationId,
      filename: 'collaboration.md',
      content_type: 'text/markdown',
      byte_size: bytes.byteLength,
      sha256,
    },
    key(),
  );
  expect(
    (await fetch(upload.upload_url, { method: 'PUT', headers: upload.upload_headers, body: bytes }))
      .status,
  ).toBe(200);
  const content = await resources.completeUpload(fixture.alice, upload.id, key());
  return resources.createArtifact(
    fixture.alice,
    { resource_id: content.id, title: 'Reviewed Artifact' },
    key(),
  );
}
const shareInput = (a: Awaited<ReturnType<typeof artifact>>) => ({
  version_id: a.version_id,
  sha256: a.resource.sha256,
  recipient_principal_id: fixture.bob.principalId,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
});
describe('version-anchored Artifact comments and bounded explicit sharing', () => {
  it('fixes comments to the selected version/hash and validates Unicode scalar anchors without moving them on edit', async () => {
    const chat = await group(fixture.bob.principalId);
    const a = await artifact(chat.id);
    const token = key();
    const input = {
      version_id: a.version_id,
      sha256: a.resource.sha256,
      anchor: { type: 'text_range' as const, start: 2, end: 3 },
      body: 'This comment addresses the emoji character.',
    };
    const comment = await collaboration.createComment(fixture.bob, a.id, input, token);
    expect((await collaboration.createComment(fixture.bob, a.id, input, token)).id).toBe(
      comment.id,
    );
    await expect(
      collaboration.createComment(
        fixture.bob,
        a.id,
        { ...input, anchor: { type: 'text_range', start: 0, end: 10000 } },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      collaboration.createComment(fixture.bob, a.id, { ...input, sha256: '0'.repeat(64) }, key()),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const edited = await collaboration.editComment(
      fixture.bob,
      comment.id,
      'Clarified comment',
      comment.version,
      key(),
    );
    expect(edited.anchor).toEqual(input.anchor);
    expect(edited.version).toBe('2');
    await expect(
      collaboration.editComment(
        fixture.alice,
        comment.id,
        'Cannot impersonate the author',
        edited.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      withTenant(databases.owner, fixture.tenantId, (tx) =>
        sql`update artifact_comments set anchor='{"type":"whole"}'::jsonb where id=${comment.id}`.execute(
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const replacement = await artifact(chat.id, 'Completely different version');
    await resources.createArtifactVersion(
      fixture.alice,
      a.id,
      { resource_id: replacement.resource.id },
      a.version,
      key(),
    );
    expect(
      (await collaboration.listComments(fixture.bob, a.id, { version_id: a.version_id })).items[0]
        ?.version_id,
    ).toBe(a.version_id);
    await collaboration.deleteComment(fixture.bob, comment.id, edited.version, key());
    expect(
      (await collaboration.listComments(fixture.bob, a.id, { version_id: a.version_id })).items[0],
    ).toMatchObject({ deleted: true, body: '' });
    expect(
      (await ledger.records(fixture.tenantId)).some(
        (r) => r.kind === 'deletion.artifact_comment' && r.target_id === comment.id,
      ),
    ).toBe(true);
  });
  it('lets the explicitly named recipient read only the share while leaving source ACL and other recipients unchanged', async () => {
    const chat = await group();
    const a = await artifact(chat.id);
    await expect(resources.getResource(fixture.bob, a.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const shared = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    expect(shared.download_path).toBe(`/v1/artifact-shares/${shared.id}/content`);
    expect((await collaboration.getShare(fixture.bob, shared.id)).version_id).toBe(a.version_id);
    await expect(collaboration.getShare(fixture.charlie, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(resources.getResource(fixture.bob, a.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(resources.getArtifact(fixture.bob, a.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      collaboration.listComments(fixture.bob, a.id, { version_id: a.version_id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const download = await collaboration.openShareDownload(fixture.bob, shared.id);
    const chunks = [];
    for await (const bytes of download.chunks()) chunks.push(bytes);
    expect(Buffer.concat(chunks).toString()).toContain('fixed source with explicit sharing');
    const other = await tenantFixture(databases.owner);
    await expect(collaboration.getShare(other.alice, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await collaboration.listShares(fixture.alice, a.id)).items.map((r) => r.id)).toEqual([
      shared.id,
    ]);
    expect((await collaboration.listShares(fixture.bob, a.id)).items).toEqual([]);
  });
  it('requires original ownership plus live source and recipient fences, including removal and re-add', async () => {
    const chat = await group();
    const a = await artifact(chat.id);
    const copied = await resources.createArtifact(
      fixture.charlie,
      { resource_id: a.resource.id, title: 'Another readable wrapper' },
      key(),
    );
    await expect(
      collaboration.createShare(
        fixture.charlie,
        copied.id,
        shareInput({ ...a, id: copied.id, version_id: copied.version_id }),
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
    const shared = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await tx
        .updateTable('memberships')
        .set({ status: 'disabled', version: sql`version+1` })
        .where('workspace_id', '=', fixture.workspaceId)
        .where('principal_id', '=', fixture.alice.principalId)
        .execute();
    });
    await expect(collaboration.getShare(fixture.bob, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('memberships')
        .set({ status: 'active', version: sql`version+1` })
        .where('workspace_id', '=', fixture.workspaceId)
        .where('principal_id', '=', fixture.alice.principalId)
        .execute(),
    );
    await expect(collaboration.getShare(fixture.bob, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const next = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    await databases.owner
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', fixture.bob.principalId)
      .execute();
    await databases.owner
      .updateTable('principals')
      .set({ status: 'active', version: sql`version+1` })
      .where('id', '=', fixture.bob.principalId)
      .execute();
    await expect(collaboration.getShare(fixture.bob, next.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('binds a group disclosure to its current audience generation and does not automatically extend it to a new member', async () => {
    const source = await group();
    const target = await group(fixture.bob.principalId);
    const a = await artifact(source.id);
    const shared = await collaboration.createShare(
      fixture.alice,
      a.id,
      {
        version_id: a.version_id,
        sha256: a.resource.sha256,
        conversation_id: target.id,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      key(),
    );
    expect((await collaboration.getShare(fixture.bob, shared.id)).id).toBe(shared.id);
    await messaging.changeMember(
      fixture.alice,
      target.id,
      fixture.charlie.principalId,
      'add',
      target.version,
      key(),
    );
    await expect(collaboration.getShare(fixture.bob, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(collaboration.getShare(fixture.charlie, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('stops an in-flight shared download after revoke and denies expired or deleted-source grants', async () => {
    const source = await group();
    const a = await artifact(source.id, 'a'.repeat(200000));
    const shared = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    const download = await collaboration.openShareDownload(fixture.bob, shared.id);
    const iterator = download.chunks();
    expect((await iterator.next()).value!.byteLength).toBeLessThanOrEqual(65536);
    await collaboration.revokeShare(fixture.alice, shared.id, shared.version, key());
    await expect(iterator.next()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await ledger.records(fixture.tenantId)).some(
        (r) => r.kind === 'revocation.artifact_share' && r.target_id === shared.id,
      ),
    ).toBe(true);
    await expect(
      collaboration.createShare(
        fixture.alice,
        a.id,
        { ...shareInput(a), expires_at: new Date(Date.now() + 25 * 3600000).toISOString() },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const expiring = await collaboration.createShare(
      fixture.alice,
      a.id,
      { ...shareInput(a), expires_at: new Date(Date.now() + 1000).toISOString() },
      key(),
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(collaboration.getShare(fixture.bob, expiring.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const next = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    await resources.deleteResource(fixture.alice, a.resource.id, a.resource.version, key());
    await expect(collaboration.getShare(fixture.bob, next.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('replays independent share revocation and comment deletion after a simulated database restore', async () => {
    const source = await group();
    const a = await artifact(source.id);
    const shared = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    const comment = await collaboration.createComment(
      fixture.alice,
      a.id,
      {
        version_id: a.version_id,
        sha256: a.resource.sha256,
        anchor: { type: 'whole' },
        body: 'Delete this excerpt permanently',
      },
      key(),
    );
    const snapshot = (
      await withTenant(databases.owner, fixture.tenantId, (tx) =>
        sql<Record<string, unknown>>`select * from artifact_shares where id=${shared.id}`.execute(
          tx,
        ),
      )
    ).rows[0]!;
    await collaboration.revokeShare(fixture.alice, shared.id, shared.version, key());
    await collaboration.deleteComment(fixture.alice, comment.id, comment.version, key());
    await withTenant(databases.owner, fixture.tenantId, async (tx) => {
      await sql`delete from artifact_shares where id=${shared.id}`.execute(tx);
      await sql`insert into artifact_shares select * from jsonb_populate_record(null::artifact_shares,${JSON.stringify(snapshot)}::jsonb)`.execute(
        tx,
      );
      await sql`update artifact_comments set body=${comment.body},deleted_at=null,version=${comment.version} where id=${comment.id}`.execute(
        tx,
      );
      await sql`delete from policy_receipts where target_id in(${shared.id},${comment.id})`.execute(
        tx,
      );
    });
    expect((await collaboration.getShare(fixture.bob, shared.id)).id).toBe(shared.id);
    expect(await replayPolicyLedger(databases.db, ledger, fixture.tenantId)).toEqual({
      applied: 2,
    });
    await expect(collaboration.getShare(fixture.bob, shared.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      (await collaboration.listComments(fixture.alice, a.id, { version_id: a.version_id })).items[0]
        ?.body,
    ).toBe('');
  });
  it('authenticates share HTTP downloads and never redirects to storage or returns the underlying resource locator', async () => {
    const source = await group();
    const a = await artifact(source.id);
    const shared = await collaboration.createShare(fixture.alice, a.id, shareInput(a), key());
    const origin = 'http://artifact-sharing.test';
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.bob.principalId],
    });
    const app = createApp({ readiness: async () => {} });
    app.register(async (scope) => {
      await registerAuthRoutes(scope, { identity });
      registerArtifactCollaborationRoutes(scope, { identity, collaboration });
    });
    await app.ready();
    try {
      const session = await identity.devLogin({ principalId: fixture.bob.principalId, origin });
      const headers = {
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
      };
      const result = await app.inject({
        method: 'GET',
        url: `/v1/artifact-shares/${shared.id}`,
        headers,
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).not.toContain(`/v1/resources/${a.resource.id}`);
      const bytes = await app.inject({ method: 'GET', url: shared.download_path, headers });
      expect(bytes.statusCode, bytes.body).toBe(200);
      expect(bytes.headers['x-content-type-options']).toBe('nosniff');
      expect(bytes.headers['cache-control']).toContain('no-store');
      expect(bytes.headers.location).toBeUndefined();
      expect((await app.inject({ method: 'GET', url: shared.download_path })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
