import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type TenantTransaction as Tx } from '@imbox/db';
import { sources, joins, visible, fence, source, type VisibleSource } from './sources.js';
const consumer = 'notification-events:v1';
function limit(n: number, max: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new Error('Invalid dispatcher batch limit');
  return n;
}
async function finishNonConversation(tx: Tx, tenantId: string, eventId: string) {
  const rows = (
    await sql<{
      target: string;
      id: string;
    }>`select target,id from outbox where event_id=${eventId} and target not like 'conversation:%' and status<>'completed' and (status<>'leased' or lease_expires_at<=clock_timestamp()) for update`.execute(
      tx,
    )
  ).rows;
  for (const row of rows) {
    await sql`insert into consumer_receipts(tenant_id,consumer,event_id,target_scope) values(${tenantId},'notification-invalidation:v1',${eventId},${row.target}) on conflict do nothing`.execute(
      tx,
    );
    await sql`update outbox set status='completed',lease_holder=null,lease_expires_at=null,updated_at=clock_timestamp() where id=${row.id}`.execute(
      tx,
    );
  }
  return rows.length;
}
export function createNotificationDispatcher(options: { db: Db; historyHours?: number }) {
  const historyHours = options.historyHours ?? 24;
  if (!Number.isInteger(historyHours) || historyHours < 1 || historyHours > 168)
    throw new Error('Notification history window must be 1..168 hours');
  const backfillComplete = new Set<string>();
  return async (tenantId: string, query: { limit?: number; fanoutLimit?: number } = {}) => {
    const batches = limit(query.limit ?? 50, 200);
    const fanoutLimit = limit(query.fanoutLimit ?? 100, 200);
    // No watermark: a transaction can commit an older ID/time after a newer transaction.
    const backfilled = backfillComplete.has(tenantId)
      ? 0
      : await withTenant(options.db, tenantId, async (tx) =>
          Number(
            (
              await sql`insert into notification_event_queue(tenant_id,event_id) select e.tenant_id,e.id from domain_events e where not exists(select 1 from notification_event_queue q where q.event_id=e.id) order by e.created_at,e.id limit ${batches} on conflict do nothing`.execute(
                tx,
              )
            ).numAffectedRows ?? 0n,
          ),
        );
    if (backfilled < batches) backfillComplete.add(tenantId);
    let processed = 0;
    let completed = 0;
    let recipients = 0;
    let outboxCompleted = 0;
    for (let page = 0; page < batches; page++) {
      const result = await withTenant(options.db, tenantId, async (tx) => {
        const queue = (
          await sql<{
            event_id: string;
            after_recipient: string | null;
            aggregate_type: string;
            aggregate_id: string;
            event_type: string;
            actor_principal_id: string;
            recent: boolean;
          }>`select q.event_id,q.after_recipient,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_principal_id,e.created_at>=clock_timestamp()-make_interval(hours=>${historyHours}) as recent from notification_event_queue q join domain_events e on e.id=q.event_id where q.status='pending' order by q.created_at,q.event_id for update of q skip locked limit 1`.execute(
            tx,
          )
        ).rows[0];
        if (!queue) return null;
        const kind = queue.aggregate_type === 'agent_run' ? 'run' : queue.aggregate_type;
        const supported =
          ['message', 'task', 'request', 'action', 'run'].includes(kind) &&
          (kind !== 'message' || queue.event_type === 'message.created');
        const current =
          supported && queue.recent ? await source(tx, kind, queue.aggregate_id) : undefined;
        let actors: VisibleSource[] = [];
        if (current) {
          actors = (
            await sql<VisibleSource>`${sources} select s.*,tp.principal_id,${fence} authorization_fence from notification_sources s join tenant_principals tp on true ${joins} where s.source_kind=${kind} and s.source_id=${queue.aggregate_id} and ${visible} and (${queue.after_recipient}::uuid is null or tp.principal_id>${queue.after_recipient}::uuid) and (${kind}<>'message' or tp.principal_id<>${queue.actor_principal_id}) order by tp.principal_id limit ${fanoutLimit + 1}`.execute(
              tx,
            )
          ).rows;
        }
        const more = actors.length > fanoutLimit;
        actors = actors.slice(0, fanoutLimit);
        for (const actor of actors) {
          await sql`insert into notification_intents(tenant_id,id,recipient_id,topic_key,category,source_kind,source_id,source_version,ordering_version,authorization_fence,event_id) values(${tenantId},${randomUUID()},${actor.principal_id},${actor.topic_key},${actor.category},${actor.source_kind},${actor.source_id},${actor.source_version},${actor.ordering_version},${JSON.stringify(actor.authorization_fence)}::jsonb,${queue.event_id}) on conflict(tenant_id,recipient_id,topic_key) do update set source_id=excluded.source_id,source_version=excluded.source_version,ordering_version=excluded.ordering_version,authorization_fence=excluded.authorization_fence,event_id=excluded.event_id,version=notification_intents.version+1,updated_at=clock_timestamp() where excluded.ordering_version>notification_intents.ordering_version`.execute(
            tx,
          );
          await sql`insert into consumer_receipts(tenant_id,consumer,event_id,target_scope) values(${tenantId},${consumer},${queue.event_id},${actor.principal_id}) on conflict do nothing`.execute(
            tx,
          );
        }
        let closed = 0;
        if (more) {
          await sql`update notification_event_queue set after_recipient=${actors.at(-1)!.principal_id} where event_id=${queue.event_id}`.execute(
            tx,
          );
        } else {
          await sql`insert into consumer_receipts(tenant_id,consumer,event_id,target_scope) values(${tenantId},${consumer},${queue.event_id},'event') on conflict do nothing`.execute(
            tx,
          );
          await sql`update notification_event_queue set status='completed',completed_at=clock_timestamp() where event_id=${queue.event_id}`.execute(
            tx,
          );
          closed = await finishNonConversation(tx, tenantId, queue.event_id);
        }
        return { complete: !more, count: actors.length, closed };
      });
      if (!result) break;
      processed++;
      completed += Number(result.complete);
      recipients += result.count;
      outboxCompleted += result.closed;
    }
    // Repair an expired legacy non-conversation lease or an independently restored outbox row.
    outboxCompleted += await withTenant(options.db, tenantId, async (tx) => {
      const rows = (
        await sql<{
          event_id: string;
        }>`select distinct o.event_id from outbox o join notification_event_queue q on q.event_id=o.event_id and q.status='completed' where o.target not like 'conversation:%' and o.status<>'completed' and (o.status<>'leased' or o.lease_expires_at<=clock_timestamp()) limit ${batches}`.execute(
          tx,
        )
      ).rows;
      let n = 0;
      for (const row of rows) n += await finishNonConversation(tx, tenantId, row.event_id);
      return n;
    });
    return {
      backfilled,
      processed,
      batch_full: processed === batches || backfilled === batches,
      completed,
      recipients,
      outbox_completed: outboxCompleted,
    };
  };
}
