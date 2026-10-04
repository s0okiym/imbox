import { sql, type TenantTransaction as Tx } from '@imbox/db';
import type { ContractTypes as C } from '@imbox/contracts';
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '😄', '👀', '🙏'] as const;
/** Stored projections carry reference metadata only. Quote bodies are gated for each recipient. */
export async function presentMessage(
  tx: Tx,
  input: C['Message'],
  visibleFrom: string,
): Promise<C['Message']> {
  const message = { ...input };
  delete message.quote;
  if (message.deleted) {
    delete message.reply_to_id;
    delete message.reply_to_version;
    delete message.thread_root_id;
    message.reactions = [];
    return message;
  }
  if (message.reply_to_id) {
    const source = (
      await sql<{
        id: string;
        conversation_id: string;
        seq: string;
        version: string;
        body: string;
        deleted_at: Date | null;
      }>`select id,conversation_id,seq,version,body,deleted_at from messages where id=${message.reply_to_id}`.execute(
        tx,
      )
    ).rows[0];
    if (
      !source ||
      source.conversation_id !== message.conversation_id ||
      BigInt(source.seq) < BigInt(visibleFrom)
    ) {
      delete message.reply_to_id;
      delete message.reply_to_version;
    } else if (message.reply_to_version) {
      let body: string | null = null;
      if (!source.deleted_at) {
        body =
          source.version === message.reply_to_version
            ? source.body
            : ((
                await sql<{
                  body: string;
                }>`select body from message_revisions where message_id=${source.id} and revision=${message.reply_to_version}`.execute(
                  tx,
                )
              ).rows[0]?.body ?? null);
      }
      message.quote = {
        source_id: source.id,
        source_version: message.reply_to_version,
        body,
        unavailable: body === null,
      };
    }
  }
  if (message.thread_root_id) {
    const root = (
      await sql<{
        seq: string;
        conversation_id: string;
      }>`select seq,conversation_id from messages where id=${message.thread_root_id}`.execute(tx)
    ).rows[0];
    if (
      !root ||
      root.conversation_id !== message.conversation_id ||
      BigInt(root.seq) < BigInt(visibleFrom)
    )
      delete message.thread_root_id;
  }
  return message;
}
/** No personalized fields are stored in a shared conversation projection. */
export async function reactionSummary(
  tx: Tx,
  messageId: string,
): Promise<C['MessageReactionSummary'][]> {
  return (
    await sql<{
      emoji: string;
      count: string;
    }>`select emoji,count(*)::text as count from reactions where message_id=${messageId} group by emoji order by emoji`.execute(
      tx,
    )
  ).rows;
}

/** Reaction or attachment bookkeeping is not a body edit. */
export async function messageEdition(tx: Tx, messageId: string): Promise<{ edited_at?: string }> {
  const row = (
    await sql<{
      created_at: Date;
    }>`select created_at from domain_events where aggregate_type='message' and aggregate_id=${messageId} and event_type='message.edited' order by aggregate_version desc limit 1`.execute(
      tx,
    )
  ).rows[0];
  return row ? { edited_at: row.created_at.toISOString() } : {};
}
