import { sql } from 'kysely';
import type { TenantTransaction } from './database.js';
/** Lock is retained by the business transaction; identity writes remain on the identity pool. */
export async function lockPrincipal(tx: TenantTransaction, id: string) {
  return (
    await sql<{
      id: string;
      kind: 'human' | 'agent' | 'service';
      status: 'active' | 'disabled' | 'deleted';
      version: string;
    }>`select * from public.imbox_lock_principal(${id}::uuid)`.execute(tx)
  ).rows[0];
}
