import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createResourceService,
  createS3ObjectStore,
  createResourceCleanup,
  scanRestrictedText,
  type ResourceService,
} from '@imbox/resources';
import { createMessagingService, type MessagingService } from '@imbox/application';
import { createIdentityService, registerAuthRoutes } from '@imbox/auth';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerResourceRoutes } from '../../apps/api/src/resource-routes.js';
const endpoint = process.env['TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:18333';
const bucket = 'imbox-resources-test';
const secret = 'resources-test-cursor-secret-at-least-thirty-two-bytes';
const key = () => randomUUID();
const store = createS3ObjectStore({
  endpoint,
  region: 'us-east-1',
  bucket,
  accessKeyId: 'imbox_local_s3_app',
  secretAccessKey: 'imbox_local_s3_app_secret',
});
const admin = createS3ObjectStore({
  endpoint,
  region: 'us-east-1',
  bucket,
  accessKeyId: 'imbox_local_s3_admin',
  secretAccessKey: 'imbox_local_s3_admin_secret',
});
let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let resources: ResourceService;
let messaging: MessagingService;
let chat: Awaited<ReturnType<MessagingService['createConversation']>>;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  databases = await testDatabases();
  await admin.ensureDevelopmentBucket('test');
  await admin.configureDevelopmentCors(['http://127.0.0.1:4173']);
});
afterAll(async () => {
  store.destroy();
  admin.destroy();
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
  resources = createResourceService({ db: databases.db, store, cursorSecret: secret });
  messaging = createMessagingService(databases.db, secret);
  chat = await messaging.createConversation(
    fixture.alice,
    {
      workspace_id: fixture.workspaceId,
      kind: 'group',
      title: 'Shared resources',
      member_ids: [fixture.bob.principalId],
      history_policy: 'all',
    },
    key(),
  );
});
async function upload(text = 'A verified text file', service = resources) {
  const bytes = Buffer.from(text);
  const ticket = await service.createUpload(
    fixture.alice,
    {
      conversation_id: chat.id,
      filename: 'report.md',
      content_type: 'text/markdown',
      byte_size: bytes.byteLength,
      sha256: digest(bytes),
    },
    key(),
  );
  const response = await fetch(ticket.upload_url, {
    method: 'PUT',
    headers: ticket.upload_headers,
    body: bytes,
  });
  expect(response.status, await response.text()).toBe(200);
  return { ticket, bytes };
}
async function ready(text?: string) {
  const value = await upload(text);
  return {
    ...value,
    resource: await resources.completeUpload(fixture.alice, value.ticket.id, key()),
  };
}

