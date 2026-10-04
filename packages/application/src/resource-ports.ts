import type { ContractTypes } from '@imbox/contracts';
import type { TenantTransaction } from '@imbox/db';
import type { AuthContext } from './common.js';
export interface MessageResourcePort {
  attach(
    tx: TenantTransaction,
    auth: AuthContext,
    conversationId: string,
    messageId: string,
    resourceIds: readonly string[],
  ): Promise<void>;
}
export interface ArtifactEvidencePort {
  verify(
    tx: TenantTransaction,
    auth: AuthContext,
    taskId: string,
    evidence: ContractTypes['ArtifactEvidenceRef'],
  ): Promise<ContractTypes['ArtifactEvidenceRef']>;
}
