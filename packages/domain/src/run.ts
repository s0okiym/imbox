import { assertNonEmpty, assertVersion, DomainError } from './error.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_dependency',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunScope =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string };

export interface AgentRun {
  readonly id: string;
  readonly taskId: string | null;
  readonly originScope: RunScope;
  readonly status: RunStatus;
  readonly version: bigint;
  readonly cancellationRequested: boolean;
  readonly previousRunId: string | null;
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
  );
}

export function createRun(input: {
  readonly id: string;
  readonly originScope: RunScope;
  readonly previousRunId?: string;
}): AgentRun {
  assertNonEmpty(input.id, 'id');
  const scopeId =
    input.originScope.kind === 'task' ? input.originScope.taskId : input.originScope.conversationId;
  assertNonEmpty(scopeId, 'originScope');
  if (input.previousRunId !== undefined) {
    assertNonEmpty(input.previousRunId, 'previousRunId');
    if (input.previousRunId === input.id) {
      throw new DomainError('INVALID_ARGUMENT', 400, { field: 'previousRunId' });
    }
  }
  return {
    id: input.id,
    originScope: { ...input.originScope },
    taskId: input.originScope.kind === 'task' ? input.originScope.taskId : null,
    status: 'queued',
    version: 1n,
    cancellationRequested: false,
    previousRunId: input.previousRunId ?? null,
  };
}

export function transitionRun(
  run: AgentRun,
  target: RunStatus,
  input: {
    readonly expectedVersion: bigint;
    readonly safeCheckpointConfirmed?: boolean;
    readonly executionAuthorityTerminated?: boolean;
    readonly unresolvedActionsRegistered?: boolean;
  },
): AgentRun {
  assertVersion(run.version, input.expectedVersion);
  if (isTerminalRunStatus(run.status)) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: run.status, to: target });
  }
  const waiting =
    run.status === 'waiting_input' ||
    run.status === 'waiting_approval' ||
    run.status === 'waiting_dependency';
  const waitingTarget =
    target === 'waiting_input' || target === 'waiting_approval' || target === 'waiting_dependency';
  const allowed =
    target === 'failed' ||
    target === 'expired' ||
    (target === 'cancelling' && run.status !== 'cancelling') ||
    (run.status === 'cancelling' && target === 'cancelled') ||
    (run.status === 'queued' && target === 'running') ||
    (run.status === 'running' &&
      (waitingTarget || target === 'paused' || target === 'completed')) ||
    ((waiting || run.status === 'paused') && target === 'running') ||
    (waiting && target === 'paused');
  if (!allowed) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: run.status, to: target });
  }
  if (target === 'paused' && input.safeCheckpointConfirmed !== true) {
    throw new DomainError('CHECKPOINT_REQUIRED', 409);
  }
  if (
    target === 'cancelled' &&
    (input.executionAuthorityTerminated !== true || input.unresolvedActionsRegistered !== true)
  ) {
    throw new DomainError('CANCELLATION_NOT_CONFIRMED', 409);
  }
  return {
    ...run,
    status: target,
    version: run.version + 1n,
    cancellationRequested: run.cancellationRequested || target === 'cancelling',
  };
}

export function attachRunToTask(run: AgentRun, taskId: string, expectedVersion: bigint): AgentRun {
  assertVersion(run.version, expectedVersion);
  assertNonEmpty(taskId, 'taskId');
  if (run.taskId !== null) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'taskId' });
  }
  return { ...run, taskId, version: run.version + 1n };
}

export type RunActivity =
  | 'conversation_reply'
  | 'private_draft'
  | 'persistent_work'
  | 'delegation'
  | 'external_action'
  | 'scheduled_work'
  | 'acceptance';

export function assertRunSupportsActivity(run: AgentRun, activity: RunActivity): void {
  if (run.taskId === null && activity !== 'conversation_reply' && activity !== 'private_draft') {
    throw new DomainError('TASK_REQUIRED', 409, { activity });
  }
}
