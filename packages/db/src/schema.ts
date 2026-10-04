import type { ColumnType, Generated } from 'kysely';

export type Json = ColumnType<unknown, unknown, unknown>;
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
export type Bigint = ColumnType<string, string | bigint, string | bigint>;
export type GeneratedBigint = ColumnType<string, string | bigint | undefined, string | bigint>;
interface Audit {
  created_at: Timestamp;
  updated_at: Timestamp;
}
interface Versioned extends Audit {
  version: GeneratedBigint;
}
interface Principal extends Versioned {
  id: string;
  kind: 'human' | 'agent' | 'service';
  display_name: string;
  status: Generated<'active' | 'disabled' | 'deleted'>;
}
interface ExternalIdentity {
  id: string;
  principal_id: string;
  issuer: string;
  subject: string;
  created_at: Timestamp;
}
interface Tenant extends Versioned {
  id: string;
  name: string;
  status: Generated<'active' | 'suspended' | 'deleted'>;
}
interface TenantPrincipal extends Versioned {
  tenant_id: string;
  principal_id: string;
  role: Generated<'owner' | 'admin' | 'member' | 'agent' | 'guest'>;
  status: Generated<'active' | 'disabled' | 'historical'>;
  authz_revision: GeneratedBigint;
  membership_policy_version: GeneratedBigint;
}
interface Workspace extends Versioned {
  tenant_id: string;
  id: string;
  name: string;
}
interface Membership extends Versioned {
  tenant_id: string;
  workspace_id: string;
  principal_id: string;
  role: 'admin' | 'member' | 'guest';
  status: Generated<'active' | 'disabled'>;
}
interface Session extends Audit {
  id: string;
  principal_id: string;
  token_hash: string;
  csrf_token_hash: string;
  expires_at: Date | string;
  revoked_at: NullableTimestamp;
  revision: GeneratedBigint;
}
interface Conversation extends Versioned {
  tenant_id: string;
  id: string;
  workspace_id: Generated<string | null>;
  kind: 'direct' | 'group';
  title: string;
  created_by: string;
  history_policy: Generated<'all' | 'since_join'>;
  message_head_seq: GeneratedBigint;
  authz_generation: GeneratedBigint;
}
interface ConversationMember extends Versioned {
  tenant_id: string;
  conversation_id: string;
  principal_id: string;
  role: Generated<'owner' | 'admin' | 'member'>;
  status: Generated<'active' | 'left' | 'removed'>;
  visible_from_seq: GeneratedBigint;
  joined_at: Timestamp;
  left_at: NullableTimestamp;
}
interface Message extends Versioned {
  tenant_id: string;
  id: string;
  conversation_id: string;
  sender_principal_id: string;
  seq: Bigint;
  body: string;
  client_message_id: Generated<string | null>;
  reply_to_id: Generated<string | null>;
  reply_to_version: Generated<string | null>;
  thread_root_id: Generated<string | null>;
  deleted_at: NullableTimestamp;
}
interface MessageRevision {
  tenant_id: string;
  message_id: string;
  revision: Bigint;
  body: string;
  edited_by: string;
  created_at: Timestamp;
}
interface Reaction {
  tenant_id: string;
  id: string;
  message_id: string;
  principal_id: string;
  emoji: string;
  created_at: Timestamp;
}
interface ReadCursor {
  tenant_id: string;
  conversation_id: string;
  principal_id: string;
  last_read_seq: GeneratedBigint;
  updated_at: Timestamp;
}
interface CommandReceipt {
  tenant_id: string;
  principal_id: string;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  status: Generated<'pending' | 'completed'>;
  result_ref: Json;
  created_at: Timestamp;
  expires_at: Date | string;
}
interface Task extends Versioned {
  workspace_id: Generated<string | null>;
  archived: Generated<boolean>;
  goal_version: GeneratedBigint;
  authz_generation: GeneratedBigint;
  blocked_from: Generated<'open' | 'active' | 'in_review' | null>;
  state_reason: Generated<string | null>;
  execution_deadline: NullableTimestamp;
  reviewer_ids: Json;
  tenant_id: string;
  id: string;
  root_task_id: string;
  parent_task_id: Generated<string | null>;
  owner_principal_id: string;
  accountable_principal_id: string;
  created_by: string;
  title: string;
  goal: string;
  status: Generated<
    'open' | 'active' | 'blocked' | 'in_review' | 'completed' | 'failed' | 'cancelled'
  >;
  acceptance_criteria: Json;
  due_at: NullableTimestamp;
  execution_epoch: GeneratedBigint;
}
interface TaskParticipant extends Versioned {
  tenant_id: string;
  task_id: string;
  principal_id: string;
  role: 'owner' | 'contributor' | 'reviewer' | 'observer';
  status: Generated<'active' | 'removed'>;
}
interface TaskConversationLink extends Versioned {
  tenant_id: string;
  task_id: string;
  conversation_id: string;
  disclosure_scope_ref: string;
  public_summary: Generated<string>;
}
interface TaskDependency {
  tenant_id: string;
  dependent_task_id: string;
  prerequisite_task_id: string;
  created_at: Timestamp;
}
interface CollaborationRequest extends Versioned {
  ancestor_fences: Json;
  task_epoch: GeneratedBigint;
  goal_version: GeneratedBigint;
  tenant_id: string;
  id: string;
  task_id: string;
  kind: 'consult' | 'review' | 'delegate' | 'handoff';
  requester_principal_id: string;
  recipient_principal_id: string;
  status: Generated<
    | 'pending'
    | 'accepted'
    | 'rejected'
    | 'clarification_requested'
    | 'expired'
    | 'cancelled'
    | 'superseded'
  >;
  proposal: Json;
  proposal_version: GeneratedBigint;
  expected_task_version: Bigint;
  expires_at: Date | string;
}
interface Agreement {
  child_task_id: Generated<string | null>;
  tenant_id: string;
  id: string;
  request_id: string;
  task_id: string;
  accepted_by: string;
  accepted_version: Bigint;
  terms: Json;
  created_at: Timestamp;
}
interface DomainEvent {
  tenant_id: string;
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: Bigint;
  event_type: string;
  actor_principal_id: string;
  payload: Json;
  created_at: Timestamp;
}
interface Outbox extends Audit {
  lease_generation: GeneratedBigint;
  tenant_id: string;
  id: string;
  event_id: string;
  target: string;
  status: Generated<'pending' | 'leased' | 'completed' | 'dead'>;
  attempts: Generated<number>;
  available_at: Timestamp;
  lease_holder: Generated<string | null>;
  lease_expires_at: NullableTimestamp;
  last_error_code: Generated<string | null>;
}
interface ConsumerReceipt {
  tenant_id: string;
  consumer: string;
  event_id: string;
  target_scope: string;
  created_at: Timestamp;
}
interface ProjectionStream extends Audit {
  tenant_id: string;
  id: string;
  scope_type: 'conversation' | 'task' | 'inbox';
  scope_id: string;
  head_seq: GeneratedBigint;
  authz_generation: GeneratedBigint;
  retention_generation: GeneratedBigint;
}
interface Projection extends Audit {
  source_event_id: Generated<string | null>;
  source_seq: ColumnType<string | null, string | null | undefined, string | null>;
  tenant_id: string;
  stream_id: string;
  id: string;
  revision: Bigint;
  entity_type: string;
  entity_id: string;
  entity_version: Bigint;
  authz_generation: Bigint;
  dto: Json;
  retracted: Generated<boolean>;
}
interface ProjectionDelivery {
  source_seq: ColumnType<string | null, string | null | undefined, string | null>;
  tenant_id: string;
  stream_id: string;
  delivery_seq: Bigint;
  projection_id: string;
  revision: Bigint;
  event_id: string;
  authz_generation: Bigint;
  dto: Json;
  retracted: Generated<boolean>;
  created_at: Timestamp;
}

