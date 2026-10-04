import type { ContractTypes as C } from '@imbox/contracts';
import type { ActionStatus, AttemptStatus, SideEffectObservation, TaskStatus } from '@imbox/domain';
export interface Fence {
  taskId: string;
  executionEpoch: string;
}
export interface TaskRow {
  id: string;
  workspace_id: string;
  root_task_id: string;
  parent_task_id: string | null;
  owner_principal_id: string;
  status: TaskStatus;
  version: string;
  execution_epoch: string;
  authz_generation: string;
  execution_deadline: Date | null;
}
export interface GrantRow {
  tenant_id: string;
  ancestor_fences: Fence[];
  authority_snapshot: Record<string, unknown>;
  id: string;
  task_id: string;
  executor_principal_id: string;
  issued_by: string;
  tool_id: string;
  tool_version: string;
  target_id: string;
  allow_execute: boolean;
  allow_disclosure: boolean;
  resource_versions: C['ActionResourceRef'][];
  approver_ids: string[];
  currency: string;
  limit_microunits: string;
  status: 'active' | 'revoked';
  revision: string;
  expires_at: Date;
  created_at: Date;
}
export interface ActionRow {
  run_id: string | null;
  authority_snapshot: Record<string, unknown>;
  tenant_id: string;
  id: string;
  task_id: string;
  root_task_id: string;
  requester_id: string;
  requester_revision: string;
  executor_id: string;
  executor_revision: string;
  executor_installation_id: string | null;
  executor_installation_revision: string | null;
  grant_id: string;
  grant_revision: string;
  ancestor_fences: Fence[];
  resource_versions: C['ActionResourceRef'][];
  tool_id: string;
  tool_version: string;
  target_id: string;
  parameters: C['ActionParameters'];
  fingerprint: string;
  business_key: string;
  status: ActionStatus;
  version: string;
  approval_binding_version: string;
  approval_required: boolean;
  required: boolean;
  attempt_count: number;
  last_attempt_id: string | null;
  next_attempt_at: Date | null;
  lease_holder: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
  currency: string;
  estimate_microunits: string;
  created_at: Date;
}
export interface AttemptRow {
  id: string;
  action_id: string;
  attempt_no: number;
  version: string;
  status: AttemptStatus;
  side_effect: SideEffectObservation;
  lease_generation: string;
  fingerprint: string;
  journal_intent_id: string | null;
}
export interface ApprovalRow {
  authority_snapshot: Record<string, unknown>;
  id: string;
  action_id: string;
  action_version: string;
  fingerprint: string;
  target_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  expires_at: Date;
  decided_by: string | null;
  consumed_at: Date | null;
}
export interface ActionClaim {
  runClaim?: import('@imbox/runtime').LeaseClaim;
  machine?: import('@imbox/application').AuthContext;
  tenantId: string;
  actionId: string;
  attemptId: string;
  holder: string;
  generation: string;
  fingerprint: string;
}
