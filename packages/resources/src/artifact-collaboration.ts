import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  authorizeTenant,
  authorizeConversation,
  command,
  appendEvent,
  CursorCodec,
  recordPolicy,
  type AuthContext,
  type PolicyLedger,
} from '@imbox/application';
import {
  sql,
  withTenant,
  lockPrincipal,
  lockTaskRoots,
  type Db,
  type TenantTransaction as Tx,
} from '@imbox/db';
import type { ObjectStore } from './store.js';
import { fail, json, same, resource, scopeAccess, type Scope, type ResourceRow } from './shared.js';
export type ArtifactCommentAnchor =
  { type: 'whole' } | { type: 'text_range'; start: number; end: number };
interface ArtifactVersion {
  artifact_id: string;
  version_id: string;
  resource_id: string;
  artifact_created_by: string;
  artifact_created_at: Date;
  title: string;
  version: string;
  conversation_id: string | null;
  task_id: string | null;
}
interface CommentRow {
  id: string;
  artifact_id: string;
  version_id: string;
  resource_sha256: string;
  created_by: string;
  anchor: ArtifactCommentAnchor;
  body: string;
  version: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
interface ShareRow {
  id: string;
  artifact_id: string;
  version_id: string;
  resource_sha256: string;
  created_by: string;
  recipient_principal_id: string | null;
  target_conversation_id: string | null;
  target_task_id: string | null;
  source_authorization: Record<string, unknown>;
  target_authorization: Record<string, unknown>;
  status: 'active' | 'revoked';
  version: string;
  expires_at: Date;
  created_at: Date;
  live?: boolean;
}
export interface CreateArtifactShareInput {
  version_id: string;
  sha256: string;
  recipient_principal_id?: string;
  conversation_id?: string;
  task_id?: string;
  expires_at: string;
}
const limitOf = (n = 50) => {
  if (!Number.isInteger(n) || n < 1 || n > 100) fail('VALIDATION_FAILED', 400);
  return n;
};
const commentDto = (r: CommentRow) => ({
  id: r.id,
  artifact_id: r.artifact_id,
  version_id: r.version_id,
  sha256: r.resource_sha256,
  created_by: r.created_by,
  anchor: r.anchor,
  body: r.deleted_at ? '' : r.body,
  version: r.version,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
  deleted: !!r.deleted_at,
});
export function createArtifactCollaborationService(options: {
  db: Db;
  store: ObjectStore;
  cursorSecret: string;
  policyLedger?: PolicyLedger;
}) {
  const cursors = new CursorCodec(options.cursorSecret);
  async function actor(tx: Tx, tenantId: string, principalId: string) {
    const p = await lockPrincipal(tx, principalId);
    const member = (
      await sql<{
        status: string;
        authz_revision: string;
      }>`select status,authz_revision from tenant_principals where principal_id=${principalId} for share`.execute(
        tx,
      )
    ).rows[0];
    if (p?.status !== 'active' || member?.status !== 'active') fail('NOT_FOUND', 404);
    return {
      auth: {
        tenantId,
        principalId,
        kind: p.kind,
        authzRevision: member.authz_revision,
      } satisfies AuthContext,
      principalVersion: p.version,
    };
  }
  const transaction = <T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>) =>
    withTenant(options.db, auth.tenantId, async (tx) => {
      await authorizeTenant(tx, auth);
      const current = await actor(tx, auth.tenantId, auth.principalId);
      if (current.auth.kind !== auth.kind) fail('FORBIDDEN', 403);
      return fn(tx);
    });
  const rawVersion = async (tx: Tx, artifactId: string, versionId: string) =>
    (
      await sql<ArtifactVersion>`select a.id as artifact_id,av.id as version_id,av.resource_id,a.created_by as artifact_created_by,a.created_at as artifact_created_at,a.title,av.version,a.conversation_id,a.task_id from artifact_versions av join artifacts a on a.tenant_id=av.tenant_id and a.id=av.artifact_id where av.id=${versionId} and a.id=${artifactId}`.execute(
        tx,
      )
    ).rows[0] ?? fail('NOT_FOUND', 404);
  async function lockScopes(tx: Tx, auth: AuthContext, scopes: Scope[], write = false) {
    const taskIds = [...new Set(scopes.flatMap((s) => (s.task_id ? [s.task_id] : [])))];
    const roots = (
      await sql<{
        root_task_id: string;
      }>`select distinct root_task_id from tasks where id=any(${taskIds}::uuid[])`.execute(tx)
    ).rows;
    await lockTaskRoots(
      tx,
      auth.tenantId,
      roots.map((r) => r.root_task_id),
    );
    for (const id of [
      ...new Set(scopes.flatMap((s) => (s.conversation_id ? [s.conversation_id] : []))),
    ].sort())
      await authorizeConversation(tx, auth, id, write);
  }
  async function versionAccess(
    tx: Tx,
    auth: AuthContext,
    artifactId: string,
    versionId: string,
    commentWrite = false,
  ) {
    const v = await rawVersion(tx, artifactId, versionId);
    await lockScopes(tx, auth, [v], commentWrite && !!v.conversation_id);
    const fence = await scopeAccess(tx, auth, v, false, v.artifact_created_at);
    if (commentWrite && v.task_id) {
      const role = (
        await sql<{
          role: string;
        }>`select role from task_participants where task_id=${v.task_id} and principal_id=${auth.principalId} and status='active' for share`.execute(
          tx,
        )
      ).rows[0]?.role;
      if (!role || role === 'observer') fail('FORBIDDEN', 403);
    }
    const content = await resource(tx, auth, v.resource_id);
    return { v, content, fence };
  }
  async function anchor(tx: Tx, content: ResourceRow, a: ArtifactCommentAnchor) {
    if (a.type === 'whole') return;
    if (
      a.type !== 'text_range' ||
      !Number.isSafeInteger(a.start) ||
      !Number.isSafeInteger(a.end) ||
      a.start < 0 ||
      a.end <= a.start ||
      a.end > 8388608
    )
      fail('VALIDATION_FAILED', 400);
    const doc = (
      await sql<{
        body: string;
      }>`select body from resource_text_documents where resource_id=${content.id} and resource_version=${content.version} and sha256=${content.sha256}`.execute(
        tx,
      )
    ).rows[0];
    if (!doc) fail('SERVICE_UNAVAILABLE', 503);
    if (a.end > [...doc.body].length) fail('VALIDATION_FAILED', 400);
  }
  function validBody(body: string) {
    if (!body || body.length > 4000) fail('VALIDATION_FAILED', 400);
  }
  async function targetFence(
    tx: Tx,
    creator: AuthContext,
    input: {
      recipient_principal_id: string | null;
      target_conversation_id: string | null;
      target_task_id: string | null;
    },
    write = false,
  ) {
    if (input.recipient_principal_id) {
      const target = await actor(tx, creator.tenantId, input.recipient_principal_id);
      return {
        principal_version: target.principalVersion,
        tenant_revision: target.auth.authzRevision,
      };
    }
    return {
      scope: await scopeAccess(
        tx,
        creator,
        { conversation_id: input.target_conversation_id, task_id: input.target_task_id },
        write,
      ),
    };
  }
  const shareDto = (s: ShareRow, v: ArtifactVersion, r: ResourceRow) => ({
    id: s.id,
    artifact_id: s.artifact_id,
    version_id: s.version_id,
    sha256: s.resource_sha256,
    title: v.title,
    filename: r.filename,
    content_type: r.content_type,
    byte_size: r.byte_size,
    created_by: s.created_by,
    recipient_principal_id: s.recipient_principal_id,
    conversation_id: s.target_conversation_id,
    task_id: s.target_task_id,
    version: s.version,
    expires_at: s.expires_at.toISOString(),
    created_at: s.created_at.toISOString(),
    download_path: `/v1/artifact-shares/${s.id}/content`,
  });
  async function shareAccess(tx: Tx, auth: AuthContext, id: string) {
    const initial = (
      await sql<ShareRow>`select *,expires_at>clock_timestamp() as live from artifact_shares where id=${id}`.execute(
        tx,
      )
    ).rows[0];
    if (!initial || initial.status !== 'active' || !initial.live) fail('NOT_FOUND', 404);
    const owner = await actor(tx, auth.tenantId, initial.created_by);
    const v = await rawVersion(tx, initial.artifact_id, initial.version_id);
    const targetScope = {
      conversation_id: initial.target_conversation_id,
      task_id: initial.target_task_id,
    };
    await lockScopes(tx, owner.auth, [v, ...(initial.recipient_principal_id ? [] : [targetScope])]);
    const source = await versionAccess(tx, owner.auth, initial.artifact_id, initial.version_id);
    if (
      source.v.artifact_created_by !== owner.auth.principalId ||
      source.content.created_by !== owner.auth.principalId ||
      source.content.sha256 !== initial.resource_sha256
    )
      fail('NOT_FOUND', 404);
    const sourceFence = {
      scope: source.fence,
      tenant_revision: owner.auth.authzRevision,
      resource_version: source.content.version,
      resource_generation: source.content.authz_generation,
    };
    if (
      !same(initial.source_authorization, sourceFence) ||
      !same(initial.target_authorization, await targetFence(tx, owner.auth, initial))
    )
      fail('NOT_FOUND', 404);
    if (auth.principalId !== initial.created_by) {
      if (initial.recipient_principal_id) {
        if (initial.recipient_principal_id !== auth.principalId) fail('NOT_FOUND', 404);
      } else await scopeAccess(tx, auth, targetScope, false, initial.created_at);
    }
    const current = (
      await sql<ShareRow>`select *,expires_at>clock_timestamp() as live from artifact_shares where id=${id} for share`.execute(
        tx,
      )
    ).rows[0]!;
    if (current.status !== 'active' || !current.live || current.version !== initial.version)
      fail('NOT_FOUND', 404);
    return { share: current, v, content: source.content };
  }
  return {
    async createComment(
      auth: AuthContext,
      artifactId: string,
      input: { version_id: string; sha256: string; anchor: ArtifactCommentAnchor; body: string },
      key: string,
    ) {
      validBody(input.body);
      return transaction(auth, async (tx) => {
        const result = await command(
          tx,
          auth,
          'artifact.comment.create',
          key,
          { artifactId, input },
          async () => {
            const source = await versionAccess(tx, auth, artifactId, input.version_id, true);
            if (source.content.sha256 !== input.sha256) fail('VERSION_CONFLICT', 409);
            await anchor(tx, source.content, input.anchor);
            const id = randomUUID();
            await sql`insert into artifact_comments(tenant_id,id,artifact_id,version_id,resource_sha256,created_by,anchor,body) values(${auth.tenantId},${id},${artifactId},${input.version_id},${input.sha256},${auth.principalId},${json(input.anchor)}::jsonb,${input.body})`.execute(
              tx,
            );
            await appendEvent(tx, auth, {
              aggregateType: 'artifact_comment',
              aggregateId: id,
              version: '1',
              type: 'artifact.comment.created',
              payload: { artifact_id: artifactId, version_id: input.version_id },
              target: `artifact:${artifactId}`,
            });
            return id;
          },
        );
        const r = (
          await sql<CommentRow>`select * from artifact_comments where id=${result} for share`.execute(
            tx,
          )
        ).rows[0]!;
        await versionAccess(tx, auth, r.artifact_id, r.version_id);
        return commentDto(r);
      });
    },
    async listComments(
      auth: AuthContext,
      artifactId: string,
      query: { version_id: string; cursor?: string; limit?: number },
    ) {
      const limit = limitOf(query.limit);
      return transaction(auth, async (tx) => {
        const source = await versionAccess(tx, auth, artifactId, query.version_id);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          artifactId,
          query.version_id,
          source.fence,
          'artifact-comments',
        ]);
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<CommentRow>`select * from artifact_comments where artifact_id=${artifactId} and version_id=${query.version_id} and id>${after}::uuid order by id limit ${limit + 1} for share`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map(commentDto),
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async editComment(auth: AuthContext, id: string, body: string, version: string, key: string) {
      validBody(body);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'artifact.comment.edit', key, { id, body, version }, async () => {
          const initial = (
            await sql<CommentRow>`select * from artifact_comments where id=${id}`.execute(tx)
          ).rows[0];
          if (!initial || initial.created_by !== auth.principalId) fail('NOT_FOUND', 404);
          await versionAccess(tx, auth, initial.artifact_id, initial.version_id, true);
          const current = (
            await sql<CommentRow>`select * from artifact_comments where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          if (current.deleted_at || current.version !== version) fail('VERSION_CONFLICT', 409);
          await sql`update artifact_comments set body=${body},version=version+1,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'artifact_comment',
            aggregateId: id,
            version: String(BigInt(version) + 1n),
            type: 'artifact.comment.edited',
            payload: { artifact_id: current.artifact_id },
            target: `artifact:${current.artifact_id}`,
          });
          return id;
        });
        const r = (
          await sql<CommentRow>`select * from artifact_comments where id=${id} for share`.execute(
            tx,
          )
        ).rows[0]!;
        await versionAccess(tx, auth, r.artifact_id, r.version_id);
        return commentDto(r);
      });
    },
    async deleteComment(auth: AuthContext, id: string, version: string, key: string) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'artifact.comment.delete', key, { id, version }, async () => {
          const r = (
            await sql<CommentRow>`select * from artifact_comments where id=${id} for update`.execute(
              tx,
            )
          ).rows[0];
          if (!r || r.created_by !== auth.principalId) fail('NOT_FOUND', 404);
          if (r.deleted_at || r.version !== version) fail('VERSION_CONFLICT', 409);
          await recordPolicy(tx, auth, options.policyLedger, {
            kind: 'deletion.artifact_comment',
            target_id: id,
            target_version: version,
          });
          await sql`update artifact_comments set body='',deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'artifact_comment',
            aggregateId: id,
            version: String(BigInt(version) + 1n),
            type: 'artifact.comment.deleted',
            payload: { artifact_id: r.artifact_id },
            target: `artifact:${r.artifact_id}`,
          });
          return id;
        });
        return { id, deleted: true as const };
      });
    },
    async createShare(
      auth: AuthContext,
      artifactId: string,
      input: CreateArtifactShareInput,
      key: string,
    ) {
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      if (
        [input.recipient_principal_id, input.conversation_id, input.task_id].filter(Boolean)
          .length !== 1 ||
        !Number.isFinite(Date.parse(input.expires_at))
      )
        fail('VALIDATION_FAILED', 400);
      return transaction(auth, async (tx) => {
        const id = await command(
          tx,
          auth,
          'artifact.share.create',
          key,
          { artifactId, input },
          async () => {
            const raw = await rawVersion(tx, artifactId, input.version_id);
            const target = {
              recipient_principal_id: input.recipient_principal_id ?? null,
              target_conversation_id: input.conversation_id ?? null,
              target_task_id: input.task_id ?? null,
            };
            await lockScopes(
              tx,
              auth,
              [
                raw,
                ...(target.recipient_principal_id
                  ? []
                  : [
                      {
                        conversation_id: target.target_conversation_id,
                        task_id: target.target_task_id,
                      },
                    ]),
              ],
              true,
            );
            const source = await versionAccess(tx, auth, artifactId, input.version_id);
            await scopeAccess(tx, auth, source.v, true);
            if (
              source.v.artifact_created_by !== auth.principalId ||
              source.content.created_by !== auth.principalId
            )
              fail('DISCLOSURE_DENIED', 403);
            if (source.content.sha256 !== input.sha256) fail('VERSION_CONFLICT', 409);
            const valid = (
              await sql<{
                valid: boolean;
              }>`select ${input.expires_at}::timestamptz>clock_timestamp() and ${input.expires_at}::timestamptz<=clock_timestamp()+interval '24 hours' as valid`.execute(
                tx,
              )
            ).rows[0]?.valid;
            if (!valid) fail('VALIDATION_FAILED', 400);
            const sourceFence = {
              scope: source.fence,
              tenant_revision: auth.authzRevision,
              resource_version: source.content.version,
              resource_generation: source.content.authz_generation,
            };
            const targetAuth = await targetFence(tx, auth, target, true);
            const id = randomUUID();
            await sql`insert into artifact_shares(tenant_id,id,artifact_id,version_id,resource_sha256,created_by,recipient_principal_id,target_conversation_id,target_task_id,source_authorization,target_authorization,expires_at) values(${auth.tenantId},${id},${artifactId},${input.version_id},${input.sha256},${auth.principalId},${target.recipient_principal_id},${target.target_conversation_id},${target.target_task_id},${json(sourceFence)}::jsonb,${json(targetAuth)}::jsonb,${input.expires_at})`.execute(
              tx,
            );
            await appendEvent(tx, auth, {
              aggregateType: 'artifact_share',
              aggregateId: id,
              version: '1',
              type: 'artifact.share.created',
              payload: { artifact_id: artifactId },
              target: `artifact:${artifactId}`,
            });
            return id;
          },
        );
        const result = await shareAccess(tx, auth, id);
        return shareDto(result.share, result.v, result.content);
      });
    },
    async getShare(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        const r = await shareAccess(tx, auth, id);
        return shareDto(r.share, r.v, r.content);
      });
    },
    async listShares(
      auth: AuthContext,
      artifactId: string,
      query: { cursor?: string; limit?: number } = {},
    ) {
      const limit = limitOf(query.limit);
      return transaction(auth, async (tx) => {
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          artifactId,
          'owned-artifact-shares',
        ]);
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<ShareRow>`select * from artifact_shares where artifact_id=${artifactId} and created_by=${auth.principalId} and id>${after}::uuid order by id limit ${limit + 1} for share`.execute(
            tx,
          )
        ).rows;
        return {
          items: rows
            .slice(0, limit)
            .map((r) => ({
              id: r.id,
              artifact_id: r.artifact_id,
              version_id: r.version_id,
              version: r.version,
              recipient_principal_id: r.recipient_principal_id,
              conversation_id: r.target_conversation_id,
              task_id: r.target_task_id,
              expires_at: r.expires_at.toISOString(),
              created_at: r.created_at.toISOString(),
              status: r.status,
            })),
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async openShareDownload(auth: AuthContext, id: string) {
      const initial = await transaction(auth, (tx) => shareAccess(tx, auth, id));
      async function* chunks() {
        const object = await options.store.read(initial.content.object_key);
        try {
          if (object.size !== initial.content.byte_size) fail('SERVICE_UNAVAILABLE', 503);
          let size = 0;
          for await (const block of object.body)
            for (let offset = 0; offset < block.byteLength; offset += 65536) {
              const bytes = block.subarray(offset, offset + 65536);
              await transaction(auth, async (tx) => {
                const current = await shareAccess(tx, auth, id);
                if (
                  current.share.version !== initial.share.version ||
                  current.content.sha256 !== initial.content.sha256
                )
                  fail('NOT_FOUND', 404);
              });
              size += bytes.byteLength;
              if (size > initial.content.byte_size) fail('SERVICE_UNAVAILABLE', 503);
              yield bytes;
            }
          if (size !== initial.content.byte_size) fail('SERVICE_UNAVAILABLE', 503);
        } finally {
          object.close();
        }
      }
      return {
        metadata: shareDto(initial.share, initial.v, initial.content),
        stream: Readable.from(chunks()),
        chunks,
      };
    },
    async revokeShare(auth: AuthContext, id: string, version: string, key: string) {
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'artifact.share.revoke', key, { id, version }, async () => {
          const r = (
            await sql<ShareRow>`select * from artifact_shares where id=${id} for update`.execute(tx)
          ).rows[0];
          if (!r || r.created_by !== auth.principalId) fail('NOT_FOUND', 404);
          if (r.version !== version || r.status !== 'active') fail('VERSION_CONFLICT', 409);
          await recordPolicy(tx, auth, options.policyLedger, {
            kind: 'revocation.artifact_share',
            target_id: id,
            target_version: version,
          });
          await sql`update artifact_shares set status='revoked',version=version+1,revoked_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'artifact_share',
            aggregateId: id,
            version: String(BigInt(version) + 1n),
            type: 'artifact.share.revoked',
            payload: { artifact_id: r.artifact_id },
            target: `artifact:${r.artifact_id}`,
          });
          return id;
        });
        return { id, revoked: true as const };
      });
    },
  };
}
export type ArtifactCollaborationService = ReturnType<typeof createArtifactCollaborationService>;
