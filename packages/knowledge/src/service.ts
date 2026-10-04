import { randomUUID } from 'node:crypto';
import {
  command,
  appendEvent,
  CursorCodec,
  recordPolicy,
  purgeDerivedContent,
  type AuthContext,
  type PolicyLedger,
} from '@imbox/application';
import { sql, withTenant, lockTaskRoots, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { authorizeResourceScope } from '@imbox/resources';
import {
  authorize,
  authorizationBinding,
  fail,
  hash,
  json,
  memoryVisible,
  memorySourcesLive,
  normalizeQuery,
  sourceViews,
  type MemoryInput,
  type MemoryRow,
  type SourceRef,
  type SourceView,
} from './shared.js';
export interface KnowledgeSearchQuery {
  q: string;
  kind?: 'message' | 'task' | 'artifact_version' | 'memory';
  workspace_id?: string;
  conversation_id?: string;
  task_id?: string;
  cursor?: string;
  limit?: number;
}
interface StoredSource {
  source_message_id: string | null;
  source_task_id: string | null;
  source_artifact_version_id: string | null;
  source_version: string;
  sha256: string;
  authorization_fence: {
    scope_generation: string;
    creator_member_version: string;
    creator_workspace_version: string;
    creator_principal_version: string;
    creator_authz_revision: string;
  };
}
const asRef = (s: StoredSource): SourceRef => ({
  kind: s.source_message_id ? 'message' : s.source_task_id ? 'task' : 'artifact_version',
  id: (s.source_message_id ?? s.source_task_id ?? s.source_artifact_version_id)!,
  version: s.source_version,
  sha256: s.sha256,
});
const immutableScope = (input: MemoryInput) => ({
  scope: input.scope,
  conversation_id: input.conversation_id ?? null,
  task_id: input.task_id ?? null,
});
const limitValue = (value = 20) => {
  if (!Number.isInteger(value) || value < 1 || value > 50) fail('VALIDATION_FAILED', 400);
  return value;
};
export function createKnowledgeService(options: {
  db: Db;
  cursorSecret: string;
  policyLedger?: PolicyLedger;
}) {
  const codec = new CursorCodec(options.cursorSecret);
  const row = async (tx: Tx, id: string) =>
    (await sql<MemoryRow>`select * from memory_items where id=${id}`.execute(tx)).rows[0] ??
    fail('NOT_FOUND', 404);
  const storedSources = async (tx: Tx, id: string, version: string) =>
    (
      await sql<StoredSource>`select * from memory_sources where memory_id=${id} and memory_version=${version} order by ordinal`.execute(
        tx,
      )
    ).rows;
  async function lockRoots(
    tx: Tx,
    auth: AuthContext,
    refs: SourceRef[],
    extraTask?: string | null,
  ) {
    const taskIds = refs.filter((r) => r.kind === 'task').map((r) => r.id);
    if (extraTask) taskIds.push(extraTask);
    const artifactIds = refs.filter((r) => r.kind === 'artifact_version').map((r) => r.id);
    const roots = (
      await sql<{
        root_task_id: string;
      }>`select distinct t.root_task_id from tasks t where t.id=any(${taskIds}::uuid[]) or t.id in (select a.task_id from artifact_versions av join artifacts a on a.tenant_id=av.tenant_id and a.id=av.artifact_id where av.id=any(${artifactIds}::uuid[]))`.execute(
        tx,
      )
    ).rows;
    await lockTaskRoots(
      tx,
      auth.tenantId,
      roots.map((r) => r.root_task_id),
    );
  }
  async function scope(
    tx: Tx,
    auth: AuthContext,
    m: Pick<MemoryRow, 'scope' | 'created_by' | 'conversation_id' | 'task_id'>,
    write = false,
    createdAt?: Date,
  ) {
    if (m.scope === 'personal') {
      if (m.created_by !== auth.principalId) fail('NOT_FOUND', 404);
      return;
    }
    await authorizeResourceScope(tx, auth, m, write, createdAt);
  }
  async function source(tx: Tx, auth: AuthContext, ref: SourceRef, expectedGeneration?: string) {
    let current = (
      await sql<SourceView>`select * from (${sourceViews(auth)}) sv where sv.kind=${ref.kind} and sv.id=${ref.id}`.execute(
        tx,
      )
    ).rows[0];
    if (!current) fail('NOT_FOUND', 404);
    await authorizeResourceScope(tx, auth, current!);
    if (ref.kind === 'message')
      await sql`select id from messages where id=${ref.id} for share`.execute(tx);
    if (ref.kind === 'artifact_version')
      await sql`select r.id from artifact_versions av join resources r on r.tenant_id=av.tenant_id and r.id=av.resource_id where av.id=${ref.id} for share of r`.execute(
        tx,
      );
    current = (
      await sql<SourceView>`select * from (${sourceViews(auth)}) sv where sv.kind=${ref.kind} and sv.id=${ref.id}`.execute(
        tx,
      )
    ).rows[0];
    if (!current) fail('NOT_FOUND', 404);
    if (current!.version !== ref.version || current!.sha256 !== ref.sha256)
      fail('VERSION_CONFLICT', 409);
    if (expectedGeneration !== undefined && current!.scope_generation !== expectedGeneration)
      fail('NOT_FOUND', 404);
    return current!;
  }
  async function verifyRefs(tx: Tx, auth: AuthContext, input: MemoryInput) {
    const result = [];
    for (const ref of input.source_refs) {
      const current = await source(tx, auth, ref);
      if (
        input.scope === 'conversation' &&
        (current.conversation_id !== input.conversation_id || current.task_id)
      )
        fail('DISCLOSURE_DENIED', 403);
      if (input.scope === 'task' && (current.task_id !== input.task_id || current.conversation_id))
        fail('DISCLOSURE_DENIED', 403);
      result.push(current);
    }
    return result;
  }
  function validate(input: MemoryInput) {
    if (
      !['personal', 'conversation', 'task'].includes(input.scope) ||
      !input.body ||
      input.body.length > 32000 ||
      !Array.isArray(input.source_refs) ||
      input.source_refs.length > 20 ||
      new Set(input.source_refs.map((r) => `${r.kind}:${r.id}`)).size !==
        input.source_refs.length ||
      !['confirmed', 'needs_confirmation', 'conflicted'].includes(input.confirmation) ||
      !Number.isInteger(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100 ||
      (input.status !== undefined && !['active', 'disabled'].includes(input.status))
    )
      fail('VALIDATION_FAILED', 400);
    if (
      (input.scope === 'personal' && (input.conversation_id || input.task_id)) ||
      (input.scope === 'conversation' && (!input.conversation_id || input.task_id)) ||
      (input.scope === 'task' && (!input.task_id || input.conversation_id))
    )
      fail('VALIDATION_FAILED', 400);
    if (
      input.expires_at &&
      (!Number.isFinite(Date.parse(input.expires_at)) || Date.parse(input.expires_at) <= Date.now())
    )
      fail('VALIDATION_FAILED', 400);
    for (const ref of input.source_refs)
      if (
        !['message', 'task', 'artifact_version'].includes(ref.kind) ||
        !/^[1-9][0-9]*$/.test(ref.version) ||
        !/^[a-f0-9]{64}$/.test(ref.sha256)
      )
        fail('VALIDATION_FAILED', 400);
  }
  async function revision(
    tx: Tx,
    auth: AuthContext,
    id: string,
    version: string,
    input: MemoryInput,
    sources: SourceView[],
  ) {
    const principal = await authorize(tx, auth);
    await sql`insert into memory_revisions(tenant_id,memory_id,version,body,sha256,created_by) values(${auth.tenantId},${id},${version},${input.body},${hash(input.body)},${auth.principalId})`.execute(
      tx,
    );
    for (const [i, s] of sources.entries())
      await sql`insert into memory_sources(tenant_id,memory_id,memory_version,ordinal,source_message_id,source_task_id,source_artifact_version_id,source_version,sha256,authorization_fence) values(${auth.tenantId},${id},${version},${i + 1},${s.kind === 'message' ? s.id : null},${s.kind === 'task' ? s.id : null},${s.kind === 'artifact_version' ? s.id : null},${s.version},${s.sha256},${json({ scope_generation: s.scope_generation, creator_member_version: s.member_version, creator_workspace_version: s.workspace_version, creator_principal_version: principal.version, creator_authz_revision: auth.authzRevision })}::jsonb)`.execute(
        tx,
      );
  }
  async function dto(tx: Tx, auth: AuthContext, id: string) {
    const initial = await row(tx, id);
    const refs = await storedSources(tx, id, initial.version);
    await lockRoots(tx, auth, refs.map(asRef), initial.task_id);
    await scope(tx, auth, initial, false, initial.created_at);
    const current = (
      await sql<
        MemoryRow & { live: boolean }
      >`select *,expires_at is null or expires_at>clock_timestamp() as live from memory_items where id=${id} for share`.execute(
        tx,
      )
    ).rows[0]!;
    if (current.version !== initial.version) fail('VERSION_CONFLICT', 409);
    if (['deleted', 'restricted'].includes(current.status) || !current.live) fail('NOT_FOUND', 404);
    for (const ref of refs) {
      await source(tx, auth, asRef(ref), ref.authorization_fence.scope_generation);
      const creator = (
        await sql<{
          kind: AuthContext['kind'];
          authz_revision: string;
        }>`select p.kind,tp.authz_revision from principals p join tenant_principals tp on tp.principal_id=p.id where p.id=${current.created_by} and tp.status='active'`.execute(
          tx,
        )
      ).rows[0];
      if (!creator || creator.authz_revision !== ref.authorization_fence.creator_authz_revision)
        fail('NOT_FOUND', 404);
      const creatorAuth: AuthContext = {
        principalId: current.created_by,
        tenantId: auth.tenantId,
        kind: creator!.kind,
        authzRevision: creator!.authz_revision,
      };
      const principal = await authorize(tx, creatorAuth);
      if (principal.version !== ref.authorization_fence.creator_principal_version)
        fail('NOT_FOUND', 404);
      const original = await source(
        tx,
        creatorAuth,
        asRef(ref),
        ref.authorization_fence.scope_generation,
      );
      if (
        original.member_version !== ref.authorization_fence.creator_member_version ||
        original.workspace_version !== ref.authorization_fence.creator_workspace_version
      )
        fail('NOT_FOUND', 404);
    }
    const r = (
      await sql<{
        body: string;
        sha256: string;
        redacted_at: Date | null;
      }>`select body,sha256,redacted_at from memory_revisions where memory_id=${id} and version=${current.version}`.execute(
        tx,
      )
    ).rows[0]!;
    if (r.redacted_at) fail('NOT_FOUND', 404);
    return {
      id: current.id,
      created_by: current.created_by,
      scope: current.scope,
      conversation_id: current.conversation_id,
      task_id: current.task_id,
      version: current.version,
      status: current.status as 'active' | 'disabled',
      confirmation: current.confirmation,
      confidence: current.confidence,
      expires_at: current.expires_at?.toISOString() ?? null,
      created_at: current.created_at.toISOString(),
      updated_at: current.updated_at.toISOString(),
      body: r.body,
      sha256: r.sha256,
      source_refs: refs.map(asRef),
      trust_level: 'user_content' as const,
      instruction_authority: 'none' as const,
    };
  }
  const txFor = <T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>) =>
    withTenant(options.db, auth.tenantId, async (tx) => {
      await authorize(tx, auth);
      return fn(tx);
    });
  return {
    async readSourceTx(tx: Tx, auth: AuthContext, ref: SourceRef) {
      await authorize(tx, auth);
      await lockRoots(tx, auth, [ref]);
      const value = await source(tx, auth, ref);
      if (ref.kind === 'artifact_version') {
        const indexed = (
          await sql`select 1 from artifact_versions av join resources r on r.tenant_id=av.tenant_id and r.id=av.resource_id join resource_text_documents d on d.tenant_id=r.tenant_id and d.resource_id=r.id and d.resource_version=r.version and d.sha256=r.sha256 where av.id=${ref.id}`.execute(
            tx,
          )
        ).rows.length;
        if (!indexed) fail('SERVICE_UNAVAILABLE', 503);
      }
      return {
        ...value,
        trust_level: 'user_content' as const,
        instruction_authority: 'none' as const,
      };
    },
    async readMemoryTx(tx: Tx, auth: AuthContext, id: string) {
      await authorize(tx, auth);
      const value = await dto(tx, auth, id);
      if (value.status !== 'active' || value.confirmation !== 'confirmed') fail('FORBIDDEN', 403);
      return value;
    },
    async createMemory(auth: AuthContext, input: MemoryInput, key: string) {
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      validate(input);
      return txFor(auth, async (tx) => {
        const id = await command(tx, auth, 'memory.create', key, input, async () => {
          await lockRoots(tx, auth, input.source_refs, input.task_id);
          await scope(tx, auth, { ...immutableScope(input), created_by: auth.principalId }, true);
          const sources = await verifyRefs(tx, auth, input);
          const id = randomUUID();
          await sql`insert into memory_items(tenant_id,id,created_by,scope,conversation_id,task_id,status,confirmation,confidence,expires_at) values(${auth.tenantId},${id},${auth.principalId},${input.scope},${input.conversation_id ?? null},${input.task_id ?? null},${input.status ?? 'active'},${input.confirmation},${input.confidence},${input.expires_at ?? null})`.execute(
            tx,
          );
          await revision(tx, auth, id, '1', input, sources);
          await appendEvent(tx, auth, {
            aggregateType: 'memory',
            aggregateId: id,
            version: '1',
            type: 'memory.created',
            payload: {},
            target: `memory:${id}`,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async updateMemory(
      auth: AuthContext,
      id: string,
      input: MemoryInput,
      version: string,
      key: string,
    ) {
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      validate(input);
      return txFor(auth, async (tx) => {
        await command(tx, auth, 'memory.update', key, { id, input, version }, async () => {
          const initial = await row(tx, id);
          if (initial.created_by !== auth.principalId) fail('FORBIDDEN', 403);
          if (
            json(immutableScope(input)) !==
            json({
              scope: initial.scope,
              conversation_id: initial.conversation_id,
              task_id: initial.task_id,
            })
          )
            fail('DISCLOSURE_DENIED', 403);
          await lockRoots(tx, auth, input.source_refs, initial.task_id);
          await scope(tx, auth, initial, true);
          const current = (
            await sql<MemoryRow>`select * from memory_items where id=${id} for update`.execute(tx)
          ).rows[0]!;
          if (current.version !== version || current.deleted_at) fail('VERSION_CONFLICT', 409);
          const sources = await verifyRefs(tx, auth, input);
          const next = String(BigInt(version) + 1n);
          await revision(tx, auth, id, next, input, sources);
          await sql`update memory_items set version=${next},status=${input.status ?? 'active'},confirmation=${input.confirmation},confidence=${input.confidence},expires_at=${input.expires_at ?? null},updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'memory',
            aggregateId: id,
            version: next,
            type: 'memory.updated',
            payload: {},
            target: `memory:${id}`,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async getMemory(auth: AuthContext, id: string) {
      return txFor(auth, (tx) => dto(tx, auth, id));
    },
    async deleteMemory(auth: AuthContext, id: string, version: string, key: string) {
      if (auth.kind !== 'human' || auth.machine) fail('FORBIDDEN', 403);
      return txFor(auth, async (tx) => {
        await command(tx, auth, 'memory.delete', key, { id, version }, async () => {
          const initial = await row(tx, id);
          if (initial.created_by !== auth.principalId) fail('FORBIDDEN', 403);
          await lockRoots(tx, auth, [], initial.task_id);
          await scope(tx, auth, initial);
          const current = (
            await sql<MemoryRow>`select * from memory_items where id=${id} for update`.execute(tx)
          ).rows[0]!;
          if (current.version !== version || current.deleted_at) fail('VERSION_CONFLICT', 409);
          await recordPolicy(tx, auth, options.policyLedger, {
            kind: 'deletion.memory',
            target_id: id,
            target_version: version,
          });
          await sql`update memory_items set status='deleted',version=version+1,deleted_at=clock_timestamp(),updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await sql`update memory_revisions set body='',redacted_at=clock_timestamp() where memory_id=${id}`.execute(
            tx,
          );
          await purgeDerivedContent(tx, 'deletion.memory', id);
          await sql`insert into knowledge_deletion_receipts(tenant_id,id,memory_id,reason) values(${auth.tenantId},${randomUUID()},${id},'explicit')`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'memory',
            aggregateId: id,
            version: String(BigInt(version) + 1n),
            type: 'memory.deleted',
            payload: {},
            target: `memory:${id}`,
          });
          return id;
        });
        return { id, deleted: true as const };
      });
    },
    async listMemories(
      auth: AuthContext,
      query: { conversation_id?: string; task_id?: string; cursor?: string; limit?: number } = {},
    ) {
      const limit = limitValue(query.limit);
      return txFor(auth, async (tx) => {
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          await authorizationBinding(tx, auth),
          'memories',
          query.conversation_id ?? null,
          query.task_id ?? null,
        ]);
        const after = query.cursor
          ? codec.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
            task_id: string | null;
          }>`with source_view as not materialized (${sourceViews(auth)}) select mi.id,mi.task_id from memory_items mi where mi.id>${after}::uuid and mi.status in ('active','disabled') and (mi.expires_at is null or mi.expires_at>clock_timestamp()) and ${memoryVisible(auth)} and ${memorySourcesLive()} ${query.conversation_id ? sql`and mi.conversation_id=${query.conversation_id}` : sql``} ${query.task_id ? sql`and mi.task_id=${query.task_id}` : sql``} order by mi.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const refs: SourceRef[] = [];
        for (const item of rows.slice(0, limit)) {
          refs.push(
            ...(await storedSources(tx, item.id, (await row(tx, item.id)).version)).map(asRef),
          );
          if (item.task_id) refs.push({ kind: 'task', id: item.task_id, version: '1', sha256: '' });
        }
        await lockRoots(tx, auth, refs);
        const items = [];
        for (const item of rows.slice(0, limit)) items.push(await dto(tx, auth, item.id));
        return {
          items,
          ...(rows.length > limit
            ? { next_cursor: codec.encode(binding, rows[limit - 1]!.id) }
            : {}),
        };
      });
    },
    async search(auth: AuthContext, query: KnowledgeSearchQuery) {
      const q = normalizeQuery(query.q);
      const limit = limitValue(query.limit);
      if (q.length < 2 || q.length > 200 || (query.conversation_id && query.task_id))
        fail('VALIDATION_FAILED', 400);
      return txFor(auth, async (tx) => {
        await sql`set local statement_timeout='5s'`.execute(tx);
        const principal = await authorize(tx, auth);
        const binding = json([
          auth.tenantId,
          auth.principalId,
          auth.authzRevision,
          principal.version,
          await authorizationBinding(tx, auth),
          'search',
          q,
          query.kind ?? null,
          query.workspace_id ?? null,
          query.conversation_id ?? null,
          query.task_id ?? null,
        ]);
        let after = { kind: '', id: '00000000-0000-0000-0000-000000000000' };
        if (query.cursor) {
          try {
            after = JSON.parse(codec.decode(query.cursor, binding)) as typeof after;
          } catch {
            fail('RESYNC_REQUIRED', 409);
          }
          if (
            !['message', 'task', 'artifact_version', 'memory'].includes(after.kind) ||
            !/^[a-f0-9-]{36}$/.test(after.id)
          )
            fail('RESYNC_REQUIRED', 409);
        }
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        const candidates = (
          await sql<
            Omit<SourceView, 'kind'> & { kind: SourceView['kind'] | 'memory' }
          >`with source_view as not materialized (${sourceViews(auth)}),visible as (
    select sv.* from source_view sv
    union all select 'memory',mi.id,mi.version,mr.sha256,mr.body,left(mr.body,200),mi.conversation_id,mi.task_id,coalesce(c.workspace_id,t.workspace_id),mi.version,0::bigint,0::bigint,mi.created_at from memory_items mi join memory_revisions mr on mr.tenant_id=mi.tenant_id and mr.memory_id=mi.id and mr.version=mi.version left join conversations c on c.tenant_id=mi.tenant_id and c.id=mi.conversation_id left join tasks t on t.tenant_id=mi.tenant_id and t.id=mi.task_id where mi.status='active' and mi.confirmation='confirmed' and (mi.expires_at is null or mi.expires_at>clock_timestamp()) and mr.redacted_at is null and ${memoryVisible(auth)} and ${memorySourcesLive()}
   ) select * from visible v where (v.kind>${after.kind} or (v.kind=${after.kind} and v.id>${after.id}::uuid)) and (imbox_search_normalize(v.title||' '||v.body) like ${pattern} escape '\\' or to_tsvector('simple',imbox_search_normalize(v.title||' '||v.body)) @@ plainto_tsquery('simple',${q})) ${query.kind ? sql`and v.kind=${query.kind}` : sql``} ${query.workspace_id ? sql`and v.workspace_id=${query.workspace_id}` : sql``} ${query.conversation_id ? sql`and v.conversation_id=${query.conversation_id}` : sql``} ${query.task_id ? sql`and v.task_id=${query.task_id}` : sql``} order by v.kind,v.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const refs: SourceRef[] = [];
        for (const c of candidates.slice(0, limit)) {
          if (c.kind === 'memory')
            refs.push(...(await storedSources(tx, c.id, c.version)).map(asRef));
          else refs.push({ kind: c.kind, id: c.id, version: c.version, sha256: c.sha256 });
          if (c.task_id) refs.push({ kind: 'task', id: c.task_id, version: '1', sha256: '' });
        }
        await lockRoots(tx, auth, refs);
        const items = [];
        for (const c of candidates.slice(0, limit)) {
          if (c.kind === 'memory') {
            const memory = await dto(tx, auth, c.id);
            if (
              memory.version !== c.version ||
              memory.status !== 'active' ||
              memory.confirmation !== 'confirmed'
            )
              fail('RESYNC_REQUIRED', 409);
          } else
            await source(
              tx,
              auth,
              { kind: c.kind, id: c.id, version: c.version, sha256: c.sha256 },
              c.scope_generation,
            );
          const artifact =
            c.kind === 'artifact_version'
              ? (
                  await sql<{
                    artifact_id: string;
                  }>`select artifact_id from artifact_versions where id=${c.id}`.execute(tx)
                ).rows[0]?.artifact_id
              : undefined;
          const offset = Math.max(0, normalizeQuery(c.body).indexOf(q) - 80);
          items.push({
            kind: c.kind,
            id: c.id,
            version: c.version,
            sha256: c.sha256,
            title: c.title.slice(0, 400),
            snippet: c.body.slice(offset, offset + 600),
            conversation_id: c.conversation_id,
            task_id: c.task_id,
            ...(artifact ? { artifact_id: artifact } : {}),
            trust_level: 'user_content' as const,
            instruction_authority: 'none' as const,
          });
        }
        const last = candidates[limit - 1];
        return {
          items,
          ...(candidates.length > limit && last
            ? { next_cursor: codec.encode(binding, json({ kind: last.kind, id: last.id })) }
            : {}),
        };
      });
    },
  };
}
export type KnowledgeService = ReturnType<typeof createKnowledgeService>;
