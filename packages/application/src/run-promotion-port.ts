import type { TenantTransaction } from '@imbox/db';
import type { AuthContext } from './common.js';
export interface RunPromotionPort {
  validate(
    tx: TenantTransaction,
    auth: AuthContext,
    runId: string,
    version: string,
    purpose: 'create' | 'read',
  ): Promise<{ conversationId: string; workspaceId: string; manifestId: string }>;
}
