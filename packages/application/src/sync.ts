import { presentMessage, reactionSummary, messageEdition } from './message-presentation.js';
import { randomUUID } from 'node:crypto';
import { assertContract, type ContractTypes } from '@imbox/contracts';
import {
  allocateStreamSequence,
  sql,
  withTenant,
  type Db,
  type TenantTransaction,
} from '@imbox/db';
import {
  authorizeTenant,
  authorizeConversation,
  CursorCodec,
  fail,
  type AuthContext,
} from './common.js';

const consumer = 'conversation-projector:v1';
const positiveLimit = (value = 100) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) fail('VALIDATION_FAILED', 400);
  return value;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^(0|[1-9][0-9]{0,18})$/;

async function streamAccess(tx: TenantTransaction, auth: AuthContext, streamId: string) {
  await authorizeTenant(tx, auth);
  const access = await authorizeConversation(tx, auth, streamId);
  const conversation = access.row;
  const member = access.member;
  const stream = await tx
    .selectFrom('projection_streams')
    .selectAll()
    .where('tenant_id', '=', auth.tenantId)
    .where('id', '=', streamId)
    .forShare()
    .executeTakeFirst();
  if (
    !stream ||
    stream.scope_type !== 'conversation' ||
    stream.scope_id !== streamId ||
    stream.authz_generation !== conversation.authz_generation
  )
    return fail('RESYNC_REQUIRED', 409);
  return { stream, member };
}
type Access = Awaited<ReturnType<typeof streamAccess>>;
function binding(
  auth: AuthContext,
  access: Access,
  purpose: 'events' | 'snapshot' | 'snapshot:recent',
) {
  return JSON.stringify([
    auth.tenantId,
    auth.principalId,
    auth.authzRevision,
    access.stream.id,
    access.stream.authz_generation,
    access.stream.retention_generation,
    access.member.version,
    access.member.visible_from_seq,
    purpose,
  ]);
}
function scopedPayload(payload: unknown, generation: string): ContractTypes['ProjectionPayload'] {
  const value = assertContract('ProjectionPayload', payload);
  return {
    ...value,
    ...(value.message ? { message: { ...value.message, authz_generation: generation } } : {}),
    ...(value.conversation
      ? { conversation: { ...value.conversation, authz_generation: generation } }
      : {}),
  };
}
async function envelope(
  tx: TenantTransaction,
  access: Access,
  row: {
    projection_id: string;
    projection_revision: string;
    entity_type: string;
    entity_id: string;
    entity_version: string;
    event_id: string;
    payload: unknown;
    retracted: boolean;
  },
  cursor: string,
) {
  return assertContract('ProjectionEnvelope', {
    type: row.retracted ? 'projection.remove' : 'projection.upsert',
    protocol_version: 1,
    schema_version: 1,
    stream_id: access.stream.id,
    view_scope: access.stream.id,
    authz_generation: access.stream.authz_generation,
    projection_id: row.projection_id,
    projection_revision: row.projection_revision,
    event_id: row.event_id,
    entity: { type: row.entity_type, id: row.entity_id, version: row.entity_version },
    cursor,
    payload: await (async () => {
      const payload = scopedPayload(row.payload, access.stream.authz_generation);
      return {
        ...payload,
        ...(payload.message
          ? { message: await presentMessage(tx, payload.message, access.member.visible_from_seq) }
          : {}),
      };
    })(),
  });
}

async function retrySnapshot<T>(execute: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await execute();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!['40001', '40P01'].includes(String(code))) throw error;
    }
  }
  return fail('SERVICE_UNAVAILABLE', 503);
}

