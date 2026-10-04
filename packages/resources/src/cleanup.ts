import { sql, withTenant, type Db } from '@imbox/db';
import { queueCleanup, type UploadRow } from './shared.js';
import type { ObjectStore } from './store.js';
/** Internal, bounded reconciliation. A wakeup/queue is never the source of cleanup truth. */
export function createResourceCleanup(options: { db: Db; store: ObjectStore }) {
  return async (tenantId: string, limit = 20) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Cleanup limit must be 1..100');
    await withTenant(options.db, tenantId, async (tx) => {
      const expired = (
        await sql<UploadRow>`select * from resource_uploads where expires_at<=clock_timestamp() and status in ('pending','verifying','rejected') order by expires_at limit ${limit} for update skip locked`.execute(
          tx,
        )
      ).rows;
      for (const upload of expired) {
        await sql`update resource_uploads set status='expired',verification_expires_at=null,version=version+1 where id=${upload.id}`.execute(
          tx,
        );
        await queueCleanup(tx, tenantId, upload.staging_key, upload.id, null);
        await queueCleanup(tx, tenantId, upload.object_key, upload.id, null);
      }
    });
    const jobs = await withTenant(options.db, tenantId, async (tx) => {
      const rows = (
        await sql<{
          id: string;
          object_key: string;
          lease_generation: string;
        }>`select j.id,j.object_key,j.lease_generation from resource_cleanup_jobs j left join resource_uploads u on u.tenant_id=j.tenant_id and u.id=j.upload_id where (j.status='pending' or(j.status='running' and j.lease_expires_at<=clock_timestamp())) and (u.id is null or j.object_key<>u.staging_key or u.expires_at<=clock_timestamp()) order by j.created_at,j.id limit ${limit} for update of j skip locked`.execute(
          tx,
        )
      ).rows;
      for (const row of rows)
        await sql`update resource_cleanup_jobs set status='running',lease_generation=lease_generation+1,lease_expires_at=clock_timestamp()+interval '30 seconds',attempts=attempts+1,updated_at=clock_timestamp() where id=${row.id}`.execute(
          tx,
        );
      return rows.map((row) => ({
        ...row,
        lease_generation: String(BigInt(row.lease_generation) + 1n),
      }));
    });
    let deleted = 0;
    for (const job of jobs) {
      try {
        await options.store.delete(job.object_key);
        await withTenant(options.db, tenantId, (tx) =>
          sql`update resource_cleanup_jobs set status='done',lease_expires_at=null,last_error=null,updated_at=clock_timestamp() where id=${job.id} and lease_generation=${job.lease_generation}`.execute(
            tx,
          ),
        );
        deleted++;
      } catch {
        await withTenant(options.db, tenantId, (tx) =>
          sql`update resource_cleanup_jobs set status='pending',lease_expires_at=null,last_error='OBJECT_DELETE_FAILED',updated_at=clock_timestamp() where id=${job.id} and lease_generation=${job.lease_generation}`.execute(
            tx,
          ),
        );
      }
    }
    return { claimed: jobs.length, deleted };
  };
}
