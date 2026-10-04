import type { AuthContext } from '@imbox/application';
import type { TenantTransaction } from '@imbox/db';
/** Called only after byte/hash/scan verification, in the same short metadata transaction. */
export interface ResourceTextIndexPort {
  upsert(
    tx: TenantTransaction,
    auth: AuthContext,
    source: { resourceId: string; version: string; sha256: string; text: string },
  ): Promise<void>;
  remove(tx: TenantTransaction, auth: AuthContext, resourceId: string): Promise<void>;
}
