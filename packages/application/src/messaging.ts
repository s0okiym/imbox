import { recordPolicy, type PolicyLedger } from './policy-ledger.js';
import { purgeDerivedContent } from './policy-replay.js';
import {
  presentMessage,
  REACTION_EMOJIS,
  reactionSummary,
  messageEdition,
} from './message-presentation.js';
import { randomUUID } from 'node:crypto';
import type { MessageResourcePort } from './resource-ports.js';
import { assertContract, type ContractTypes } from '@imbox/contracts';
import {
  allocateMessageSequence,
  sql,
  withTenant,
  type Db,
  type TenantTransaction,
} from '@imbox/db';
import {
  appendEvent,
  authorizeTenant,
  authorizeWorkspace,
  authorizeConversation,
  command,
  CursorCodec,
  expectedVersion,
  fail,
  type AuthContext,
} from './common.js';

export interface PageQuery {
  cursor?: string;
  limit?: number;
}
const limitOf = (query: PageQuery) => Math.min(200, Math.max(1, query.limit ?? 50));
const target = (id: string) => `conversation:${id}`;

export function createMessagingService(
  db: Db,
  cursorSecret: string,
  options: { resources?: MessageResourcePort; policyLedger?: PolicyLedger } = {},
) {
  const cursors = new CursorCodec(cursorSecret);
  async function transaction<T>(
    auth: AuthContext,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return withTenant(db, auth.tenantId, async (tx) => {
      await authorizeTenant(tx, auth);
      return fn(tx);
    });
  }
  const workspace = authorizeWorkspace;
  const conversation = authorizeConversation;
  type ConversationAccess = Awaited<ReturnType<typeof conversation>>;
  function conversationDto(access: ConversationAccess) {
    const c = access.row;
    return assertContract('Conversation', {
      id: c.id,
      workspace_id: c.workspace_id,
      kind: c.kind,
      title: c.title,
      version: c.version,
      created_at: c.created_at.toISOString(),
      history_policy: c.history_policy,
      view_scope: c.id,
      authz_generation: c.authz_generation,
      projection_id: c.id,
      projection_revision: c.version,
    });
  }
  // Fetch a page in one database round trip. Subqueries remain tenant- and message-bound;
  // caller authorization is retained by the surrounding transaction, not cached between calls.
  async function messageRows(tx: TenantTransaction, auth: AuthContext, ids: readonly string[]) {
    if (!ids.length) return [];
    return tx
      .selectFrom('messages as m')
      .innerJoin('principals as p', 'p.id', 'm.sender_principal_id')
      .selectAll('m')
      .select([
        sql<
          ContractTypes['Message']['actor']
        >`jsonb_build_object('id',p.id,'kind',p.kind,'display_name',p.display_name,'status',p.status)`.as(
          'actor',
        ),
        sql<string[]>`case when m.deleted_at is not null then array[]::uuid[] else array(
          select mr.resource_id from message_resources mr
          join resources r on r.tenant_id=mr.tenant_id and r.id=mr.resource_id
          where mr.tenant_id=m.tenant_id and mr.message_id=m.id and r.deleted_at is null
            and r.version=mr.resource_version and r.conversation_id=m.conversation_id
          order by mr.ordinal) end`.as('attachment_ids'),
        sql<
          ContractTypes['MessageReactionSummary'][]
        >`case when m.deleted_at is not null then '[]'::jsonb else coalesce((
          select jsonb_agg(summary order by summary.emoji) from (
            select emoji,count(*)::text as count from reactions
            where tenant_id=m.tenant_id and message_id=m.id group by emoji
          ) summary), '[]'::jsonb) end`.as('reaction_summary'),
        sql<Date | null>`(select created_at from domain_events
          where tenant_id=m.tenant_id and aggregate_type='message' and aggregate_id=m.id
            and event_type='message.edited' order by aggregate_version desc limit 1)`.as(
          'body_edited_at',
        ),
      ])
      .where('m.tenant_id', '=', auth.tenantId)
      .where('m.id', 'in', [...ids])
      .execute();
  }
  type MessageRow = Awaited<ReturnType<typeof messageRows>>[number];
  async function presentRow(tx: TenantTransaction, m: MessageRow, allowed: ConversationAccess) {
    if (
      m.conversation_id !== allowed.row.id ||
      BigInt(m.seq) < BigInt(allowed.member.visible_from_seq)
    )
      return fail('NOT_FOUND', 404);
    const dto = assertContract('Message', {
      id: m.id,
      conversation_id: m.conversation_id,
      client_message_id: m.client_message_id,
      actor: m.actor,
      seq: m.seq,
      version: m.version,
      body: m.deleted_at ? '' : m.body,
      format: 'text',
      attachment_ids: m.attachment_ids,
      reactions: m.reaction_summary,
      ...(m.reply_to_id ? { reply_to_id: m.reply_to_id } : {}),
      ...(m.reply_to_version ? { reply_to_version: m.reply_to_version } : {}),
      ...(m.thread_root_id ? { thread_root_id: m.thread_root_id } : {}),
      created_at: m.created_at.toISOString(),
      ...(m.body_edited_at ? { edited_at: m.body_edited_at.toISOString() } : {}),
      deleted: m.deleted_at !== null,
      view_scope: m.conversation_id,
      authz_generation: allowed.row.authz_generation,
      projection_id: m.id,
      projection_revision: m.version,
    });
    return assertContract(
      'Message',
      await presentMessage(tx, dto, allowed.member.visible_from_seq),
    );
  }
  async function messageDto(
    tx: TenantTransaction,
    auth: AuthContext,
    id: string,
    access?: ConversationAccess,
  ) {
    const m = await tx
      .selectFrom('messages')
      .selectAll()
      .where('tenant_id', '=', auth.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!m) return fail('NOT_FOUND', 404);
    const allowed = access ?? (await conversation(tx, auth, m.conversation_id));
    if (
      m.conversation_id !== allowed.row.id ||
      BigInt(m.seq) < BigInt(allowed.member.visible_from_seq)
    )
      return fail('NOT_FOUND', 404);
    const actor = await tx
      .selectFrom('principals')
      .select(['id', 'kind', 'display_name', 'status'])
      .where('id', '=', m.sender_principal_id)
      .executeTakeFirstOrThrow();
    const attachment_ids = m.deleted_at
      ? []
      : (
          await sql<{ resource_id: string }>`
      select mr.resource_id from message_resources mr join resources r
      on r.tenant_id=mr.tenant_id and r.id=mr.resource_id
      where mr.message_id=${m.id} and r.deleted_at is null and r.version=mr.resource_version
      and r.conversation_id=${m.conversation_id} order by mr.ordinal`.execute(tx)
        ).rows.map((row) => row.resource_id);
    const reaction_summary = m.deleted_at ? [] : await reactionSummary(tx, m.id);
    const edition = await messageEdition(tx, m.id);
    return presentRow(
      tx,
      {
        ...m,
        actor,
        attachment_ids,
        reaction_summary,
        body_edited_at: edition.edited_at ? new Date(edition.edited_at) : null,
      },
      allowed,
    );
  }

  async function messagePage(
    tx: TenantTransaction,
    auth: AuthContext,
    ids: readonly string[],
    access: ConversationAccess,
  ) {
    const byId = new Map((await messageRows(tx, auth, ids)).map((row) => [row.id, row]));
    const items = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) return fail('NOT_FOUND', 404);
      items.push(await presentRow(tx, row, access));
    }
    return items;
  }
  function checkFormat(input: { format?: string; attachment_ids?: string[] }) {
    if (
      (input.format !== undefined && input.format !== 'text') ||
      ((input.attachment_ids?.length ?? 0) > 0 && !options.resources)
    )
      fail('VALIDATION_FAILED', 400);
  }

  return {
    async listWorkspaces(auth: AuthContext) {
      return transaction(auth, async (tx) => {
        const items = await tx
          .selectFrom('workspaces as w')
          .innerJoin('memberships as m', (join) =>
            join.onRef('m.tenant_id', '=', 'w.tenant_id').onRef('m.workspace_id', '=', 'w.id'),
          )
          .select(['w.id', 'w.name', 'm.role'])
          .where('w.tenant_id', '=', auth.tenantId)
          .where('m.principal_id', '=', auth.principalId)
          .where('m.status', '=', 'active')
          .orderBy('w.id')
          .limit(200)
          .execute();
        return { items };
      });
    },
    async workspaceMembers(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        await workspace(tx, auth, id);
        const rows = await tx
          .selectFrom('memberships as m')
          .innerJoin('principals as p', 'p.id', 'm.principal_id')
          .innerJoin('tenant_principals as tp', (join) =>
            join
              .onRef('tp.tenant_id', '=', 'm.tenant_id')
              .onRef('tp.principal_id', '=', 'm.principal_id'),
          )
          .select(['p.id', 'p.kind', 'p.display_name', 'p.status', 'm.role'])
          .where('m.tenant_id', '=', auth.tenantId)
          .where('m.workspace_id', '=', id)
          .where('m.status', '=', 'active')
          .where('tp.status', '=', 'active')
          .where('p.status', '=', 'active')
          .orderBy('p.id')
          .limit(200)
          .execute();
        return assertContract('WorkspaceMemberPage', {
          items: rows.map(({ role, ...principal }) => ({ principal, role })),
        });
      });
    },
    async createConversation(
      auth: AuthContext,
      input: ContractTypes['CreateConversationInput'],
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        const id = await command(tx, auth, 'conversation.create', key, input, async () => {
          const wm = await workspace(tx, auth, input.workspace_id);
          if (wm.role === 'guest') fail('FORBIDDEN', 403);
          const members = [...new Set([auth.principalId, ...input.member_ids])].sort();
          if (members.length > 100 || (input.kind === 'direct' && members.length !== 2))
            fail('VALIDATION_FAILED', 400);
          for (const principalId of members) {
            const member = await tx
              .selectFrom('memberships as m')
              .innerJoin('tenant_principals as tp', (join) =>
                join
                  .onRef('tp.tenant_id', '=', 'm.tenant_id')
                  .onRef('tp.principal_id', '=', 'm.principal_id'),
              )
              .select('m.principal_id')
              .where('m.tenant_id', '=', auth.tenantId)
              .where('m.workspace_id', '=', input.workspace_id)
              .where('m.principal_id', '=', principalId)
              .where('m.status', '=', 'active')
              .where('tp.status', '=', 'active')
              .forShare()
              .executeTakeFirst();
            if (!member) fail('NOT_FOUND', 404);
          }
          const newId = randomUUID();
          await tx
            .insertInto('conversations')
            .values({
              tenant_id: auth.tenantId,
              id: newId,
              workspace_id: input.workspace_id,
              kind: input.kind,
              title: input.title ?? (input.kind === 'direct' ? '私聊' : '新会话'),
              created_by: auth.principalId,
              history_policy: input.history_policy ?? 'since_join',
            })
            .execute();
          await tx
            .insertInto('conversation_members')
            .values(
              members.map((principalId) => ({
                tenant_id: auth.tenantId,
                conversation_id: newId,
                principal_id: principalId,
                role: principalId === auth.principalId ? ('owner' as const) : ('member' as const),
              })),
            )
            .execute();
          await tx
            .insertInto('projection_streams')
            .values({
              tenant_id: auth.tenantId,
              id: newId,
              scope_id: newId,
              scope_type: 'conversation',
            })
            .execute();
          await appendEvent(tx, auth, {
            aggregateType: 'conversation',
            aggregateId: newId,
            version: '1',
            type: 'conversation.created',
            payload: {},
            target: target(newId),
          });
          return newId;
        });
        return conversationDto(await conversation(tx, auth, id));
      });
    },
    async listConversations(auth: AuthContext, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:conversations`;
        let builder = tx
          .selectFrom('conversations as c')
          .innerJoin('conversation_members as m', (join) =>
            join.onRef('m.tenant_id', '=', 'c.tenant_id').onRef('m.conversation_id', '=', 'c.id'),
          )
          .innerJoin('memberships as wm', (join) =>
            join
              .onRef('wm.tenant_id', '=', 'c.tenant_id')
              .onRef('wm.workspace_id', '=', 'c.workspace_id')
              .onRef('wm.principal_id', '=', 'm.principal_id'),
          )
          .select('c.id')
          .where('c.tenant_id', '=', auth.tenantId)
          .where('m.principal_id', '=', auth.principalId)
          .where('m.status', '=', 'active')
          .where('wm.status', '=', 'active');
        if (query.cursor)
          builder = builder.where('c.id', '>', cursors.decode(query.cursor, binding));
        const rows = await builder
          .orderBy('c.id')
          .limit(limitOf(query) + 1)
          .execute();
        const selected = rows.slice(0, limitOf(query));
        const items = [];
        for (const row of selected)
          items.push(conversationDto(await conversation(tx, auth, row.id)));
        return assertContract('ConversationPage', {
          items,
          ...(rows.length > limitOf(query)
            ? { next_cursor: cursors.encode(binding, selected.at(-1)!.id) }
            : {}),
        });
      });
    },
    async getConversation(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => conversationDto(await conversation(tx, auth, id)));
    },
    async conversationMembers(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        await conversation(tx, auth, id);
        const rows = await tx
          .selectFrom('conversation_members as m')
          .innerJoin('principals as p', 'p.id', 'm.principal_id')
          .select(['p.id', 'p.kind', 'p.display_name', 'p.status', 'm.role'])
          .where('m.tenant_id', '=', auth.tenantId)
          .where('m.conversation_id', '=', id)
          .where('m.status', '=', 'active')
          .orderBy('p.id')
          .limit(100)
          .execute();
        return assertContract('ConversationMemberPage', {
          items: rows.map(({ role, ...principal }) => ({ principal, role })),
        });
      });
    },
    async changeMember(
      auth: AuthContext,
      id: string,
      principalId: string,
      action: 'add' | 'remove',
      version: string,
      key: string,
      role: 'admin' | 'member' = 'member',
    ) {
      return transaction(auth, async (tx) => {
        await command(
          tx,
          auth,
          `conversation.member.${action}`,
          key,
          { id, principalId, version, role },
          async () => {
            const access = await conversation(tx, auth, id, true);
            if (access.row.kind !== 'group' || !['owner', 'admin'].includes(access.member.role))
              fail('FORBIDDEN', 403);
            expectedVersion(access.row.version, version);
            const existing = await tx
              .selectFrom('conversation_members')
              .selectAll()
              .where('tenant_id', '=', auth.tenantId)
              .where('conversation_id', '=', id)
              .where('principal_id', '=', principalId)
              .executeTakeFirst();
            if (
              principalId === auth.principalId ||
              existing?.role === 'owner' ||
              (access.member.role !== 'owner' && (existing?.role === 'admin' || role === 'admin'))
            )
              fail('FORBIDDEN', 403);
            if (action === 'add') {
              const tenantMember = await tx
                .selectFrom('tenant_principals')
                .select('status')
                .where('tenant_id', '=', auth.tenantId)
                .where('principal_id', '=', principalId)
                .forShare()
                .executeTakeFirst();
              const wm = await tx
                .selectFrom('memberships')
                .select('status')
                .where('tenant_id', '=', auth.tenantId)
                .where('workspace_id', '=', access.row.workspace_id!)
                .where('principal_id', '=', principalId)
                .forShare()
                .executeTakeFirst();
              if (tenantMember?.status !== 'active' || wm?.status !== 'active')
                fail('NOT_FOUND', 404);
              const count = await tx
                .selectFrom('conversation_members')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('tenant_id', '=', auth.tenantId)
                .where('conversation_id', '=', id)
                .where('status', '=', 'active')
                .executeTakeFirstOrThrow();
              if (existing?.status === 'active' || Number(count.n) >= 100)
                fail('VERSION_CONFLICT', 409);
              const values = {
                status: 'active' as const,
                role,
                visible_from_seq:
                  access.row.history_policy === 'all'
                    ? '0'
                    : (BigInt(access.row.message_head_seq) + 1n).toString(),
                joined_at: sql<Date>`clock_timestamp()`,
                left_at: null,
              };
              await tx
                .insertInto('conversation_members')
                .values({
                  tenant_id: auth.tenantId,
                  conversation_id: id,
                  principal_id: principalId,
                  ...values,
                })
                .onConflict((conflict) =>
                  conflict.columns(['tenant_id', 'conversation_id', 'principal_id']).doUpdateSet({
                    ...values,
                    version: sql`conversation_members.version + 1`,
                    updated_at: sql`clock_timestamp()`,
                  }),
                )
                .execute();
            } else {
              if (existing?.status !== 'active') fail('NOT_FOUND', 404);
              await recordPolicy(tx, auth, options.policyLedger, {
                kind: 'revocation.conversation',
                target_id: id,
                target_version: existing.version,
                subject_id: principalId,
              });
              await tx
                .updateTable('conversation_members')
                .set({
                  status: 'removed',
                  left_at: sql`clock_timestamp()`,
                  version: sql`version + 1`,
                  updated_at: sql`clock_timestamp()`,
                })
                .where('tenant_id', '=', auth.tenantId)
                .where('conversation_id', '=', id)
                .where('principal_id', '=', principalId)
                .execute();
            }
            const updated = await tx
              .updateTable('conversations')
              .set({
                version: sql`version + 1`,
                authz_generation: sql`authz_generation + 1`,
                updated_at: sql`clock_timestamp()`,
              })
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', id)
              .returning(['version', 'authz_generation'])
              .executeTakeFirstOrThrow();
            await tx
              .updateTable('projection_streams')
              .set({
                authz_generation: updated.authz_generation,
                updated_at: sql`clock_timestamp()`,
              })
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', id)
              .execute();
            await appendEvent(tx, auth, {
              aggregateType: 'conversation',
              aggregateId: id,
              version: updated.version,
              type: `conversation.member_${action === 'add' ? 'added' : 'removed'}`,
              payload: { principal_id: principalId },
              target: target(id),
            });
            return id;
          },
        );
        return conversationDto(await conversation(tx, auth, id));
      });
    },
    async listMessages(auth: AuthContext, id: string, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const access = await conversation(tx, auth, id);
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:${id}:${access.row.authz_generation}:messages`;
        let builder = tx
          .selectFrom('messages')
          .select(['id', 'seq'])
          .where('tenant_id', '=', auth.tenantId)
          .where('conversation_id', '=', id)
          .where('seq', '>=', access.member.visible_from_seq);
        if (query.cursor)
          builder = builder.where('seq', '<', cursors.decode(query.cursor, binding));
        const rows = await builder
          .orderBy('seq', 'desc')
          .limit(limitOf(query) + 1)
          .execute();
        const selected = rows.slice(0, limitOf(query));
        const items = await messagePage(
          tx,
          auth,
          [...selected].reverse().map((row) => row.id),
          access,
        );
        return assertContract('MessagePage', {
          items,
          ...(rows.length > limitOf(query)
            ? { next_cursor: cursors.encode(binding, selected.at(-1)!.seq) }
            : {}),
        });
      });
    },
    async getMessage(auth: AuthContext, id: string) {
      return transaction(auth, (tx) => messageDto(tx, auth, id));
    },
    async listThread(auth: AuthContext, rootId: string, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const root = await messageDto(tx, auth, rootId);
        if (root.thread_root_id) fail('VALIDATION_FAILED', 400);
        const access = await conversation(tx, auth, root.conversation_id);
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:thread:${rootId}:${access.row.authz_generation}:${access.member.version}`;
        const after = query.cursor
          ? assertContract('Counter', cursors.decode(query.cursor, binding))
          : '0';
        const rows = await tx
          .selectFrom('messages')
          .select(['id', 'seq'])
          .where('conversation_id', '=', root.conversation_id)
          .where('thread_root_id', '=', rootId)
          .where('seq', '>=', access.member.visible_from_seq)
          .where('seq', '>', after)
          .orderBy('seq')
          .limit(limitOf(query) + 1)
          .execute();
        const selected = rows.slice(0, limitOf(query));
        const items = await messagePage(
          tx,
          auth,
          selected.map((row) => row.id),
          access,
        );
        return assertContract('MessagePage', {
          items,
          ...(rows.length > limitOf(query)
            ? { next_cursor: cursors.encode(binding, selected.at(-1)!.seq) }
            : {}),
        });
      });
    },
    async listReactions(auth: AuthContext, id: string, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const m = await messageDto(tx, auth, id);
        if (m.deleted) fail('NOT_FOUND', 404);
        const access = await conversation(tx, auth, m.conversation_id);
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:reactions:${id}:${access.row.authz_generation}:${access.member.version}`;
        const after = query.cursor
          ? assertContract('Identifier', cursors.decode(query.cursor, binding))
          : null;
        const rows = (
          await sql<{
            id: string;
            message_id: string;
            principal_id: string;
            emoji: string;
          }>`select id,message_id,principal_id,emoji from reactions where message_id=${id} and (${after}::uuid is null or id>${after}::uuid) order by id limit ${limitOf(query) + 1}`.execute(
            tx,
          )
        ).rows;
        return assertContract('ReactionPage', {
          items: rows.slice(0, limitOf(query)),
          ...(rows.length > limitOf(query)
            ? { next_cursor: cursors.encode(binding, rows[limitOf(query) - 1]!.id) }
            : {}),
        });
      });
    },
    async setReaction(
      auth: AuthContext,
      id: string,
      input: ContractTypes['ReactionInput'],
      present: boolean,
      key: string,
    ) {
      assertContract('ReactionInput', input);
      if (!(REACTION_EMOJIS as readonly string[]).includes(input.emoji))
        fail('VALIDATION_FAILED', 400);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'message.reaction', key, { id, input, present }, async () => {
          const ref = await tx
            .selectFrom('messages')
            .select('conversation_id')
            .where('id', '=', id)
            .executeTakeFirst();
          if (!ref) fail('NOT_FOUND', 404);
          const access = await conversation(tx, auth, ref.conversation_id, true);
          const m = await messageDto(tx, auth, id, access);
          if (m.deleted) fail('NOT_FOUND', 404);
          const effect = present
            ? await tx
                .insertInto('reactions')
                .values({
                  tenant_id: auth.tenantId,
                  id: randomUUID(),
                  message_id: id,
                  principal_id: auth.principalId,
                  emoji: input.emoji,
                })
                .onConflict((c) =>
                  c.columns(['tenant_id', 'message_id', 'principal_id', 'emoji']).doNothing(),
                )
                .returning('id')
                .execute()
            : await tx
                .deleteFrom('reactions')
                .where('message_id', '=', id)
                .where('principal_id', '=', auth.principalId)
                .where('emoji', '=', input.emoji)
                .returning('id')
                .execute();
          if (effect.length) {
            await tx
              .insertInto('message_revisions')
              .values({
                tenant_id: auth.tenantId,
                message_id: id,
                revision: m.version,
                body: m.body,
                edited_by: auth.principalId,
              })
              .onConflict((c) => c.columns(['tenant_id', 'message_id', 'revision']).doNothing())
              .execute();
            const updated = await tx
              .updateTable('messages')
              .set({ version: sql`version+1`, updated_at: sql`clock_timestamp()` })
              .where('id', '=', id)
              .returning('version')
              .executeTakeFirstOrThrow();
            await appendEvent(tx, auth, {
              aggregateType: 'message',
              aggregateId: id,
              version: updated.version,
              type: 'message.reactions_changed',
              payload: { conversation_id: ref.conversation_id },
              target: target(ref.conversation_id),
            });
          }
          return id;
        });
        return messageDto(tx, auth, id);
      });
    },
    async createMessage(
      auth: AuthContext,
      id: string,
      input: ContractTypes['CreateMessageInput'],
      key: string,
    ) {
      checkFormat(input);
      return transaction(auth, async (tx) => {
        // Command replays do not execute the callback: they must authorize the returned message anew.
        // New sends retain the conversation and membership locks until this transaction commits.
        let createdAccess: ConversationAccess | undefined;
        const messageId = await command(
          tx,
          auth,
          'message.create',
          key,
          { id, ...input },
          async () => {
            const access = await conversation(tx, auth, id, true);
            createdAccess = access;
            const existing = await tx
              .selectFrom('messages')
              .select('id')
              .where('tenant_id', '=', auth.tenantId)
              .where('sender_principal_id', '=', auth.principalId)
              .where('client_message_id', '=', input.client_message_id)
              .executeTakeFirst();
            // Changed/expired idempotency keys must never silently alias a previous send.
            if (existing) fail('IDEMPOTENCY_CONFLICT', 409);
            if (!!input.reply_to_id !== !!input.reply_to_version) fail('VALIDATION_FAILED', 400);
            let canonicalRoot: string | null = null;
            if (input.reply_to_id) {
              const quoted = await messageDto(tx, auth, input.reply_to_id, access);
              if (quoted.deleted) fail('NOT_FOUND', 404);
              expectedVersion(quoted.version, input.reply_to_version!);
              canonicalRoot = quoted.thread_root_id ?? quoted.id;
              if (input.thread_root_id && input.thread_root_id !== canonicalRoot)
                fail('VALIDATION_FAILED', 400);
            }
            if (input.thread_root_id) {
              const root = await messageDto(tx, auth, input.thread_root_id, access);
              if (root.thread_root_id) fail('VALIDATION_FAILED', 400);
              canonicalRoot = root.id;
            }
            for (const ref of [input.reply_to_id, input.thread_root_id]) {
              if (ref) {
                const related = await messageDto(tx, auth, ref, access);
                if (related.deleted) fail('NOT_FOUND', 404);
              }
            }
            const newId = randomUUID();
            const seq = await allocateMessageSequence(tx, id);
            await tx
              .insertInto('messages')
              .values({
                tenant_id: auth.tenantId,
                id: newId,
                conversation_id: id,
                sender_principal_id: auth.principalId,
                seq,
                body: input.body,
                client_message_id: input.client_message_id,
                reply_to_id: input.reply_to_id ?? null,
                thread_root_id: canonicalRoot,
                reply_to_version: input.reply_to_version ?? null,
              })
              .execute();
            if (input.attachment_ids?.length)
              await options.resources!.attach(tx, auth, id, newId, input.attachment_ids);
            await appendEvent(tx, auth, {
              aggregateType: 'message',
              aggregateId: newId,
              version: '1',
              type: 'message.created',
              payload: { conversation_id: id },
              target: target(id),
            });
            return newId;
          },
        );
        return messageDto(tx, auth, messageId, createdAccess);
      });
    },
    async changeMessage(
      auth: AuthContext,
      id: string,
      input: ContractTypes['EditMessageInput'] | null,
      version: string,
      key: string,
    ) {
      if (input) checkFormat(input);
      return transaction(auth, async (tx) => {
        await command(
          tx,
          auth,
          input ? 'message.edit' : 'message.delete',
          key,
          { id, input, version },
          async () => {
            const reference = await tx
              .selectFrom('messages')
              .select('conversation_id')
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', id)
              .executeTakeFirst();
            if (!reference) return fail('NOT_FOUND', 404);
            await conversation(tx, auth, reference.conversation_id, true);
            const message = await tx
              .selectFrom('messages')
              .selectAll()
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (message.sender_principal_id !== auth.principalId) fail('FORBIDDEN', 403);
            expectedVersion(message.version, version);
            if (message.deleted_at) fail('VERSION_CONFLICT', 409);
            if (!input)
              await recordPolicy(tx, auth, options.policyLedger, {
                kind: 'deletion.message',
                target_id: id,
                target_version: version,
              });
            await tx
              .insertInto('message_revisions')
              .values({
                tenant_id: auth.tenantId,
                message_id: id,
                revision: message.version,
                body: message.body,
                edited_by: auth.principalId,
              })
              .execute();
            const updated = await tx
              .updateTable('messages')
              .set({
                body: input?.body ?? '',
                deleted_at: input ? null : sql`clock_timestamp()`,
                version: sql`version + 1`,
                updated_at: sql`clock_timestamp()`,
              })
              .where('tenant_id', '=', auth.tenantId)
              .where('id', '=', id)
              .returning('version')
              .executeTakeFirstOrThrow();
            await appendEvent(tx, auth, {
              aggregateType: 'message',
              aggregateId: id,
              version: updated.version,
              type: input ? 'message.edited' : 'message.deleted',
              payload: { conversation_id: message.conversation_id },
              target: target(message.conversation_id),
            });
            if (!input) {
              await tx.deleteFrom('message_revisions').where('message_id', '=', id).execute();
              await tx.deleteFrom('reactions').where('message_id', '=', id).execute();
              await purgeDerivedContent(tx, 'deletion.message', id);
              // Retraction invalidates old page/snapshot cursors before asynchronous projection catches up.
              const changed = await tx
                .updateTable('conversations')
                .set({
                  version: sql`version + 1`,
                  authz_generation: sql`authz_generation + 1`,
                  updated_at: sql`clock_timestamp()`,
                })
                .where('tenant_id', '=', auth.tenantId)
                .where('id', '=', message.conversation_id)
                .returning(['version', 'authz_generation'])
                .executeTakeFirstOrThrow();
              await tx
                .updateTable('projection_streams')
                .set({
                  authz_generation: changed.authz_generation,
                  updated_at: sql`clock_timestamp()`,
                })
                .where('tenant_id', '=', auth.tenantId)
                .where('id', '=', message.conversation_id)
                .execute();
              await appendEvent(tx, auth, {
                aggregateType: 'conversation',
                aggregateId: message.conversation_id,
                version: changed.version,
                type: 'conversation.content_retracted',
                payload: { message_id: id },
                target: target(message.conversation_id),
              });
            }
            return id;
          },
        );
        return messageDto(tx, auth, id);
      });
    },
    async markRead(auth: AuthContext, id: string, seq: string, key: string) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'conversation.read', key, { id, seq }, async () => {
          const access = await conversation(tx, auth, id);
          if (
            BigInt(seq) > BigInt(access.row.message_head_seq) ||
            BigInt(seq) < 0n ||
            (seq !== '0' && BigInt(seq) < BigInt(access.member.visible_from_seq))
          )
            fail('VALIDATION_FAILED', 400);
          await tx
            .insertInto('read_cursors')
            .values({
              tenant_id: auth.tenantId,
              conversation_id: id,
              principal_id: auth.principalId,
              last_read_seq: seq,
            })
            .onConflict((conflict) =>
              conflict.columns(['tenant_id', 'conversation_id', 'principal_id']).doUpdateSet({
                last_read_seq: sql`greatest(read_cursors.last_read_seq, ${seq}::bigint)`,
                updated_at: sql`clock_timestamp()`,
              }),
            )
            .execute();
          return id;
        });
        await conversation(tx, auth, id);
        const row = await tx
          .selectFrom('read_cursors')
          .select('last_read_seq')
          .where('tenant_id', '=', auth.tenantId)
          .where('conversation_id', '=', id)
          .where('principal_id', '=', auth.principalId)
          .executeTakeFirstOrThrow();
        return assertContract('ReadCursor', row);
      });
    },
  };
}
export type MessagingService = ReturnType<typeof createMessagingService>;
