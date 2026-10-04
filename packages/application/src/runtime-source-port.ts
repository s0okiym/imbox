import type { TenantTransaction } from '@imbox/db';
import type { AuthContext } from './common.js';
export interface RuntimeExtendedSourceReference {
  type: 'memory' | 'artifact_version';
  id: string;
  version: string;
  sha256: string;
  required: boolean;
}
/** Data-only extension; the provider must verify both readers and the requested disclosure scope. */
export interface RuntimeSourcePort {
  read(
    tx: TenantTransaction,
    input: {
      creator: AuthContext;
      agent: AuthContext;
      reference: RuntimeExtendedSourceReference;
      scope: { conversationId: string | null; taskId: string | null };
    },
  ): Promise<{ payload: Record<string, unknown>; authorization: Record<string, unknown> }>;
}
