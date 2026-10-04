import { randomUUID } from 'node:crypto';
import { sql } from '@imbox/db';
import type { ResourceTextIndexPort } from '@imbox/resources';
import { fail } from './shared.js';
/** Metadata remains authoritative if a deployment temporarily omits this optional derived index. */
export function knowledgeResourceIndex(): ResourceTextIndexPort {
  return {
    async upsert(tx, auth, source) {
      const current = (
        await sql<{
          version: string;
          sha256: string;
        }>`select version,sha256 from resources where id=${source.resourceId} and deleted_at is null and scan_state='approved' for share`.execute(
          tx,
        )
      ).rows[0];
      if (current?.version !== source.version || current.sha256 !== source.sha256)
        fail('VERSION_CONFLICT', 409);
      await sql`insert into resource_text_documents(tenant_id,resource_id,resource_version,sha256,body) values(${auth.tenantId},${source.resourceId},${source.version},${source.sha256},${source.text}) on conflict(tenant_id,resource_id) do update set resource_version=excluded.resource_version,sha256=excluded.sha256,body=excluded.body`.execute(
        tx,
      );
    },
    async remove(tx, auth, resourceId) {
      await sql`delete from resource_text_documents where resource_id=${resourceId}`.execute(tx);
      await sql`insert into knowledge_deletion_receipts(tenant_id,id,resource_id,reason) values(${auth.tenantId},${randomUUID()},${resourceId},'explicit')`.execute(
        tx,
      );
    },
  };
}
