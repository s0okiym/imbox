import type { AuthContext } from '@imbox/application';
import type { RunStatus } from '@imbox/domain';
export type Fence = { id: string; execution_epoch: string };
export interface RunRow {
  tool_grant_id: string | null;
  tool_grant_revision: string | null;
  execution_location: 'hosted' | 'device' | 'external';
  report_source: 'platform_verified' | 'external_report';
  tenant_id: string;
  id: string;
  agent_id: string;
  agent_revision: string;
  created_by: string;
  creator_authz_revision: string;
  agent_authz_revision: string;
  installation_authz_revision: string;
  creator_principal_version: string;
  agent_principal_version: string;
  scope_authorization: Record<string, unknown>;
  task_id: string | null;
  conversation_id: string | null;
  origin_type: 'task' | 'conversation';
  ancestor_fences: Fence[];
  status: RunStatus;
  version: string;
  cancellation_requested: boolean;
  pause_requested: boolean;
  lease_holder: string | null;
  lease_generation: string;
  lease_expires_at: Date | null;
  checkpoint_seq: string;
  summary: string;
  output: string | null;
  budget_currency: string;
  budget_limit_microunits: string;
  budget_reserved_microunits: string;
  budget_spent_microunits: string;
  budget_blocked: boolean;
  context_manifest_id: string;
  previous_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface TaskRow {
  id: string;
  root_task_id: string;
  parent_task_id: string | null;
  owner_principal_id: string;
  workspace_id: string;
  status: string;
  execution_epoch: string;
  goal_version: string;
  version: string;
  authz_generation: string;
  title: string;
  goal: string;
  archived: boolean;
  execution_deadline: Date | null;
  deadline_valid?: boolean;
  owner_available?: boolean;
}
export interface Installation {
  id: string;
  agent_principal_id: string;
  status: 'active' | 'disabled';
  mode: 'hosted' | 'device' | 'external';
  authz_revision: string;
  version: string;
}
export type SourceReference =
  | { type: 'message' | 'task'; id: string; version: string; required: boolean }
  | {
      type: 'memory' | 'artifact_version';
      id: string;
      version: string;
      required: boolean;
      sha256: string;
    };
export interface ContextItem {
  ordinal: number;
  source_type: 'message' | 'task' | 'memory' | 'artifact_version';
  source_id: string;
  source_version: string;
  source_sha256: string | null;
  content_hash: string;
  required: boolean;
  trust_level: 'untrusted_user_content';
  payload: Record<string, unknown>;
  authorization_snapshot: Record<string, unknown>;
}
export interface CreateRunInput {
  agent_id: string;
  agent_revision: string;
  task_id?: string;
  conversation_id?: string;
  previous_run_id?: string;
  tool_grant_id?: string;
  context: SourceReference[];
  purpose: string;
  destination: string;
  budget: { currency: string; limit_microunits: string };
}
export interface LeaseClaim {
  tenantId: string;
  runId: string;
  holder: string;
  generation: string;
}
export interface ReportInput {
  status:
    | 'running'
    | 'waiting_input'
    | 'waiting_approval'
    | 'waiting_dependency'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  checkpoint: Record<string, unknown>;
  summary?: string;
  output?: string;
}
export interface Reservation {
  id: string;
  run_id: string;
  task_id: string | null;
  root_task_id: string | null;
  reservation_key: string;
  account_ids: string[];
  currency: string;
  amount_microunits: string;
  actual_microunits: string | null;
  status: 'held' | 'unknown' | 'settled' | 'released';
  usage_key: string | null;
}
export interface BudgetRow {
  task_id: string;
  currency: string;
  limit_microunits: string;
  reserved_microunits: string;
  spent_microunits: string;
  blocked: boolean;
  overrun_microunits: string;
}
export type RuntimeAuth = AuthContext;
