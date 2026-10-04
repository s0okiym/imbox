import { recordPolicy, purgeDerivedContent, type PolicyLedger } from '@imbox/application';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  appendEvent,
  command,
  CursorCodec,
  ApplicationError,
  type AuthContext,
} from '@imbox/application';
import { sql, withTenant, type Db, type TenantTransaction } from '@imbox/db';
import { scanRestrictedText, supportedTextTypes, type ContentScanner } from './scanner.js';
import type { ObjectStore } from './store.js';
import type { ResourceTextIndexPort } from './text-index-port.js';
import {
  fail,
  json,
  sha,
  same,
  resourceDto,
  resourceHistorySql,
  scopeAccess,
  resource,
  queueCleanup,
  type UploadRow,
  type ResourceRow,
  type ArtifactRow,
} from './shared.js';
interface ArtifactBranchRow {
  id: string;
  artifact_id: string;
  base_version_id: string;
  resource_id: string;
  created_by: string;
  created_at: Date;
  status: 'open' | 'merged';
  merged_version_id: string | null;
  merged_against_version_id: string | null;
  merged_by: string | null;
}
export interface CreateUploadInput {
  conversation_id?: string;
  task_id?: string;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
}
export function createResourceService(options: {
  db: Db;
  store: ObjectStore;
  cursorSecret: string;
  scanner?: ContentScanner;
  maxUploadBytes?: number;
  allowedContentTypes?: readonly string[];
  textIndex?: ResourceTextIndexPort;
  policyLedger?: PolicyLedger;
}) {
  const scanner = options.scanner ?? scanRestrictedText;
  const maxBytes = options.maxUploadBytes ?? 8 * 1024 * 1024;
  const types = options.allowedContentTypes ?? supportedTextTypes;
  const cursors = new CursorCodec(options.cursorSecret);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
    throw new Error('Upload limit must be 1..8388608 bytes');
  const uploadRow = async (tx: TenantTransaction, id: string) =>
    (
      await sql<UploadRow>`select *,expires_at>clock_timestamp() as live from resource_uploads where id=${id}`.execute(
        tx,
      )
    ).rows[0] ?? fail('NOT_FOUND', 404);
  async function artifact(tx: TenantTransaction, auth: AuthContext, id: string, write = false) {
    const row =
      (await sql<ArtifactRow>`select * from artifacts where id=${id}`.execute(tx)).rows[0] ??
      fail('NOT_FOUND', 404);
    await scopeAccess(tx, auth, row, write, row.created_at);
    if (write && !row.task_id && row.created_by !== auth.principalId) fail('FORBIDDEN', 403);
    return (
      await sql<ArtifactRow>`select * from artifacts where id=${id} ${write ? sql`for update` : sql`for share`}`.execute(
        tx,
      )
    ).rows[0]!;
  }
  async function artifactDto(tx: TenantTransaction, auth: AuthContext, row: ArtifactRow) {
    const latest = (
      await sql<{
        id: string;
        resource_id: string;
      }>`select id,resource_id from artifact_versions where artifact_id=${row.id} and version=${row.head_version}`.execute(
        tx,
      )
    ).rows[0]!;
    const content = await resource(tx, auth, latest.resource_id);
    let canAppendVersion = false;
    if (row.task_id || row.created_by === auth.principalId) {
      try {
        await scopeAccess(tx, auth, row, true, row.created_at);
        canAppendVersion = true;
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !['FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT'].includes(error.code)
        )
          throw error;
      }
    }
    return {
      can_append_version: canAppendVersion,
      id: row.id,
      title: row.title,
      kind: row.kind,
      version: row.version,
      head_version: row.head_version,
      version_id: latest.id,
      resource: resourceDto(content),
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
    };
  }
  async function appendVersion(
    tx: TenantTransaction,
    auth: AuthContext,
    row: ArtifactRow,
    content: ResourceRow,
    version: string,
  ) {
    const id = randomUUID();
    await sql`insert into artifact_versions(tenant_id,id,artifact_id,version,resource_id,created_by) values(${auth.tenantId},${id},${row.id},${version},${content.id},${auth.principalId})`.execute(
      tx,
    );
    await sql`insert into resource_links(tenant_id,source_resource_id,target_artifact_version_id) values(${auth.tenantId},${content.id},${id})`.execute(
      tx,
    );
  }
  async function branchDto(tx: TenantTransaction, auth: AuthContext, id: string) {
    const row =
      (await sql<ArtifactBranchRow>`select * from artifact_branches where id=${id}`.execute(tx))
        .rows[0] ?? fail('NOT_FOUND', 404);
    await artifact(tx, auth, row.artifact_id);
    const content = await resource(tx, auth, row.resource_id);
    return {
      id: row.id,
      artifact_id: row.artifact_id,
      base_version_id: row.base_version_id,
      resource: resourceDto(content),
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
      status: row.status,
      merged_version_id: row.merged_version_id,
      merged_against_version_id: row.merged_against_version_id,
      merged_by: row.merged_by,
    };
  }
  return {
    async createUpload(auth: AuthContext, input: CreateUploadInput, key: string) {
      if (
        !!input.task_id === !!input.conversation_id ||
        !input.filename ||
        input.filename.length > 200 ||
        [...input.filename].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        !types.includes(input.content_type) ||
        !Number.isSafeInteger(input.byte_size) ||
        input.byte_size < 0 ||
        input.byte_size > maxBytes ||
        !/^[a-f0-9]{64}$/.test(input.sha256)
      )
        fail('VALIDATION_FAILED', 400);
      const row = await withTenant(options.db, auth.tenantId, async (tx) => {
        const scope = {
          conversation_id: input.conversation_id ?? null,
          task_id: input.task_id ?? null,
        };
        const fence = await scopeAccess(tx, auth, scope, true);
        const id = await command(tx, auth, 'resource.upload', key, input, async () => {
          const id = randomUUID();
          await sql`insert into resource_uploads(tenant_id,id,resource_id,created_by,conversation_id,task_id,filename,content_type,byte_size,sha256,staging_key,object_key,authorization_fence,expires_at) values(${auth.tenantId},${id},${randomUUID()},${auth.principalId},${scope.conversation_id},${scope.task_id},${input.filename},${input.content_type},${input.byte_size},${input.sha256},${`staging/${auth.tenantId}/${id}`},${`objects/${auth.tenantId}/${id}`},${json(fence)}::jsonb,clock_timestamp()+interval '15 minutes')`.execute(
            tx,
          );
          return id;
        });
        const row = await uploadRow(tx, id);
        if (
          row.created_by !== auth.principalId ||
          !row.live ||
          row.status !== 'pending' ||
          !same(row.authorization_fence, fence)
        )
          fail('VERSION_CONFLICT', 409);
        return row;
      });
      const upload = await options.store.signPut(row.staging_key, {
        contentType: row.content_type,
        byteSize: row.byte_size,
        sha256: row.sha256,
        expiresSeconds: Math.max(
          1,
          Math.min(900, Math.floor((row.expires_at.getTime() - Date.now()) / 1000)),
        ),
      });
      return {
        id: row.id,
        resource_id: row.resource_id,
        upload_url: upload.url,
        upload_headers: upload.headers,
        expires_at: row.expires_at.toISOString(),
        max_bytes: maxBytes,
      };
    },
    async completeUpload(auth: AuthContext, id: string, key: string) {
      const claim = await withTenant(options.db, auth.tenantId, async (tx) => {
        const initial = await uploadRow(tx, id);
        const fence = await scopeAccess(
          tx,
          auth,
          initial,
          initial.status !== 'ready',
          initial.created_at,
        );
        const row = (
          await sql<
            UploadRow & { busy: boolean }
          >`select *,expires_at>clock_timestamp() as live,verification_expires_at>clock_timestamp() as busy from resource_uploads where id=${id} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (row.created_by !== auth.principalId) fail('NOT_FOUND', 404);
        if (row.status === 'ready')
          return { row, ready: resourceDto(await resource(tx, auth, row.resource_id)) };
        if (
          !row.live ||
          !['pending', 'verifying'].includes(row.status) ||
          (row.status === 'verifying' && row.busy)
        )
          fail('VERSION_CONFLICT', 409);
        if (!same(fence, row.authorization_fence)) fail('FORBIDDEN', 403);
        const claimed = (
          await sql<UploadRow>`update resource_uploads set status='verifying',verification_generation=verification_generation+1,verification_expires_at=clock_timestamp()+interval '60 seconds',version=version+1,updated_at=clock_timestamp() where id=${id} returning *`.execute(
            tx,
          )
        ).rows[0]!;
        return { row: claimed, ready: null };
      });
      if (claim.ready) return claim.ready;
      const row = claim.row;
      try {
        const object = await options.store.read(row.staging_key);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          if (object.size !== row.byte_size || object.size > maxBytes)
            fail('VALIDATION_FAILED', 400, 'Upload size mismatch');
          for await (const chunk of object.body) {
            size += chunk.byteLength;
            if (size > maxBytes || size > row.byte_size)
              fail('VALIDATION_FAILED', 400, 'Upload size mismatch');
            chunks.push(chunk);
          }
        } finally {
          object.close();
        }
        const bytes = Buffer.concat(chunks);
        if (size !== row.byte_size || sha(bytes) !== row.sha256)
          fail('VALIDATION_FAILED', 400, 'Upload checksum mismatch');
        const scan = await scanner(bytes, row.content_type);
        if (!scan.approved)
          fail('CONTENT_REJECTED', 422, 'Content admission policy rejected the upload');
        await options.store.putImmutable(row.object_key, bytes, row.content_type, row.sha256);
        return await withTenant(options.db, auth.tenantId, async (tx) => {
          const fence = await scopeAccess(tx, auth, row, true, row.created_at);
          if (!same(fence, row.authorization_fence)) fail('FORBIDDEN', 403);
          const current = (
            await sql<
              UploadRow & { live: boolean }
            >`select *,expires_at>clock_timestamp() and verification_expires_at>clock_timestamp() as live from resource_uploads where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          if (
            current.status !== 'verifying' ||
            current.verification_generation !== row.verification_generation ||
            !current.live
          )
            fail('VERSION_CONFLICT', 409);
          await command(tx, auth, 'resource.complete', key, { id }, async () => {
            await sql`insert into resources(tenant_id,id,upload_id,created_by,conversation_id,task_id,filename,content_type,byte_size,sha256,object_key,scan_state,scan_evidence,created_at) values(${auth.tenantId},${row.resource_id},${row.id},${auth.principalId},${row.conversation_id},${row.task_id},${row.filename},${row.content_type},${row.byte_size},${row.sha256},${row.object_key},'approved',${json(scan)}::jsonb,${row.created_at})`.execute(
              tx,
            );
            if (options.textIndex)
              await options.textIndex.upsert(tx, auth, {
                resourceId: row.resource_id,
                version: '1',
                sha256: row.sha256,
                text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              });
            await sql`update resource_uploads set status='ready',version=version+1,verification_expires_at=null,updated_at=clock_timestamp() where id=${id}`.execute(
              tx,
            );
            await queueCleanup(tx, auth.tenantId, row.staging_key, row.id, null);
            await appendEvent(tx, auth, {
              aggregateType: 'resource',
              aggregateId: row.resource_id,
              version: '1',
              type: 'resource.created',
              payload: {},
              target: `resource:${row.resource_id}`,
            });
            return row.resource_id;
          });
          return resourceDto(await resource(tx, auth, row.resource_id));
        });
      } catch (error) {
        const permanent =
          error instanceof ApplicationError && [400, 403, 404, 422].includes(error.status);
        await withTenant(options.db, auth.tenantId, async (tx) => {
          const current = (
            await sql<UploadRow>`select * from resource_uploads where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          if (
            current.status === 'verifying' &&
            current.verification_generation === row.verification_generation
          ) {
            await sql`update resource_uploads set status=${permanent ? 'rejected' : 'pending'},verification_expires_at=null,version=version+1,updated_at=clock_timestamp() where id=${id} and status='verifying' and verification_generation=${row.verification_generation}`.execute(
              tx,
            );
            if (permanent) {
              await queueCleanup(tx, auth.tenantId, row.staging_key, row.id, null);
              await queueCleanup(tx, auth.tenantId, row.object_key, row.id, null);
            }
          }
        });
        if (error instanceof ApplicationError) throw error;
        fail('SERVICE_UNAVAILABLE', 503, 'Resource verification is temporarily unavailable');
      }
    },
    async listResources(
      auth: AuthContext,
      query: { task_id?: string; conversation_id?: string; cursor?: string; limit?: number },
    ) {
      if (!!query.task_id === !!query.conversation_id) fail('VALIDATION_FAILED', 400);
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED', 400);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const scope = {
          task_id: query.task_id ?? null,
          conversation_id: query.conversation_id ?? null,
        };
        const fence = await scopeAccess(tx, auth, scope);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          scope,
          fence,
          'resources',
        ]);
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<ResourceRow>`select r.* from resources r where ${scope.task_id ? sql`r.task_id=${scope.task_id}` : sql`r.conversation_id=${scope.conversation_id}`} and r.deleted_at is null and r.id>${after}::uuid and ${resourceHistorySql(auth)} order by r.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map(resourceDto),
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async listArtifacts(
      auth: AuthContext,
      query: { task_id?: string; conversation_id?: string; cursor?: string; limit?: number },
    ) {
      if (!!query.task_id === !!query.conversation_id) fail('VALIDATION_FAILED', 400);
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED', 400);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const scope = {
          task_id: query.task_id ?? null,
          conversation_id: query.conversation_id ?? null,
        };
        const fence = await scopeAccess(tx, auth, scope);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          scope,
          fence,
          'artifacts',
        ]);
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<ArtifactRow>`select a.* from artifacts a join artifact_versions av on av.tenant_id=a.tenant_id and av.artifact_id=a.id and av.version=a.head_version join resources r on r.tenant_id=av.tenant_id and r.id=av.resource_id where ${scope.task_id ? sql`a.task_id=${scope.task_id}` : sql`a.conversation_id=${scope.conversation_id}`} and a.id>${after}::uuid and r.deleted_at is null and ${resourceHistorySql(auth)} and (a.conversation_id is null or exists(select 1 from conversations c join conversation_members cm on cm.tenant_id=c.tenant_id and cm.conversation_id=c.id where c.id=a.conversation_id and cm.principal_id=${auth.principalId} and (c.history_policy='all' or cm.joined_at<=a.created_at))) order by a.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const row of rows.slice(0, limit)) items.push(await artifactDto(tx, auth, row));
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async getResource(auth: AuthContext, id: string) {
      return withTenant(options.db, auth.tenantId, async (tx) =>
        resourceDto(await resource(tx, auth, id)),
      );
    },
    async openDownload(auth: AuthContext, id: string) {
      const row = await withTenant(options.db, auth.tenantId, (tx) => resource(tx, auth, id));
      const store = options.store;
      const db = options.db;
      async function* chunks() {
        const object = await store.read(row.object_key);
        try {
          if (object.size !== row.byte_size) fail('SERVICE_UNAVAILABLE', 503);
          let delivered = 0;
          for await (const incoming of object.body) {
            for (let offset = 0; offset < incoming.byteLength; offset += 65536) {
              const bytes = incoming.subarray(offset, offset + 65536);
              await withTenant(db, auth.tenantId, async (tx) => {
                const current = await resource(tx, auth, id);
                if (current.authz_generation !== row.authz_generation) fail('NOT_FOUND', 404);
              });
              delivered += bytes.byteLength;
              if (delivered > row.byte_size) fail('SERVICE_UNAVAILABLE', 503);
              yield bytes;
            }
          }
          if (delivered !== row.byte_size) fail('SERVICE_UNAVAILABLE', 503);
        } finally {
          object.close();
        }
      }
      return { metadata: resourceDto(row), stream: Readable.from(chunks()), chunks };
    },
    async deleteResource(auth: AuthContext, id: string, version: string, key: string) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        await command(tx, auth, 'resource.delete', key, { id, version }, async () => {
          const row = await resource(tx, auth, id, true);
          if (row.created_by !== auth.principalId) fail('FORBIDDEN', 403);
          if (row.version !== version) fail('VERSION_CONFLICT', 409);
          await recordPolicy(tx, auth, options.policyLedger, {
            kind: 'deletion.resource',
            target_id: id,
            target_version: version,
          });
          await purgeDerivedContent(tx, 'deletion.resource', id);
          await sql`update resources set deleted_at=clock_timestamp(),version=version+1,authz_generation=authz_generation+1 where id=${id}`.execute(
            tx,
          );
          await options.textIndex?.remove(tx, auth, id);
          await queueCleanup(tx, auth.tenantId, row.object_key, null, row.id);
          if (row.conversation_id) {
            const refs = (
              await sql<{
                id: string;
              }>`select m.id from message_resources mr join messages m on m.tenant_id=mr.tenant_id and m.id=mr.message_id where mr.resource_id=${row.id} and m.deleted_at is null order by m.id`.execute(
                tx,
              )
            ).rows;
            if (refs.length) {
              const conversation = (
                await sql<{
                  version: string;
                }>`update conversations set version=version+1,authz_generation=authz_generation+1,updated_at=clock_timestamp() where id=${row.conversation_id} returning version`.execute(
                  tx,
                )
              ).rows[0]!;
              await sql`update projection_streams set authz_generation=authz_generation+1,updated_at=clock_timestamp() where id=${row.conversation_id}`.execute(
                tx,
              );
              await appendEvent(tx, auth, {
                aggregateType: 'conversation',
                aggregateId: row.conversation_id,
                version: conversation.version,
                type: 'conversation.content_retracted',
                payload: { resource_id: row.id },
                target: `conversation:${row.conversation_id}`,
              });
              for (const ref of refs) {
                await sql`insert into message_revisions(tenant_id,message_id,revision,body,edited_by) select tenant_id,id,version,body,${auth.principalId} from messages where id=${ref.id} on conflict(tenant_id,message_id,revision) do nothing`.execute(
                  tx,
                );
                const message = (
                  await sql<{
                    version: string;
                  }>`update messages set version=version+1,updated_at=clock_timestamp() where id=${ref.id} returning version`.execute(
                    tx,
                  )
                ).rows[0]!;
                await appendEvent(tx, auth, {
                  aggregateType: 'message',
                  aggregateId: ref.id,
                  version: message.version,
                  type: 'message.attachment_retracted',
                  payload: { conversation_id: row.conversation_id },
                  target: `conversation:${row.conversation_id}`,
                });
              }
            }
          }

          await appendEvent(tx, auth, {
            aggregateType: 'resource',
            aggregateId: id,
            version: String(BigInt(version) + 1n),
            type: 'resource.deleted',
            payload: {},
            target: `resource:${row.id}`,
          });
          return id;
        });
        return { id, deleted: true };
      });
    },
    async createArtifact(
      auth: AuthContext,
      input: { resource_id: string; title: string },
      key: string,
    ) {
      if (!input.title || input.title.length > 200) fail('VALIDATION_FAILED', 400);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const content = await resource(tx, auth, input.resource_id, true);
        const id = await command(tx, auth, 'artifact.create', key, input, async () => {
          const id = randomUUID();
          await sql`insert into artifacts(tenant_id,id,created_by,conversation_id,task_id,title,kind) values(${auth.tenantId},${id},${auth.principalId},${content.conversation_id},${content.task_id},${input.title},${content.content_type === 'text/plain' ? 'text' : content.content_type === 'text/markdown' ? 'markdown' : 'file'})`.execute(
            tx,
          );
          await appendVersion(tx, auth, await artifact(tx, auth, id), content, '1');
          return id;
        });
        return artifactDto(tx, auth, await artifact(tx, auth, id));
      });
    },
    async getArtifact(auth: AuthContext, id: string) {
      return withTenant(options.db, auth.tenantId, async (tx) =>
        artifactDto(tx, auth, await artifact(tx, auth, id)),
      );
    },
    async createArtifactVersion(
      auth: AuthContext,
      id: string,
      input: { resource_id: string },
      version: string,
      key: string,
    ) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const initial = await artifact(tx, auth, id, true);
        await command(tx, auth, 'artifact.version', key, { id, input, version }, async () => {
          const content = await resource(tx, auth, input.resource_id, true);
          if (
            content.task_id !== initial.task_id ||
            content.conversation_id !== initial.conversation_id
          )
            fail('DISCLOSURE_DENIED', 403);
          if (initial.version !== version) fail('VERSION_CONFLICT', 409);
          const next = String(BigInt(initial.head_version) + 1n);
          await appendVersion(tx, auth, initial, content, next);
          await sql`update artifacts set version=version+1,head_version=${next} where id=${id}`.execute(
            tx,
          );
          return id;
        });
        return artifactDto(tx, auth, await artifact(tx, auth, id));
      });
    },
    async createArtifactBranch(
      auth: AuthContext,
      id: string,
      input: { base_version_id: string; resource_id: string },
      key: string,
    ) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const parent = await artifact(tx, auth, id, true);
        const result = await command(tx, auth, 'artifact.branch', key, { id, input }, async () => {
          const base =
            (
              await sql<{
                resource_id: string;
              }>`select resource_id from artifact_versions where id=${input.base_version_id} and artifact_id=${id}`.execute(
                tx,
              )
            ).rows[0] ?? fail('NOT_FOUND', 404);
          await resource(tx, auth, base.resource_id);
          const content = await resource(tx, auth, input.resource_id, true);
          if (
            content.task_id !== parent.task_id ||
            content.conversation_id !== parent.conversation_id
          )
            fail('DISCLOSURE_DENIED', 403);
          const count = (
            await sql<{
              count: string;
            }>`select count(*) from artifact_branches b join resources r on r.tenant_id=b.tenant_id and r.id=b.resource_id where b.artifact_id=${id} and b.status='open' and r.deleted_at is null`.execute(
              tx,
            )
          ).rows[0]!;
          if (BigInt(count.count) >= 200n)
            fail('VALIDATION_FAILED', 400, 'At most 200 open branches per artifact');
          const branchId = randomUUID();
          await sql`insert into artifact_branches(tenant_id,id,artifact_id,base_version_id,resource_id,created_by) values(${auth.tenantId},${branchId},${id},${input.base_version_id},${input.resource_id},${auth.principalId})`.execute(
            tx,
          );
          return branchId;
        });
        return branchDto(tx, auth, result);
      });
    },
    async listArtifactBranches(
      auth: AuthContext,
      id: string,
      query: { cursor?: string; limit?: number } = {},
    ) {
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED', 400);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const parent = await artifact(tx, auth, id);
        const fence = await scopeAccess(tx, auth, parent);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          id,
          fence,
          'artifact-branches',
        ]);
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
          }>`select b.id from artifact_branches b join resources r on r.tenant_id=b.tenant_id and r.id=b.resource_id where b.artifact_id=${id} and b.id>${after}::uuid and r.deleted_at is null and ${resourceHistorySql(auth)} order by b.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const row of rows.slice(0, limit)) items.push(await branchDto(tx, auth, row.id));
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async mergeArtifactBranch(
      auth: AuthContext,
      id: string,
      input: { branch_id: string; resource_id: string },
      version: string,
      key: string,
    ) {
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const parent = await artifact(tx, auth, id, true);
        await command(tx, auth, 'artifact.branch_merge', key, { id, input, version }, async () => {
          if (parent.version !== version) fail('VERSION_CONFLICT', 409);
          const branch =
            (
              await sql<ArtifactBranchRow>`select * from artifact_branches where id=${input.branch_id} and artifact_id=${id} for update`.execute(
                tx,
              )
            ).rows[0] ?? fail('NOT_FOUND', 404);
          if (branch.status !== 'open') fail('VERSION_CONFLICT', 409);
          await resource(tx, auth, branch.resource_id);
          const content = await resource(tx, auth, input.resource_id, true);
          if (
            content.task_id !== parent.task_id ||
            content.conversation_id !== parent.conversation_id
          )
            fail('DISCLOSURE_DENIED', 403);
          const previous = (
            await sql<{
              id: string;
            }>`select id from artifact_versions where artifact_id=${id} and version=${parent.head_version}`.execute(
              tx,
            )
          ).rows[0]!;
          const next = String(BigInt(parent.head_version) + 1n);
          await appendVersion(tx, auth, parent, content, next);
          const merged = (
            await sql<{
              id: string;
            }>`select id from artifact_versions where artifact_id=${id} and version=${next}`.execute(
              tx,
            )
          ).rows[0]!;
          await sql`update artifacts set version=version+1,head_version=${next} where id=${id}`.execute(
            tx,
          );
          await sql`update artifact_branches set status='merged',merged_version_id=${merged.id},merged_against_version_id=${previous.id},merged_by=${auth.principalId} where id=${branch.id}`.execute(
            tx,
          );
          return id;
        });
        return artifactDto(tx, auth, await artifact(tx, auth, id));
      });
    },
    async listArtifactVersions(
      auth: AuthContext,
      id: string,
      query: { cursor?: string; limit?: number } = {},
    ) {
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED', 400);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const row = await artifact(tx, auth, id);
        const fence = await scopeAccess(tx, auth, row);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          id,
          fence,
          'artifact-versions',
        ]);
        const after = query.cursor ? cursors.decode(query.cursor, binding) : '0';
        const versions = (
          await sql<{
            id: string;
            version: string;
            resource_id: string;
            created_by: string;
            created_at: Date;
          }>`select * from artifact_versions where artifact_id=${row.id} and version>${after}::bigint order by version limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const value of versions.slice(0, limit)) {
          const content = await resource(tx, auth, value.resource_id);
          items.push({
            id: value.id,
            artifact_id: id,
            version: value.version,
            resource: resourceDto(content),
            created_by: value.created_by,
            created_at: value.created_at.toISOString(),
          });
        }
        return {
          items,
          ...(versions.length > limit
            ? { next_cursor: cursors.encode(binding, versions[limit - 1]!.version) }
            : {}),
        };
      });
    },
  };
}
export type ResourceService = ReturnType<typeof createResourceService>;
