import { notificationDefinitions } from './notification-definitions.js';
import { artifactCollaborationDefinitions } from './artifact-collaboration-definitions.js';
import { governanceDefinitions } from './governance-definitions.js';
import { recoveryDefinitions } from './recovery-definitions.js';
import { knowledgeDefinitions } from './knowledge-definitions.js';
import { promotionDefinitions } from './promotion-definitions.js';
import { maintenanceDefinitions } from './maintenance-definitions.js';
import { schedulingDefinitions } from './scheduling-definitions.js';
import { resourceDefinitions } from './resource-definitions.js';
import { agentDefinitions } from './agent-definitions.js';
import { runtimeDefinitions } from './runtime-definitions.js';
import { actionDefinitions } from './action-definitions.js';
/** Authoritative, portable JSON Schema 2020-12 definitions. Never add DTOs by hand. */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const CONTRACT_SCHEMA_ID = 'https://imbox.local/schemas/v1/contracts.json';
export const CONTRACT_VERSION = '0.1.0';
export const WIRE_LIMITS = Object.freeze({ maxBytes: 262_144, maxDepth: 16, maxNodes: 10_000 });
export const PAGE_WIRE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 50_000,
});

export type SchemaNode = Record<string, unknown>;
const ref = (name: string): SchemaNode => ({ $ref: `#/$defs/${name}` });
const str = (maxLength: number, minLength = 1): SchemaNode => ({
  type: 'string',
  minLength,
  maxLength,
});
const enumeration = (...values: string[]): SchemaNode => ({ type: 'string', enum: values });
const integer = (minimum: number, maximum: number): SchemaNode => ({
  type: 'integer',
  minimum,
  maximum,
});
const array = (items: SchemaNode, maxItems: number, minItems = 0): SchemaNode => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
const object = (
  properties: Record<string, SchemaNode>,
  required = Object.keys(properties),
): SchemaNode => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Portable regex for a decimal string <= the signed PostgreSQL bigint maximum. */
function int64Pattern(allowZero: boolean): string {
  const upper = '9223372036854775807';
  const terms = ['[1-9][0-9]{0,17}'];
  for (let i = 0; i < upper.length; i += 1) {
    const digit = Number(upper[i]);
    const lower = i === 0 ? 1 : 0;
    if (digit > lower) {
      const leading = digit - 1 === lower ? String(lower) : `[${lower}-${digit - 1}]`;
      const remaining = upper.length - i - 1;
      terms.push(`${upper.slice(0, i)}${leading}${remaining ? `[0-9]{${remaining}}` : ''}`);
    }
  }
  return `^(?:${allowZero ? '0|' : ''}${[...terms, upper].join('|')})$`;
}

const viewProperties = {
  view_scope: ref('Identifier'),
  authz_generation: ref('Version'),
  projection_id: ref('Identifier'),
  projection_revision: ref('Version'),
};