export function createSyncService(options: {
  db: Db;
  cursorSecret: string;
  snapshotTtlSeconds?: number;
}) {
  const cursors = new CursorCodec(options.cursorSecret);
  const snapshotTtlSeconds = options.snapshotTtlSeconds ?? 600;
  if (!Number.isInteger(snapshotTtlSeconds) || snapshotTtlSeconds < 10 || snapshotTtlSeconds > 3600)
    throw new Error('Snapshot TTL must be 10..3600 seconds');
  return {
    async snapshot(
      auth: AuthContext,
      streamId: string,
      query: { cursor?: string; limit?: number; window?: 'recent' } = {},
    ) {
      const limit = positiveLimit(query.limit);
      return retrySnapshot(() =>
        withTenant(
          options.db,
          auth.tenantId,
          async (tx) => {
            const access = await streamAccess(tx, auth, streamId);
            if (query.window !== undefined && query.window !== 'recent')
              return fail('VALIDATION_FAILED', 400);
            const snapshotBinding = binding(
              auth,
              access,
              query.window === 'recent' ? 'snapshot:recent' : 'snapshot',
            );
            let snapshotId: string;
            let afterOrdinal = '0';
            if (query.cursor) {
              let position: { id?: unknown; after?: unknown };
              try {
                position = JSON.parse(
                  cursors.decode(query.cursor, snapshotBinding),
                ) as typeof position;
              } catch {
                return fail('RESYNC_REQUIRED', 409);
              }
              if (
                typeof position.id !== 'string' ||
                !uuidPattern.test(position.id) ||
                typeof position.after !== 'string' ||
                !decimal.test(position.after)
              )
                return fail('RESYNC_REQUIRED', 409);
              snapshotId = position.id;
              afterOrdinal = position.after;
            } else {
              snapshotId = randomUUID();
              const headCursor = cursors.encode(
                binding(auth, access, 'events'),
                access.stream.head_seq,
              );
              await tx
                .insertInto('sync_snapshot_sessions')
                .values({
                  tenant_id: auth.tenantId,
                  id: snapshotId,
                  principal_id: auth.principalId,
                  stream_id: streamId,
                  authz_revision: auth.authzRevision,
                  authz_generation: access.stream.authz_generation,
                  retention_generation: access.stream.retention_generation,
                  head_seq: access.stream.head_seq,
                  head_cursor: headCursor,
                  window_mode: query.window ?? 'all',
                  expires_at: sql<Date>`clock_timestamp() + ${snapshotTtlSeconds} * interval '1 second'`,
                })
                .execute();
              // Materialize the exact projection MVCC snapshot, not live message rows on later pages.
              // Source rows are joined only for current disclosure/tombstone gating, never for their body.
              await sql`with selected_messages as (
                select p.* from projections p join messages m on m.tenant_id=p.tenant_id and m.id=p.entity_id
                where p.tenant_id=${auth.tenantId}::uuid and p.stream_id=${streamId}::uuid and p.entity_type='message' and p.source_event_id is not null
                and m.seq>=${access.member.visible_from_seq}::bigint and (m.deleted_at is null or p.retracted)
                and not exists(select 1 from jsonb_array_elements_text(coalesce(p.dto->'message'->'attachment_ids','[]'::jsonb)) a(id) left join resources r on r.tenant_id=p.tenant_id and r.id=a.id::uuid where r.id is null or r.deleted_at is not null)
                order by p.source_seq desc,p.id desc limit ${query.window === 'recent' ? 201 : null}
              ),selected_projections as (
                select * from selected_messages union all select p.* from projections p where p.tenant_id=${auth.tenantId}::uuid and p.stream_id=${streamId}::uuid and p.entity_type='conversation' and p.source_event_id is not null
              ) insert into sync_snapshot_items(tenant_id,snapshot_id,ordinal,projection_id,projection_revision,entity_type,entity_id,entity_version,event_id,payload,retracted)
                select p.tenant_id,${snapshotId}::uuid,row_number() over(order by case when p.entity_type='conversation' then 0 else 1 end,p.source_seq nulls first,p.id),p.id,p.revision,p.entity_type,p.entity_id,p.entity_version,p.source_event_id,p.dto,p.retracted from selected_projections p`.execute(
                tx,
              );
              if (query.window === 'recent') {
                const count = (
                  await sql<{
                    n: string;
                  }>`select count(*)::text n from sync_snapshot_items where snapshot_id=${snapshotId} and entity_type='message'`.execute(
                    tx,
                  )
                ).rows[0]!;
                if (Number(count.n) > 200) {
                  await sql`delete from sync_snapshot_items where snapshot_id=${snapshotId} and ordinal=(select min(ordinal) from sync_snapshot_items where snapshot_id=${snapshotId} and entity_type='message')`.execute(
                    tx,
                  );
                  await sql`update sync_snapshot_sessions set history_truncated=true where id=${snapshotId}`.execute(
                    tx,
                  );
                }
              }
            }
            const session = await tx
              .selectFrom('sync_snapshot_sessions')
              .selectAll()
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', snapshotId)
              .where('window_mode', '=', query.window ?? 'all')
              .where('principal_id', '=', auth.principalId)
              .where('stream_id', '=', streamId)
              .where('authz_revision', '=', auth.authzRevision)
              .where('authz_generation', '=', access.stream.authz_generation)
              .where('retention_generation', '=', access.stream.retention_generation)
              .where('expires_at', '>', sql<Date>`clock_timestamp()`)
              .executeTakeFirst();
            if (!session) return fail('RESYNC_REQUIRED', 409);
            const rows = await tx
              .selectFrom('sync_snapshot_items')
              .selectAll()
              .where('tenant_id', '=', auth.tenantId)
              .where('snapshot_id', '=', snapshotId)
              .where('ordinal', '>', afterOrdinal)
              .orderBy('ordinal')
              .limit(limit + 1)
              .execute();
            const selected = rows.slice(0, limit);
            const complete = rows.length <= limit;
            return assertContract('StreamSnapshot', {
              stream_id: streamId,
              view_scope: streamId,
              authz_generation: access.stream.authz_generation,
              snapshot_id: snapshotId,
              ...(query.window === 'recent'
                ? { window: 'recent', history_truncated: session.history_truncated }
                : {}),
              items: await Promise.all(
                selected.map((row) => envelope(tx, access, row, session.head_cursor)),
              ),
              cursor: session.head_cursor,
              complete,
              ...(!complete
                ? {
                    next_cursor: cursors.encode(
                      snapshotBinding,
                      JSON.stringify({ id: snapshotId, after: selected.at(-1)!.ordinal }),
                    ),
                  }
                : {}),
            });
          },
          { isolationLevel: 'repeatable read' },
        ),
      );
    },
    async events(auth: AuthContext, streamId: string, query: { cursor: string; limit?: number }) {
      const limit = positiveLimit(query.limit);
      return withTenant(options.db, auth.tenantId, async (tx) => {
        const access = await streamAccess(tx, auth, streamId);
        const eventBinding = binding(auth, access, 'events');
        const after = cursors.decode(query.cursor, eventBinding);
        if (!decimal.test(after) || BigInt(after) > BigInt(access.stream.head_seq))
          return fail('RESYNC_REQUIRED', 409);
        // streamAccess holds the current authorization and stream row locks in this transaction.
        // An authenticated cursor already at that head cannot have undispatched rows to read.
        if (after === access.stream.head_seq)
          return assertContract('StreamEvents', {
            stream_id: streamId,
            view_scope: streamId,
            authz_generation: access.stream.authz_generation,
            items: [],
            cursor: query.cursor,
            has_more: false,
          });
        // Filter before LIMIT: a page never reveals the number of hidden/history-excluded deliveries.
        const rows = await tx
          .selectFrom('projection_deliveries as d')
          .innerJoin('projections as p', (join) =>
            join
              .onRef('p.tenant_id', '=', 'd.tenant_id')
              .onRef('p.stream_id', '=', 'd.stream_id')
              .onRef('p.id', '=', 'd.projection_id'),
          )
          .leftJoin('messages as m', (join) =>
            join
              .onRef('m.tenant_id', '=', 'p.tenant_id')
              .onRef('m.id', '=', 'p.entity_id')
              .on('p.entity_type', '=', 'message'),
          )
          .select([
            'd.delivery_seq',
            'd.projection_id',
            'd.revision as projection_revision',
            'd.event_id',
            'd.dto as payload',
            'd.retracted',
            'p.entity_type',
            'p.entity_id',
          ])
          .select(sql<string>`(d.dto->>'entity_version')`.as('stored_entity_version'))
          .where('d.tenant_id', '=', auth.tenantId)
          .where('d.stream_id', '=', streamId)
          .where('d.delivery_seq', '>', after)
          .where('d.authz_generation', '=', access.stream.authz_generation)
          .where((eb) =>
            eb.or([
              eb('p.entity_type', '=', 'conversation'),
              eb.and([
                eb('p.entity_type', '=', 'message'),
                eb('m.seq', '>=', access.member.visible_from_seq),
                eb.or([eb('m.deleted_at', 'is', null), eb('d.retracted', '=', true)]),
              ]),
            ]),
          )
          .where(
            sql<boolean>`not exists(select 1 from jsonb_array_elements_text(coalesce(d.dto->'payload'->'message'->'attachment_ids','[]'::jsonb)) a(id) left join resources r on r.tenant_id=d.tenant_id and r.id=a.id::uuid where r.id is null or r.deleted_at is not null)`,
          )
          .orderBy('d.delivery_seq')
          .limit(limit + 1)
          .execute();
        const selected = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        const position = hasMore ? selected.at(-1)!.delivery_seq : access.stream.head_seq;
        const items = await Promise.all(
          selected.map((row) => {
            const stored = row.payload as { payload: unknown; entity_version: string };
            return envelope(
              tx,
              access,
              { ...row, payload: stored.payload, entity_version: row.stored_entity_version },
              cursors.encode(eventBinding, row.delivery_seq),
            );
          }),
        );
        return assertContract('StreamEvents', {
          stream_id: streamId,
          view_scope: streamId,
          authz_generation: access.stream.authz_generation,
          items,
          // Preserve an unchanged opaque position. Re-encrypting it on every empty poll
          // gives identical readers different keys and prevents concurrent-read sharing.
          cursor: position === after ? query.cursor : cursors.encode(eventBinding, position),
          has_more: hasMore,
        });
      });
    },
    async subscribe(auth: AuthContext, streamId: string, cursor: string) {
      const result = await this.events(auth, streamId, { cursor, limit: 1 });
      // Subscription acknowledges the caller's starting cursor, not the probe's advanced position.
      return assertContract('WsSubscribed', {
        type: 'subscribed',
        stream_id: streamId,
        authz_generation: result.authz_generation,
        cursor,
      });
    },
  };
}
export type SyncService = ReturnType<typeof createSyncService>;