interface OidcLoginAttempt {
  id: string;
  state_hash: string;
  cookie_hash: string;
  context_encrypted: string;
  expires_at: Date | string;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

interface ProjectionCheckpoint {
  tenant_id: string;
  consumer: string;
  target_scope: string;
  aggregate_type: string;
  aggregate_id: string;
  last_event_version: GeneratedBigint;
  updated_at: Timestamp;
}
interface SyncSnapshotSession {
  tenant_id: string;
  id: string;
  principal_id: string;
  stream_id: string;
  authz_revision: Bigint;
  authz_generation: Bigint;
  retention_generation: Bigint;
  head_seq: Bigint;
  head_cursor: string;
  expires_at: Date | string;
  created_at: Timestamp;
  window_mode: Generated<'all' | 'recent'>;
  history_truncated: Generated<boolean>;
}
interface SyncSnapshotItem {
  tenant_id: string;
  snapshot_id: string;
  ordinal: Bigint;
  projection_id: string;
  projection_revision: Bigint;
  entity_type: string;
  entity_id: string;
  entity_version: Bigint;
  event_id: string;
  payload: Json;
  retracted: boolean;
}

export interface Database {
  projection_checkpoints: ProjectionCheckpoint;
  sync_snapshot_sessions: SyncSnapshotSession;
  sync_snapshot_items: SyncSnapshotItem;
  oidc_login_attempts: OidcLoginAttempt;
  principals: Principal;
  external_identities: ExternalIdentity;
  tenants: Tenant;
  tenant_principals: TenantPrincipal;
  workspaces: Workspace;
  memberships: Membership;
  sessions: Session;
  conversations: Conversation;
  conversation_members: ConversationMember;
  messages: Message;
  message_revisions: MessageRevision;
  reactions: Reaction;
  read_cursors: ReadCursor;
  command_receipts: CommandReceipt;
  tasks: Task;
  task_participants: TaskParticipant;
  task_conversation_links: TaskConversationLink;
  task_dependencies: TaskDependency;
  collaboration_requests: CollaborationRequest;
  agreements: Agreement;
  domain_events: DomainEvent;
  outbox: Outbox;
  consumer_receipts: ConsumerReceipt;
  projection_streams: ProjectionStream;
  projections: Projection;
  projection_deliveries: ProjectionDelivery;
}