export const definitions = {
  ...knowledgeDefinitions,
  ...recoveryDefinitions,
  ...notificationDefinitions,
  ...governanceDefinitions,
  ...artifactCollaborationDefinitions,
  ...promotionDefinitions,
  ...maintenanceDefinitions,
  ...schedulingDefinitions,
  ...resourceDefinitions,
  ...agentDefinitions,
  ...actionDefinitions,
  ...runtimeDefinitions,
  Identifier: { ...str(36, 36), format: 'uuid' },
  Version: { ...str(19), pattern: int64Pattern(false) },
  Counter: { ...str(19), pattern: int64Pattern(true) },
  UtcTimestamp: {
    ...str(30, 20),
    format: 'date-time',
    pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$',
  },
  Cursor: { ...str(4096), pattern: '^[A-Za-z0-9._~-]+$' },
  IdempotencyKey: { ...str(128, 16), pattern: '^[A-Za-z0-9._~-]+$' },
  PaginationQuery: object({ cursor: ref('Cursor'), limit: integer(1, 200) }, []),
  ResourceParams: object({ id: ref('Identifier') }),
  ProjectionContext: object(viewProperties),
  Principal: object({
    id: ref('Identifier'),
    kind: enumeration('human', 'agent', 'service'),
    display_name: str(120),
    status: enumeration('active', 'disabled', 'deleted'),
  }),
  Workspace: object({
    id: ref('Identifier'),
    name: str(120),
    role: enumeration('owner', 'admin', 'member', 'guest'),
  }),
  WorkspacePage: object({ items: array(ref('Workspace'), 200) }),
  DevLoginInput: object({ principal_id: ref('Identifier') }),
  DevLoginResult: object({
    session_id: ref('Identifier'),
    principal_id: ref('Identifier'),
    csrf_token: str(128),
    expires_at: ref('UtcTimestamp'),
  }),
  Session: object({
    id: ref('Identifier'),
    created_at: ref('UtcTimestamp'),
    expires_at: ref('UtcTimestamp'),
    revoked_at: { anyOf: [ref('UtcTimestamp'), { type: 'null' }] },
    revision: ref('Version'),
  }),
  Me: object({
    principal: ref('Principal'),
    tenant_id: ref('Identifier'),
    csrf_token: str(128),
    authz_revision: ref('Version'),
    session_id: ref('Identifier'),
    session_expires_at: ref('UtcTimestamp'),
    workspaces: array(ref('Workspace'), 200),
    capabilities: { ...array(str(100), 200), uniqueItems: true },
  }),
  WorkspaceMemberPage: object({
    items: array(
      object({ principal: ref('Principal'), role: enumeration('admin', 'member', 'guest') }),
      200,
    ),
  }),
  ConversationMemberPage: object({
    items: array(
      object({ principal: ref('Principal'), role: enumeration('owner', 'admin', 'member') }),
      200,
    ),
  }),
  AddConversationMemberInput: object(
    { principal_id: ref('Identifier'), role: enumeration('admin', 'member') },
    ['principal_id'],
  ),
  ReactionInput: object({ emoji: enumeration('👍', '❤️', '🎉', '😄', '👀', '🙏') }),
  MessageReactionSummary: object({ emoji: str(32), count: ref('Counter') }),
  MessageQuote: object({
    source_id: ref('Identifier'),
    source_version: ref('Version'),
    body: { anyOf: [str(16384, 0), { type: 'null' }] },
    unavailable: { type: 'boolean' },
  }),
  ReactionPage: object(
    {
      next_cursor: ref('Cursor'),
      items: array(
        object({
          id: ref('Identifier'),
          message_id: ref('Identifier'),
          principal_id: ref('Identifier'),
          emoji: str(32),
        }),
        200,
      ),
    },
    ['items'],
  ),
  ReadCursorInput: object({ last_read_seq: ref('Counter') }),
  ReadCursor: object({ last_read_seq: ref('Counter') }),
  Error: object(
    {
      code: enumeration(
        'UNAUTHENTICATED',
        'FORBIDDEN',
        'DISCLOSURE_DENIED',
        'NOT_FOUND',
        'VALIDATION_FAILED',
        'VERSION_CONFLICT',
        'IDEMPOTENCY_CONFLICT',
        'REQUEST_EXPIRED',
        'RESYNC_REQUIRED',
        'BUDGET_EXCEEDED',
        'DEPENDENCY_BLOCKED',
        'INVALID_STATE_TRANSITION',
        'ACCEPTANCE_REQUIRED',
        'TASK_TERMINATED',
        'PROPOSAL_VERSION_CONFLICT',
        'DEPENDENCY_CYCLE',
        'EXECUTION_FENCE_CONFLICT',
        'OWNER_CONFLICT',
        'LEASE_CONFLICT',
        'LEASE_EXPIRED',
        'LEASE_NOT_EXPIRED',
        'RETRY_NOT_SAFE',
        'RETRY_EXHAUSTED',
        'BUDGET_BLOCKED',
        'USAGE_CONFLICT',
        'RESERVATION_NOT_FOUND',
        'CHARGE_STATUS_UNKNOWN',
        'CONTENT_REJECTED',
        'CAPACITY_EXCEEDED',
        'HANDOFF_ACTIONS_CHANGED',
        'HANDOFF_ACTIONS_LIMIT',
        'STEP_LIMIT_EXCEEDED',
        'EXECUTION_EXPIRED',
        'RATE_LIMITED',
        'ACTION_OUTCOME_UNKNOWN',
        'SERVICE_UNAVAILABLE',
        'INTERNAL_ERROR',
      ),
      message: str(1000),
      request_id: str(128),
      retryable: { type: 'boolean' },
      details: object(
        {
          current_version: ref('Version'),
          fields: array(str(128), 32),
          retry_after_seconds: integer(0, 86_400),
        },
        [],
      ),
    },
    ['code', 'message', 'request_id', 'retryable'],
  ),
  CreateConversationInput: object(
    {
      workspace_id: ref('Identifier'),
      kind: enumeration('direct', 'group'),
      title: str(200),
      member_ids: { ...array(ref('Identifier'), 100, 1), uniqueItems: true },
      history_policy: enumeration('since_join', 'all'),
    },
    ['workspace_id', 'kind', 'member_ids'],
  ),
  Conversation: object({
    id: ref('Identifier'),
    workspace_id: ref('Identifier'),
    kind: enumeration('direct', 'group'),
    title: str(200),
    version: ref('Version'),
    created_at: ref('UtcTimestamp'),
    history_policy: enumeration('since_join', 'all'),
    ...viewProperties,
  }),
  CreateMessageInput: {
    ...object(
      {
        client_message_id: ref('Identifier'),
        body: str(16_384),
        format: enumeration('text', 'markdown'),
        attachment_ids: { ...array(ref('Identifier'), 10), uniqueItems: true },
        reply_to_id: ref('Identifier'),
        reply_to_version: ref('Version'),
        thread_root_id: ref('Identifier'),
      },
      ['client_message_id', 'body'],
    ),
    dependentRequired: { reply_to_id: ['reply_to_version'], reply_to_version: ['reply_to_id'] },
  },
  EditMessageInput: object({ body: str(16_384), format: enumeration('text', 'markdown') }, [
    'body',
  ]),
  Message: object(
    {
      id: ref('Identifier'),
      conversation_id: ref('Identifier'),
      client_message_id: ref('Identifier'),
      actor: ref('Principal'),
      version: ref('Version'),
      seq: ref('Counter'),
      body: str(16_384, 0),
      format: enumeration('text', 'markdown'),
      attachment_ids: { ...array(ref('Identifier'), 10), uniqueItems: true },
      reply_to_id: ref('Identifier'),
      reply_to_version: ref('Version'),
      thread_root_id: ref('Identifier'),
      created_at: ref('UtcTimestamp'),
      edited_at: ref('UtcTimestamp'),
      deleted: { type: 'boolean' },
      quote: ref('MessageQuote'),
      reactions: array(ref('MessageReactionSummary'), 6),
      ...viewProperties,
    },
    [
      'id',
      'conversation_id',
      'client_message_id',
      'actor',
      'version',
      'seq',
      'body',
      'format',
      'attachment_ids',
      'created_at',
      'deleted',
      ...Object.keys(viewProperties),
    ],
  ),
  ConversationPage: object({ items: array(ref('Conversation'), 200), next_cursor: ref('Cursor') }, [
    'items',
  ]),
  MessagePage: object({ items: array(ref('Message'), 200), next_cursor: ref('Cursor') }, ['items']),
  Budget: object({
    currency: { ...str(3, 3), pattern: '^[A-Z]{3}$' },
    limit_microunits: ref('Counter'),
    reserved_microunits: ref('Counter'),
    spent_microunits: ref('Counter'),
  }),
  TaskVersionRef: object({
    type: { const: 'task', type: 'string' },
    id: ref('Identifier'),
    version: ref('Version'),
  }),
  TextEvidenceInput: object({
    type: { const: 'text', type: 'string' },
    text: str(8000),
    source_refs: array(ref('TaskVersionRef'), 20),
  }),
  ArtifactEvidenceRef: object({
    type: { const: 'artifact_version', type: 'string' },
    artifact_id: ref('Identifier'),
    version_id: ref('Identifier'),
    sha256: { ...str(64, 64), pattern: '^[a-f0-9]{64}$' },
  }),
  EvidenceInput: { oneOf: [ref('TextEvidenceInput'), ref('ArtifactEvidenceRef')] },
  TextEvidence: object({
    type: { const: 'text', type: 'string' },
    id: ref('Identifier'),
    text: str(8000),
    source_refs: array(ref('TaskVersionRef'), 20),
    sha256: { ...str(64, 64), pattern: '^[a-f0-9]{64}$' },
  }),
  Evidence: { oneOf: [ref('TextEvidence'), ref('ArtifactEvidenceRef')] },
  InitialBudget: object({
    currency: { ...str(3, 3), pattern: '^[A-Z]{3}$' },
    limit_microunits: ref('Counter'),
  }),
  CreateTaskInput: object(
    {
      workspace_id: ref('Identifier'),
      title: str(300),
      goal: str(8000),
      acceptance_criteria: array(str(1000), 20, 1),
      reviewer_principal_ids: { ...array(ref('Identifier'), 20, 1), uniqueItems: true },
      budget: ref('InitialBudget'),
      due_at: ref('UtcTimestamp'),
      execution_deadline: ref('UtcTimestamp'),
    },
    ['workspace_id', 'title', 'goal', 'acceptance_criteria', 'reviewer_principal_ids', 'budget'],
  ),
  UpdateTaskInput: object(
    {
      title: str(300),
      goal: str(8000),
      acceptance_criteria: array(str(1000), 20, 1),
      archived: { type: 'boolean' },
      due_at: ref('UtcTimestamp'),
    },
    [],
  ),
  TaskParticipantInput: object({
    principal_id: ref('Identifier'),
    role: enumeration('contributor', 'reviewer', 'observer'),
  }),
  TaskParticipantPage: object({
    items: array(
      object({
        principal_id: ref('Identifier'),
        role: enumeration('owner', 'contributor', 'reviewer', 'observer'),
        version: ref('Version'),
      }),
      200,
    ),
  }),
  TaskReasonInput: object({ reason: str(2000) }),
  ReopenTaskInput: object({ reason: str(2000), acceptance_criteria: array(str(1000), 20, 1) }),
  TaskStateInput: object(
    { state: enumeration('active', 'blocked', 'resume', 'failed'), reason: str(2000) },
    ['state'],
  ),
  TaskConversationLinkInput: object({
    conversation_id: ref('Identifier'),
    public_summary: str(2000),
  }),
  TaskSummary: object({
    task_id: ref('Identifier'),
    conversation_id: ref('Identifier'),
    public_summary: str(2000),
    version: ref('Version'),
  }),
  TaskSummaryPage: object({ items: array(ref('TaskSummary'), 200) }),
  TaskDependencyInput: object({ prerequisite_task_id: ref('Identifier') }),
  WorkProposal: object(
    {
      title: str(300),
      goal: str(8000),
      inputs: array(ref('EvidenceInput'), 20),
      deliverable_schema: { const: 'imbox.text-evidence.v1', type: 'string' },
      acceptance: object({
        criteria: array(str(1000), 20, 1),
        reviewer_principal_ids: { ...array(ref('Identifier'), 20, 1), uniqueItems: true },
      }),
      budget: ref('InitialBudget'),
      due_at: ref('UtcTimestamp'),
      execution_deadline: ref('UtcTimestamp'),
      allowed_actions: array(str(128), 0),
      disclosure: object({
        scope: { const: 'request_recipients', type: 'string' },
        summary: str(2000),
      }),
      dependencies: { ...array(ref('Identifier'), 50), uniqueItems: true },
      cancellation_rule: { const: 'owner_or_accountable', type: 'string' },
      escalation_principal_id: ref('Identifier'),
      handoff: object({
        completed_summary: str(4000, 0),
        pending_summary: str(4000, 0),
        pending_action_ids: { ...array(ref('Identifier'), 100), uniqueItems: true },
      }),
    },
    [
      'title',
      'goal',
      'inputs',
      'deliverable_schema',
      'acceptance',
      'budget',
      'allowed_actions',
      'disclosure',
      'dependencies',
      'cancellation_rule',
      'escalation_principal_id',
    ],
  ),
  CreateTaskRequestInput: object({
    kind: enumeration('consult', 'review', 'delegate', 'handoff'),
    recipient_principal_id: ref('Identifier'),
    proposal: ref('WorkProposal'),
    request_expires_at: ref('UtcTimestamp'),
  }),
  ReviseTaskRequestInput: object({
    proposal: ref('WorkProposal'),
    request_expires_at: ref('UtcTimestamp'),
    expected_task_version: ref('Version'),
  }),
  SubmissionInput: object({
    goal_version: ref('Version'),
    summary: str(2000),
    evidence: array(ref('EvidenceInput'), 20, 1),
  }),
  Submission: object({
    id: ref('Identifier'),
    task_id: ref('Identifier'),
    submitted_by: ref('Identifier'),
    goal_version: ref('Version'),
    execution_epoch: ref('Version'),
    summary: str(2000),
    evidence: array(ref('Evidence'), 20, 1),
    created_at: ref('UtcTimestamp'),
  }),
  SubmissionPage: object({ items: array(ref('Submission'), 200) }),
  TaskReviewInput: object({
    submission_id: ref('Identifier'),
    decision: enumeration('accept', 'return'),
    comment: str(2000),
  }),
  TaskReview: object({
    id: ref('Identifier'),
    task_id: ref('Identifier'),
    submission_id: ref('Identifier'),
    reviewer_id: ref('Identifier'),
    decision: enumeration('accept', 'return'),
    comment: str(2000),
    goal_version: ref('Version'),
    execution_epoch: ref('Version'),
    created_at: ref('UtcTimestamp'),
  }),
  TaskReviewPage: object({ items: array(ref('TaskReview'), 200) }),
  Agreement: object(
    {
      id: ref('Identifier'),
      request_id: ref('Identifier'),
      task_id: ref('Identifier'),
      accepted_by: ref('Identifier'),
      accepted_version: ref('Version'),
      terms: ref('WorkProposal'),
      child_task_id: ref('Identifier'),
      created_at: ref('UtcTimestamp'),
    },
    ['id', 'request_id', 'task_id', 'accepted_by', 'accepted_version', 'terms', 'created_at'],
  ),
  RequestDecisionResult: object(
    { request: ref('CollaborationRequest'), agreement: ref('Agreement') },
    ['request'],
  ),
  CollaborationRequestPage: object(
    { items: array(ref('CollaborationRequest'), 200), next_cursor: ref('Cursor') },
    ['items'],
  ),
  TaskPage: object({ items: array(ref('Task'), 200), next_cursor: ref('Cursor') }, ['items']),
  Task: object(
    {
      id: ref('Identifier'),
      workspace_id: ref('Identifier'),
      root_task_id: ref('Identifier'),
      parent_task_id: ref('Identifier'),
      title: str(300),
      goal_version: ref('Version'),
      reviewer_principal_ids: array(ref('Identifier'), 20),
      goal: str(8000),
      owner_principal_id: ref('Identifier'),
      accountable_principal_id: ref('Identifier'),
      status: enumeration(
        'open',
        'active',
        'blocked',
        'in_review',
        'completed',
        'failed',
        'cancelled',
      ),
      archived: { type: 'boolean' },
      version: ref('Version'),
      execution_epoch: ref('Version'),
      created_at: ref('UtcTimestamp'),
      due_at: ref('UtcTimestamp'),
      acceptance_criteria: array(str(1000), 20),
      budget: ref('Budget'),
      ...viewProperties,
    },
    [
      'id',
      'workspace_id',
      'root_task_id',
      'title',
      'goal_version',
      'reviewer_principal_ids',
      'archived',
      'goal',
      'owner_principal_id',
      'accountable_principal_id',
      'status',
      'version',
      'execution_epoch',
      'created_at',
      'acceptance_criteria',
      'budget',
      ...Object.keys(viewProperties),
    ],
  ),
  RequestDecisionInput: object(
    {
      decision: enumeration('accept', 'reject', 'clarify'),
      proposal_version: ref('Version'),
      expected_task_version: ref('Version'),
      comment: str(2000),
    },
    ['decision', 'proposal_version', 'expected_task_version'],
  ),
  CollaborationRequest: object(
    {
      received_at: { anyOf: [ref('UtcTimestamp'), { type: 'null' }] },
      id: ref('Identifier'),
      task_id: ref('Identifier'),
      kind: enumeration('consult', 'review', 'delegate', 'handoff'),
      proposer_id: ref('Identifier'),
      recipient_id: ref('Identifier'),
      proposal_version: ref('Version'),
      version: ref('Version'),
      expected_task_version: ref('Version'),
      execution_epoch: ref('Version'),
      goal_version: ref('Version'),
      proposal: ref('WorkProposal'),
      status: enumeration(
        'pending',
        'clarification_requested',
        'accepted',
        'rejected',
        'cancelled',
        'expired',
        'superseded',
      ),
      goal: str(8000),
      request_expires_at: ref('UtcTimestamp'),
      created_at: ref('UtcTimestamp'),
      ...viewProperties,
    },
    [
      'id',
      'task_id',
      'kind',
      'proposer_id',
      'recipient_id',
      'proposal_version',
      'version',
      'expected_task_version',
      'execution_epoch',
      'goal_version',
      'proposal',
      'status',
      'goal',
      'request_expires_at',
      'created_at',
      ...Object.keys(viewProperties),
    ],
  ),
  TaskHandoffActions: object({
    task_id: ref('Identifier'),
    task_version: ref('Version'),
    pending_action_ids: { ...array(ref('Identifier'), 100), uniqueItems: true },
  }),
  Handoff: object({
    request_id: ref('Identifier'),
    task_id: ref('Identifier'),
    from_owner_id: ref('Identifier'),
    to_owner_id: ref('Identifier'),
    status: enumeration(
      'pending',
      'clarification_requested',
      'accepted',
      'rejected',
      'cancelled',
      'expired',
      'superseded',
    ),
    proposal_version: ref('Version'),
    expected_task_version: ref('Version'),
    summary: str(8000),
    pending_action_ids: { ...array(ref('Identifier'), 100), uniqueItems: true },
    ...viewProperties,
  }),
  AgentRun: object(
    {
      id: ref('Identifier'),
      agent_id: ref('Identifier'),
      agent_revision: ref('Version'),
      task_id: ref('Identifier'),
      conversation_id: ref('Identifier'),
      version: ref('Version'),
      lease_generation: ref('Version'),
      status: enumeration(
        'queued',
        'running',
        'waiting_input',
        'waiting_approval',
        'waiting_dependency',
        'paused',
        'completed',
        'failed',
        'cancelling',
        'cancelled',
        'expired',
      ),
      execution_location: enumeration('hosted', 'device', 'external'),
      report_source: enumeration('platform_verified', 'external_report'),
      created_at: ref('UtcTimestamp'),
      summary: str(2000, 0),
      ...viewProperties,
    },
    [
      'id',
      'agent_id',
      'agent_revision',
      'version',
      'lease_generation',
      'status',
      'execution_location',
      'report_source',
      'created_at',
      'summary',
      ...Object.keys(viewProperties),
    ],
  ),
  ApprovalDecisionInput: object(
    {
      decision: enumeration('approve', 'reject'),
      action_version: ref('Version'),
      comment: str(2000),
    },
    ['decision', 'action_version'],
  ),
  Approval: object({
    id: ref('Identifier'),
    action_id: ref('Identifier'),
    action_version: ref('Version'),
    requester_id: ref('Identifier'),
    executor_id: ref('Identifier'),
    summary: str(4000),
    status: enumeration('pending', 'approved', 'rejected', 'expired', 'revoked'),
    expires_at: ref('UtcTimestamp'),
    created_at: ref('UtcTimestamp'),
    ...viewProperties,
  }),
  Artifact: object({
    id: ref('Identifier'),
    version_id: ref('Identifier'),
    version: ref('Version'),
    kind: enumeration('text', 'markdown', 'image', 'file', 'code_patch'),
    title: str(200),
    content_resource_id: ref('Identifier'),
    created_by: ref('Identifier'),
    created_at: ref('UtcTimestamp'),
    source_ids: { ...array(ref('Identifier'), 100), uniqueItems: true },
    ...viewProperties,
  }),
  EntityReference: object({
    type: enumeration(
      'conversation',
      'message',
      'task',
      'request',
      'agent_run',
      'approval',
      'artifact',
    ),
    id: ref('Identifier'),
    version: ref('Version'),
  }),
  ProjectionPayload: object(
    {
      summary: str(4000, 0),
      status: str(64),
      resource_ref: ref('Identifier'),
      approval_ref: ref('Identifier'),
      message: ref('Message'),
      conversation: ref('Conversation'),
    },
    ['summary'],
  ),
  ProjectionEnvelope: object({
    type: enumeration('projection.upsert', 'projection.remove'),
    protocol_version: { const: 1, type: 'integer' },
    stream_id: ref('Identifier'),
    ...viewProperties,
    event_id: ref('Identifier'),
    entity: ref('EntityReference'),
    cursor: ref('Cursor'),
    schema_version: { const: 1, type: 'integer' },
    payload: ref('ProjectionPayload'),
  }),
  StreamSnapshot: object(
    {
      stream_id: ref('Identifier'),
      view_scope: ref('Identifier'),
      authz_generation: ref('Version'),
      snapshot_id: ref('Identifier'),
      window: { type: 'string', const: 'recent' },
      history_truncated: { type: 'boolean' },
      items: array(ref('ProjectionEnvelope'), 200),
      cursor: ref('Cursor'),
      next_cursor: ref('Cursor'),
      complete: { type: 'boolean' },
    },
    ['stream_id', 'view_scope', 'authz_generation', 'snapshot_id', 'items', 'cursor', 'complete'],
  ),
  StreamEvents: object({
    stream_id: ref('Identifier'),
    view_scope: ref('Identifier'),
    authz_generation: ref('Version'),
    items: array(ref('ProjectionEnvelope'), 200),
    cursor: ref('Cursor'),
    has_more: { type: 'boolean' },
  }),
  WsHello: object({
    type: { const: 'hello', type: 'string' },
    protocol_version: { const: 1, type: 'integer' },
    client_id: ref('Identifier'),
  }),
  WsSubscribe: object(
    {
      type: { const: 'subscribe', type: 'string' },
      stream_id: ref('Identifier'),
      cursor: ref('Cursor'),
    },
    ['type', 'stream_id'],
  ),
  WsAck: object({
    type: { const: 'ack', type: 'string' },
    stream_id: ref('Identifier'),
    cursor: ref('Cursor'),
  }),
  WsWelcome: object({
    type: { const: 'welcome', type: 'string' },
    protocol_version: { const: 1, type: 'integer' },
    connection_id: ref('Identifier'),
    heartbeat_seconds: integer(5, 120),
  }),
  WsSubscribed: object({
    type: { const: 'subscribed', type: 'string' },
    stream_id: ref('Identifier'),
    authz_generation: ref('Version'),
    cursor: ref('Cursor'),
  }),
  WsControl: object({
    type: enumeration('resync_required', 'access_revoked'),
    stream_id: ref('Identifier'),
    reason: enumeration(
      'cursor_expired',
      'authorization_changed',
      'unsupported_schema',
      'slow_consumer',
    ),
  }),
  WsHeartbeat: object({ type: enumeration('ping', 'pong'), nonce: str(64) }),
  WsClientFrame: { oneOf: [ref('WsHello'), ref('WsSubscribe'), ref('WsAck'), ref('WsHeartbeat')] },
  WsServerFrame: {
    oneOf: [
      ref('WsWelcome'),
      ref('WsSubscribed'),
      ref('WsControl'),
      ref('WsHeartbeat'),
      ref('ProjectionEnvelope'),
    ],
  },
} satisfies Record<string, SchemaNode>;

export type SchemaName = keyof typeof definitions;
export const schemaNames = Object.keys(definitions) as SchemaName[];
export const schemaDocument = {
  $schema: JSON_SCHEMA_DIALECT,
  $id: CONTRACT_SCHEMA_ID,
  $defs: Object.fromEntries(
    schemaNames.map((name) => [name, { title: name, ...definitions[name] }]),
  ),
};

/** Self-contained schema for frameworks which compile each route independently. */
export function schemaFor(name: SchemaName): SchemaNode {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `https://imbox.local/schemas/v1/${name}.json`,
    $defs: schemaDocument.$defs,
    $ref: `#/$defs/${name}`,
  };
}

export const schemas = Object.fromEntries(
  schemaNames.map((name) => [name, schemaFor(name)]),
) as Record<SchemaName, SchemaNode>;