export interface OutboxClaim {
  tenantId: string;
  id: string;
  holder: string;
  generation: string;
  target?: string;
}
export type OutboxResult = 'completed' | 'deferred' | 'stale' | 'failed';
class LeaseLost extends Error {}

export function createOutboxProcessor(options: {
  db: Db;
  holder?: string;
  leaseSeconds?: number;
  concurrency?: number;
}) {
  const holder = options.holder ?? randomUUID();
  const leaseSeconds = options.leaseSeconds ?? 30;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Outbox concurrency must be 1..8');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
    throw new Error('Outbox lease must be 1..300 seconds');
  async function claimBatch(tenantId: string, limit = 50): Promise<OutboxClaim[]> {
    positiveLimit(limit);
    return withTenant(options.db, tenantId, async (tx) => {
      const rows = await tx
        .selectFrom('outbox')
        .select(['id', 'target'])
        .where('tenant_id', '=', tenantId)
        .where('target', 'like', 'conversation:%')
        .where((eb) =>
          eb.or([
            eb.and([
              eb('status', '=', 'pending'),
              eb('available_at', '<=', sql<Date>`clock_timestamp()`),
            ]),
            eb.and([
              eb('status', '=', 'leased'),
              eb('lease_expires_at', '<=', sql<Date>`clock_timestamp()`),
            ]),
          ]),
        )
        .orderBy('created_at')
        .orderBy('id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (!rows.length) return [];
      const leased = await tx
        .updateTable('outbox')
        .set({
          status: 'leased',
          lease_holder: holder,
          lease_generation: sql`lease_generation + 1`,
          attempts: sql`attempts + 1`,
          updated_at: sql`clock_timestamp()`,
          lease_expires_at: sql<Date>`clock_timestamp() + ${leaseSeconds} * interval '1 second'`,
        })
        .where('tenant_id', '=', tenantId)
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .returning(['id', 'lease_generation'])
        .execute();
      const generations = new Map(leased.map((row) => [row.id, row.lease_generation]));
      return rows.map((row) => ({
        tenantId,
        id: row.id,
        target: row.target,
        holder,
        generation: generations.get(row.id)!,
      }));
    });
  }
  async function processClaim(claim: OutboxClaim): Promise<OutboxResult> {
    try {
      return await withTenant(options.db, claim.tenantId, async (tx) => {
        const outbox = await tx
          .selectFrom('outbox')
          .selectAll()
          .where('tenant_id', '=', claim.tenantId)
          .where('id', '=', claim.id)
          .where('status', '=', 'leased')
          .where('lease_holder', '=', claim.holder)
          .where('lease_generation', '=', claim.generation)
          .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .forUpdate()
          .executeTakeFirst();
        if (!outbox) return 'stale';
        const event = await tx
          .selectFrom('domain_events')
          .selectAll()
          .where('tenant_id', '=', claim.tenantId)
          .where('id', '=', outbox.event_id)
          .executeTakeFirstOrThrow();
        const streamId = outbox.target.startsWith('conversation:')
          ? outbox.target.slice('conversation:'.length)
          : '';
        if (
          !uuidPattern.test(streamId) ||
          !['conversation', 'message'].includes(event.aggregate_type)
        )
          throw new Error('UNSUPPORTED_EVENT');
        const conversation = await tx
          .selectFrom('conversations')
          .selectAll()
          .where('tenant_id', '=', claim.tenantId)
          .where('id', '=', streamId)
          .forShare()
          .executeTakeFirstOrThrow();
        const receipt = await tx
          .selectFrom('consumer_receipts')
          .select('event_id')
          .where('tenant_id', '=', claim.tenantId)
          .where('consumer', '=', consumer)
          .where('event_id', '=', event.id)
          .where('target_scope', '=', outbox.target)
          .executeTakeFirst();
        let deferred = false;
        if (!receipt) {
          await tx
            .insertInto('projection_checkpoints')
            .values({
              tenant_id: claim.tenantId,
              consumer,
              target_scope: outbox.target,
              aggregate_type: event.aggregate_type,
              aggregate_id: event.aggregate_id,
            })
            .onConflict((conflict) =>
              conflict
                .columns([
                  'tenant_id',
                  'consumer',
                  'target_scope',
                  'aggregate_type',
                  'aggregate_id',
                ])
                .doNothing(),
            )
            .execute();
          const checkpoint = await tx
            .selectFrom('projection_checkpoints')
            .selectAll()
            .where('tenant_id', '=', claim.tenantId)
            .where('consumer', '=', consumer)
            .where('target_scope', '=', outbox.target)
            .where('aggregate_type', '=', event.aggregate_type)
            .where('aggregate_id', '=', event.aggregate_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const nextVersion = BigInt(checkpoint.last_event_version) + 1n;
          if (BigInt(event.aggregate_version) > nextVersion) {
            const missing = await tx
              .selectFrom('domain_events')
              .select('id')
              .where('tenant_id', '=', claim.tenantId)
              .where('aggregate_type', '=', event.aggregate_type)
              .where('aggregate_id', '=', event.aggregate_id)
              .where('aggregate_version', '=', nextVersion.toString())
              .executeTakeFirst();
            if (!missing) throw new Error('MISSING_EVENT');
            deferred = true;
          } else if (BigInt(event.aggregate_version) === nextVersion) {
            let payload: ContractTypes['ProjectionPayload'];
            let entityVersion: string;
            let sourceSeq: string | null = null;
            let retracted = false;
            if (event.aggregate_type === 'message') {
              const eventPayload = event.payload as { conversation_id?: unknown };
              if (eventPayload?.conversation_id !== streamId)
                throw new Error('EVENT_SCOPE_MISMATCH');
              const message = await tx
                .selectFrom('messages')
                .selectAll()
                .where('tenant_id', '=', claim.tenantId)
                .where('id', '=', event.aggregate_id)
                .forShare()
                .executeTakeFirstOrThrow();
              if (message.conversation_id !== streamId) throw new Error('EVENT_SCOPE_MISMATCH');
              const actor = await tx
                .selectFrom('principals')
                .select(['id', 'kind', 'display_name', 'status'])
                .where('id', '=', message.sender_principal_id)
                .executeTakeFirstOrThrow();
              entityVersion = message.version;
              sourceSeq = message.seq;
              retracted = message.deleted_at !== null;
              const dto = assertContract('Message', {
                id: message.id,
                conversation_id: streamId,
                client_message_id: message.client_message_id,
                actor,
                seq: message.seq,
                version: message.version,
                body: retracted ? '' : message.body,
                format: 'text',
                attachment_ids: retracted
                  ? []
                  : (
                      await sql<{
                        resource_id: string;
                      }>`select mr.resource_id from message_resources mr join resources r on r.tenant_id=mr.tenant_id and r.id=mr.resource_id where mr.message_id=${message.id} and r.deleted_at is null and r.version=mr.resource_version and r.conversation_id=${streamId} order by mr.ordinal`.execute(
                        tx,
                      )
                    ).rows.map((row) => row.resource_id),
                reactions: retracted ? [] : await reactionSummary(tx, message.id),
                ...(message.reply_to_id ? { reply_to_id: message.reply_to_id } : {}),
                ...(message.reply_to_version ? { reply_to_version: message.reply_to_version } : {}),
                ...(message.thread_root_id ? { thread_root_id: message.thread_root_id } : {}),
                created_at: message.created_at.toISOString(),
                ...(await messageEdition(tx, message.id)),
                deleted: retracted,
                view_scope: streamId,
                authz_generation: conversation.authz_generation,
                projection_id: message.id,
                projection_revision: message.version,
              });
              payload = {
                summary: retracted ? '' : message.body.slice(0, 4000),
                resource_ref: message.id,
                message: dto,
              };
            } else {
              if (event.aggregate_id !== streamId) throw new Error('EVENT_SCOPE_MISMATCH');
              entityVersion = conversation.version;
              const dto = assertContract('Conversation', {
                id: streamId,
                workspace_id: conversation.workspace_id,
                kind: conversation.kind,
                title: conversation.title,
                version: conversation.version,
                created_at: conversation.created_at.toISOString(),
                history_policy: conversation.history_policy,
                view_scope: streamId,
                authz_generation: conversation.authz_generation,
                projection_id: streamId,
                projection_revision: conversation.version,
              });
              payload = { summary: conversation.title, resource_ref: streamId, conversation: dto };
            }
            if (BigInt(entityVersion) < BigInt(event.aggregate_version))
              throw new Error('EVENT_AHEAD_OF_AUTHORITY');
            // Old queued events may observe newer authority. Attribute the projection to the REAL
            // newer event, never attach new content to an old entity/event version.
            const sourceEvent = await tx
              .selectFrom('domain_events')
              .select('id')
              .where('tenant_id', '=', claim.tenantId)
              .where('aggregate_type', '=', event.aggregate_type)
              .where('aggregate_id', '=', event.aggregate_id)
              .where('aggregate_version', '=', entityVersion)
              .executeTakeFirstOrThrow();
            const stream = await tx
              .selectFrom('projection_streams')
              .selectAll()
              .where('tenant_id', '=', claim.tenantId)
              .where('id', '=', streamId)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (stream.authz_generation !== conversation.authz_generation)
              throw new Error('STREAM_GENERATION_MISMATCH');
            const existing = await tx
              .selectFrom('projections')
              .select(['entity_version'])
              .where('tenant_id', '=', claim.tenantId)
              .where('stream_id', '=', streamId)
              .where('id', '=', event.aggregate_id)
              .executeTakeFirst();
            if (!existing || BigInt(existing.entity_version) < BigInt(entityVersion)) {
              const sequence = await allocateStreamSequence(tx, streamId);
              await tx
                .insertInto('projections')
                .values({
                  tenant_id: claim.tenantId,
                  stream_id: streamId,
                  id: event.aggregate_id,
                  revision: entityVersion,
                  entity_type: event.aggregate_type,
                  entity_id: event.aggregate_id,
                  entity_version: entityVersion,
                  authz_generation: stream.authz_generation,
                  dto: payload,
                  retracted,
                  source_event_id: sourceEvent.id,
                  source_seq: sourceSeq,
                })
                .onConflict((conflict) =>
                  conflict.columns(['tenant_id', 'stream_id', 'id']).doUpdateSet({
                    revision: entityVersion,
                    entity_version: entityVersion,
                    authz_generation: stream.authz_generation,
                    dto: payload,
                    retracted,
                    source_event_id: sourceEvent.id,
                    source_seq: sourceSeq,
                    updated_at: sql`clock_timestamp()`,
                  }),
                )
                .execute();
              await tx
                .insertInto('projection_deliveries')
                .values({
                  tenant_id: claim.tenantId,
                  stream_id: streamId,
                  delivery_seq: sequence,
                  projection_id: event.aggregate_id,
                  revision: entityVersion,
                  event_id: sourceEvent.id,
                  authz_generation: stream.authz_generation,
                  dto: { payload, entity_version: entityVersion },
                  retracted,
                  source_seq: sourceSeq,
                })
                .execute();
            }
            await tx
              .updateTable('projection_checkpoints')
              .set({
                last_event_version: event.aggregate_version,
                updated_at: sql`clock_timestamp()`,
              })
              .where('tenant_id', '=', claim.tenantId)
              .where('consumer', '=', consumer)
              .where('target_scope', '=', outbox.target)
              .where('aggregate_type', '=', event.aggregate_type)
              .where('aggregate_id', '=', event.aggregate_id)
              .execute();
          }
          if (!deferred)
            await tx
              .insertInto('consumer_receipts')
              .values({
                tenant_id: claim.tenantId,
                consumer,
                event_id: event.id,
                target_scope: outbox.target,
              })
              .onConflict((conflict) =>
                conflict.columns(['tenant_id', 'consumer', 'event_id', 'target_scope']).doNothing(),
              )
              .execute();
        }
        const finished = await tx
          .updateTable('outbox')
          .set({
            status: deferred ? 'pending' : 'completed',
            lease_holder: null,
            lease_expires_at: null,
            available_at: sql`clock_timestamp() + interval '50 milliseconds'`,
            updated_at: sql`clock_timestamp()`,
            ...(deferred
              ? { attempts: sql<number>`greatest(attempts - 1, 0)`, last_error_code: 'EVENT_GAP' }
              : { last_error_code: null }),
          })
          .where('tenant_id', '=', claim.tenantId)
          .where('id', '=', claim.id)
          .where('lease_holder', '=', claim.holder)
          .where('lease_generation', '=', claim.generation)
          .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .returning('id')
          .executeTakeFirst();
        if (!finished) throw new LeaseLost();
        return deferred ? 'deferred' : 'completed';
      });
    } catch (error) {
      if (error instanceof LeaseLost) return 'stale';
      await withTenant(options.db, claim.tenantId, async (tx) => {
        await tx
          .updateTable('outbox')
          .set({
            status: sql`CASE WHEN attempts >= 10 THEN 'dead' ELSE 'pending' END`,
            lease_holder: null,
            lease_expires_at: null,
            available_at: sql`clock_timestamp() + least(attempts * attempts, 60) * interval '1 second'`,
            updated_at: sql`clock_timestamp()`,
            last_error_code:
              error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)
                ? error.message
                : 'PROJECTION_FAILED',
          })
          .where('tenant_id', '=', claim.tenantId)
          .where('id', '=', claim.id)
          .where('status', '=', 'leased')
          .where('lease_holder', '=', claim.holder)
          .where('lease_generation', '=', claim.generation)
          .where('lease_expires_at', '>', sql<Date>`clock_timestamp()`)
          .execute();
      });
      return 'failed';
    }
  }
  return {
    claimBatch,
    processClaim,
    async processBatch(tenantId: string, input: { limit?: number } = {}) {
      const claims = await claimBatch(tenantId, input.limit ?? 50);
      const stats = { claimed: claims.length, completed: 0, deferred: 0, stale: 0, failed: 0 };
      // Keep each conversation serial while independent streams make bounded progress.
      const groups = new Map<string, OutboxClaim[]>();
      for (const claim of claims) {
        const key = claim.target ?? claim.id;
        const group = groups.get(key) ?? [];
        group.push(claim);
        groups.set(key, group);
      }
      const pending = [...groups.values()];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
          while (next < pending.length) {
            const group = pending[next++]!;
            for (const claim of group) stats[await processClaim(claim)]++;
          }
        }),
      );
      return stats;
    },
    async purgeExpiredSnapshots(tenantId: string): Promise<void> {
      await withTenant(options.db, tenantId, async (tx) => {
        const expired = await tx
          .selectFrom('sync_snapshot_sessions')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('expires_at', '<=', sql<Date>`clock_timestamp()`)
          .limit(100)
          .forUpdate()
          .skipLocked()
          .execute();
        if (!expired.length) return;
        const ids = expired.map((row) => row.id);
        await tx
          .deleteFrom('sync_snapshot_items')
          .where('tenant_id', '=', tenantId)
          .where('snapshot_id', 'in', ids)
          .execute();
        await tx
          .deleteFrom('sync_snapshot_sessions')
          .where('tenant_id', '=', tenantId)
          .where('id', 'in', ids)
          .execute();
      });
    },
  };
}
export type OutboxProcessor = ReturnType<typeof createOutboxProcessor>;