describe('real private S3 upload and authorization gateway', () => {
  it('allows browser PUT preflight only from the configured application origin', async () => {
    const request = (origin: string) =>
      fetch(`${endpoint}/${bucket}/staging/preflight`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'content-type',
        },
      });
    const allowed = await request('http://127.0.0.1:4173');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
    const denied = await request('https://untrusted.invalid');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('requires authenticated bucket access and verifies staged bytes before publishing immutable content', async () => {
    expect((await fetch(`${endpoint}/${bucket}`)).status).toBe(403);
    const { ticket, bytes, resource } = await ready();
    expect(resource.sha256).toBe(digest(bytes));
    expect(resource).not.toHaveProperty('object_key');
    expect(resource.download_path).toBe(`/v1/resources/${resource.id}/content`);
    const content = await resources.openDownload(fixture.bob, resource.id);
    const chunks = [];
    for await (const chunk of content.chunks()) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect((await resources.completeUpload(fixture.alice, ticket.id, key())).id).toBe(resource.id);
    const overwrite = await fetch(ticket.upload_url, {
      method: 'PUT',
      headers: ticket.upload_headers,
      body: bytes,
    });
    expect(overwrite.status).toBe(200);
    expect((await resources.getResource(fixture.bob, resource.id)).sha256).toBe(digest(bytes));
    await expect(store.head(`objects/${fixture.tenantId}/${ticket.id}`)).resolves.toHaveProperty(
      'ContentLength',
      bytes.byteLength,
    );
  });
  it('binds upload authorization to exact byte count/checksum and rejects oversized declarations', async () => {
    await expect(
      resources.createUpload(
        fixture.alice,
        {
          conversation_id: chat.id,
          filename: 'large.txt',
          content_type: 'text/plain',
          byte_size: 8388609,
          sha256: '0'.repeat(64),
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { ticket, bytes } = await upload();
    const tamper = await fetch(ticket.upload_url, {
      method: 'PUT',
      headers: ticket.upload_headers,
      body: Buffer.alloc(bytes.byteLength, 65),
    });
    expect(tamper.status).toBeGreaterThanOrEqual(400);
    // Even a privileged storage writer cannot bypass finalize's independent hash validation.
    const staged = `staging/${fixture.tenantId}/${ticket.id}`;
    await admin.delete(staged);
    await admin.putImmutable(
      staged,
      Buffer.alloc(bytes.byteLength, 66),
      'text/markdown',
      digest(Buffer.alloc(bytes.byteLength, 66)),
    );
    await expect(resources.completeUpload(fixture.alice, ticket.id, key())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(resources.getResource(fixture.alice, ticket.resource_id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('quarantines unsupported binary content, malformed JSON, and the EICAR test signature', async () => {
    await expect(
      resources.createUpload(
        fixture.alice,
        {
          conversation_id: chat.id,
          filename: 'program.exe',
          content_type: 'application/octet-stream',
          byte_size: 3,
          sha256: '0'.repeat(64),
        },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const unsafe = await upload('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
    await expect(
      resources.completeUpload(fixture.alice, unsafe.ticket.id, key()),
    ).rejects.toMatchObject({ code: 'CONTENT_REJECTED' });
    const bytes = Buffer.from('{invalid');
    const ticket = await resources.createUpload(
      fixture.alice,
      {
        conversation_id: chat.id,
        filename: 'bad.json',
        content_type: 'application/json',
        byte_size: bytes.byteLength,
        sha256: digest(bytes),
      },
      key(),
    );
    expect(
      (
        await fetch(ticket.upload_url, {
          method: 'PUT',
          headers: ticket.upload_headers,
          body: bytes,
        })
      ).status,
    ).toBe(200);
    await expect(resources.completeUpload(fixture.alice, ticket.id, key())).rejects.toMatchObject({
      code: 'CONTENT_REJECTED',
    });
  });
  it('rechecks current ACL after the storage/scan step and never publishes after revocation', async () => {
    let started!: () => void;
    let proceed!: () => void;
    const scanning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const gated = createResourceService({
      db: databases.db,
      store,
      cursorSecret: secret,
      scanner: async (bytes, type) => {
        started();
        await resume;
        return scanRestrictedText(bytes, type);
      },
    });
    const staged = await upload('Scan raced with revocation', gated);
    const completion = gated.completeUpload(fixture.alice, staged.ticket.id, key());
    const asserted = expect(completion).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await scanning;
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      tx
        .updateTable('memberships')
        .set({ status: 'disabled', version: sql`version+1` })
        .where('workspace_id', '=', fixture.workspaceId)
        .where('principal_id', '=', fixture.alice.principalId)
        .execute(),
    );
    proceed();
    await asserted;
    expect(
      (
        await withTenant(databases.db, fixture.tenantId, (tx) =>
          sql`select * from resources where id=${staged.ticket.resource_id}`.execute(tx),
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('stops a long download at the next 64 KiB boundary when access is revoked', async () => {
    const value = await ready('a'.repeat(200000));
    const download = await resources.openDownload(fixture.bob, value.resource.id);
    const iterator = download.chunks();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeLessThanOrEqual(65536);
    await messaging.changeMember(
      fixture.alice,
      chat.id,
      fixture.bob.principalId,
      'remove',
      chat.version,
      key(),
    );
    await expect(iterator.next()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(resources.openDownload(fixture.bob, value.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('enforces tenant isolation and from-join history for resource locators', async () => {
    const hidden = await messaging.createConversation(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        kind: 'group',
        title: 'Limited history',
        member_ids: [fixture.charlie.principalId],
        history_policy: 'since_join',
      },
      key(),
    );
    chat = hidden;
    const value = await ready();
    await messaging.changeMember(
      fixture.alice,
      chat.id,
      fixture.bob.principalId,
      'add',
      chat.version,
      key(),
    );
    await expect(resources.getResource(fixture.bob, value.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const other = await tenantFixture(databases.owner);
    await expect(resources.getResource(other.alice, value.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      (
        await withTenant(databases.db, other.tenantId, (tx) =>
          sql`select id from resources where id=${value.resource.id}`.execute(tx),
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('tombstones before physical deletion and retries persisted cleanup', async () => {
    const value = await ready();
    await resources.deleteResource(fixture.alice, value.resource.id, value.resource.version, key());
    await expect(resources.openDownload(fixture.alice, value.resource.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const failing = createResourceCleanup({
      db: databases.db,
      store: {
        ...store,
        delete: async () => {
          throw new Error('offline');
        },
      },
    });
    expect((await failing(fixture.tenantId)).deleted).toBe(0);
    expect(
      (await createResourceCleanup({ db: databases.db, store })(fixture.tenantId)).deleted,
    ).toBe(1);
    await expect(
      store.head(`objects/${fixture.tenantId}/${value.ticket.id}`),
    ).rejects.toHaveProperty('$metadata.httpStatusCode', 404);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update resource_uploads set expires_at=clock_timestamp()-interval '1 second' where id=${value.ticket.id}`.execute(
        tx,
      ),
    );
    await createResourceCleanup({ db: databases.db, store })(fixture.tenantId);
    await expect(
      store.head(`staging/${fixture.tenantId}/${value.ticket.id}`),
    ).rejects.toHaveProperty('$metadata.httpStatusCode', 404);
  });
});

describe('immutable Artifact versions and resource HTTP routes', () => {
  it('preserves every Artifact version, rejects cross-scope publication and binds pagination to the caller', async () => {
    const one = await ready('Version one');
    const artifact = await resources.createArtifact(
      fixture.alice,
      { resource_id: one.resource.id, title: 'Report' },
      key(),
    );
    const two = await ready('Version two');
    const next = await resources.createArtifactVersion(
      fixture.alice,
      artifact.id,
      { resource_id: two.resource.id },
      artifact.version,
      key(),
    );
    expect(next.head_version).toBe('2');
    const page = await resources.listArtifactVersions(fixture.bob, artifact.id, { limit: 1 });
    expect(page.items[0]!.resource.sha256).toBe(one.resource.sha256);
    expect(page.next_cursor).toBeDefined();
    expect(
      (
        await resources.listArtifactVersions(fixture.bob, artifact.id, {
          limit: 1,
          cursor: page.next_cursor!,
        })
      ).items[0]!.resource.sha256,
    ).toBe(two.resource.sha256);
    await expect(
      resources.listArtifactVersions(fixture.alice, artifact.id, { cursor: page.next_cursor! }),
    ).rejects.toMatchObject({ code: 'RESYNC_REQUIRED' });
    await expect(
      withTenant(databases.db, fixture.tenantId, (tx) =>
        sql`update artifact_versions set resource_id=${two.resource.id} where id=${artifact.version_id}`.execute(
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    chat = await messaging.createConversation(
      fixture.alice,
      {
        workspace_id: fixture.workspaceId,
        kind: 'group',
        title: 'Different scope',
        member_ids: [fixture.charlie.principalId],
        history_policy: 'all',
      },
      key(),
    );
    const other = await ready();
    await expect(
      resources.createArtifactVersion(
        fixture.alice,
        artifact.id,
        { resource_id: other.resource.id },
        next.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' });
  });
  it('serves authenticated attachment bytes with no-store/nosniff and never exposes an S3 GET URL', async () => {
    const value = await ready('Downloaded over the actual gateway');
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: 'http://resources.test',
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.bob.principalId],
    });
    const app = createApp({ readiness: async () => {} });
    app.register(async (scope) => {
      await registerAuthRoutes(scope, { identity });
      registerResourceRoutes(scope, { identity, resources });
    });
    await app.ready();
    try {
      const session = await identity.devLogin({
        principalId: fixture.bob.principalId,
        origin: 'http://resources.test',
      });
      const headers = {
        cookie: `imbox_session=${session.token}`,
        'x-imbox-tenant-id': fixture.tenantId,
      };
      const response = await app.inject({
        method: 'GET',
        url: value.resource.download_path,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(value.bytes.toString());
      expect(response.headers['content-disposition']).toContain('attachment;');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers.location).toBeUndefined();
      const listing = await app.inject({
        method: 'GET',
        url: `/v1/resources?conversation_id=${chat.id}&limit=1`,
        headers,
      });
      expect(listing.statusCode, listing.body).toBe(200);
      expect(listing.json().items[0].id).toBe(value.resource.id);
      expect((await app.inject({ method: 'GET', url: '/v1/resources', headers })).statusCode).toBe(
        400,
      );
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/artifacts?conversation_id=${chat.id}`,
            headers,
          })
        ).json(),
      ).toEqual({ items: [] });
      expect(
        (await app.inject({ method: 'GET', url: value.resource.download_path })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});
