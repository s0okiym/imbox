import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@imbox/db';
import { memorySourcesLive, sourceViews } from './shared.js';
/** Internal bounded maintenance. Reads always gate on authoritative sources before this job runs. */
export function createKnowledgeReconciler(db: Db) {
  return async (tenantId: string, limit = 50) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Invalid reconciliation limit');
    const candidates = await withTenant(db, tenantId, async (tx) => {
      await sql`set local statement_timeout='5s'`.execute(tx);
      return (
        await sql<{
          id: string;
          version: string;
          created_by: string;
        }>`select mi.id,mi.version,mi.created_by from memory_items mi cross join lateral (with source_view as not materialized (${sourceViews({ principalId: sql.ref('mi.created_by') })}) select ${memorySourcesLive()} as valid) provenance where mi.status in ('active','disabled') and (mi.expires_at<=clock_timestamp() or not provenance.valid) order by mi.id limit ${limit}`.execute(
          tx,
        )
      ).rows;
    });
    let restricted = 0;
    for (const item of candidates) {
      restricted += await withTenant(db, tenantId, async (tx) => {
        const changed = (
          await sql<{
            id: string;
            expired: boolean;
          }>`with source_view as not materialized (${sourceViews({ principalId: item.created_by })}) update memory_items mi set status='restricted',version=version+1,updated_at=clock_timestamp() where mi.id=${item.id} and mi.version=${item.version} and mi.status in ('active','disabled') and (mi.expires_at<=clock_timestamp() or not ${memorySourcesLive()}) returning mi.id,mi.expires_at<=clock_timestamp() as expired`.execute(
            tx,
          )
        ).rows[0];
        if (!changed) return 0;
        await sql`update memory_revisions set body='',redacted_at=clock_timestamp() where memory_id=${item.id}`.execute(
          tx,
        );
        await sql`insert into knowledge_deletion_receipts(tenant_id,id,memory_id,reason) values(${tenantId},${randomUUID()},${item.id},${changed.expired ? 'expired' : 'source_unavailable'})`.execute(
          tx,
        );
        return 1;
      });
    }
    const removed = await withTenant(db, tenantId, async (tx) => {
      const deleted = (
        await sql<{
          resource_id: string;
        }>`delete from resource_text_documents d where d.resource_id in(select d2.resource_id from resource_text_documents d2 join resources r on r.tenant_id=d2.tenant_id and r.id=d2.resource_id where r.deleted_at is not null or r.version<>d2.resource_version or r.sha256<>d2.sha256 order by d2.resource_id limit ${limit}) returning d.resource_id`.execute(
          tx,
        )
      ).rows;
      for (const item of deleted)
        await sql`insert into knowledge_deletion_receipts(tenant_id,id,resource_id,reason) values(${tenantId},${randomUUID()},${item.resource_id},'source_unavailable')`.execute(
          tx,
        );
      return deleted.length;
    });
    return { restricted, purged_documents: removed };
  };
}
