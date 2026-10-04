import { assertNonEmpty, assertVersion, DomainError } from './error.js';

export const TASK_STATUSES = [
  'open',
  'active',
  'blocked',
  'in_review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';
export type ResumableTaskStatus = 'open' | 'active' | 'in_review';

export interface Task {
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly accountablePrincipalId: string;
  readonly status: TaskStatus;
  readonly version: bigint;
  readonly executionEpoch: bigint;
  readonly acceptanceBaseline: string;
  readonly blockedFrom: ResumableTaskStatus | null;
  readonly reason: string | null;
}

export interface CompletionEvidence {
  readonly acceptanceConfirmed: boolean;
  readonly requiredChildrenClosed: boolean;
  readonly requiredActionsClosed: boolean;
  readonly evidenceRefs: readonly string[];
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function createTask(input: {
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly accountablePrincipalId: string;
  readonly acceptanceBaseline: string;
}): Task {
  assertNonEmpty(input.id, 'id');
  assertNonEmpty(input.ownerPrincipalId, 'ownerPrincipalId');
  assertNonEmpty(input.accountablePrincipalId, 'accountablePrincipalId');
  assertNonEmpty(input.acceptanceBaseline, 'acceptanceBaseline');
  return {
    ...input,
    status: 'open',
    version: 1n,
    executionEpoch: 1n,
    blockedFrom: null,
    reason: null,
  };
}

/** Authority and accepted proposal facts must be checked by the calling use case. */
export function acceptTaskHandoff(
  task: Task,
  input: {
    readonly expectedVersion: bigint;
    readonly expectedOwnerPrincipalId: string;
    readonly newOwnerPrincipalId: string;
  },
): Task {
  assertVersion(task.version, input.expectedVersion);
  assertTaskNotTerminal(task);
  assertNonEmpty(input.newOwnerPrincipalId, 'newOwnerPrincipalId');
  if (task.ownerPrincipalId !== input.expectedOwnerPrincipalId) {
    throw new DomainError('OWNER_CONFLICT', 409);
  }
  if (task.ownerPrincipalId === input.newOwnerPrincipalId) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'newOwnerPrincipalId' });
  }
  return {
    ...task,
    ownerPrincipalId: input.newOwnerPrincipalId,
    version: task.version + 1n,
    executionEpoch: task.executionEpoch + 1n,
  };
}

export function advanceTask(
  task: Task,
  target: 'active' | 'in_review',
  expectedVersion: bigint,
): Task {
  assertVersion(task.version, expectedVersion);
  const allowed =
    (task.status === 'open' && target === 'active') ||
    (task.status === 'active' && target === 'in_review') ||
    (task.status === 'in_review' && target === 'active');
  if (!allowed) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: task.status, to: target });
  }
  return { ...task, status: target, version: task.version + 1n, reason: null };
}

export function blockTask(task: Task, expectedVersion: bigint, reason: string): Task {
  assertVersion(task.version, expectedVersion);
  assertNonEmpty(reason, 'reason');
  if (task.status !== 'open' && task.status !== 'active' && task.status !== 'in_review') {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: task.status, to: 'blocked' });
  }
  return {
    ...task,
    status: 'blocked',
    blockedFrom: task.status,
    reason,
    version: task.version + 1n,
  };
}

export function resumeTask(task: Task, expectedVersion: bigint): Task {
  assertVersion(task.version, expectedVersion);
  if (task.status !== 'blocked' || task.blockedFrom === null) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: task.status, to: 'resume' });
  }
  return {
    ...task,
    status: task.blockedFrom,
    blockedFrom: null,
    reason: null,
    version: task.version + 1n,
  };
}

export function terminateTask(
  task: Task,
  input: {
    readonly expectedVersion: bigint;
    readonly status: TerminalTaskStatus;
    readonly reason: string;
    readonly completion?: CompletionEvidence;
  },
): Task {
  assertVersion(task.version, input.expectedVersion);
  assertTaskNotTerminal(task);
  assertNonEmpty(input.reason, 'reason');
  if (input.status === 'completed') {
    const completion = input.completion;
    if (
      task.status !== 'in_review' ||
      completion === undefined ||
      !completion.acceptanceConfirmed ||
      !completion.requiredChildrenClosed ||
      !completion.requiredActionsClosed ||
      completion.evidenceRefs.length === 0 ||
      completion.evidenceRefs.some((reference) => reference.trim().length === 0)
    ) {
      throw new DomainError('ACCEPTANCE_REQUIRED', 409);
    }
  }
  return {
    ...task,
    status: input.status,
    reason: input.reason,
    blockedFrom: null,
    version: task.version + 1n,
    executionEpoch: task.executionEpoch + 1n,
  };
}

export function reopenTask(
  task: Task,
  input: {
    readonly expectedVersion: bigint;
    readonly reason: string;
    readonly acceptanceBaseline: string;
  },
): Task {
  assertVersion(task.version, input.expectedVersion);
  assertNonEmpty(input.reason, 'reason');
  assertNonEmpty(input.acceptanceBaseline, 'acceptanceBaseline');
  if (!isTerminalTaskStatus(task.status)) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: task.status, to: 'open' });
  }
  return {
    ...task,
    status: 'open',
    blockedFrom: null,
    reason: input.reason,
    acceptanceBaseline: input.acceptanceBaseline,
    version: task.version + 1n,
    executionEpoch: task.executionEpoch + 1n,
  };
}

export interface TaskFenceSnapshot {
  readonly taskId: string;
  readonly executionEpoch: bigint;
}

/** Pass the complete locked ancestor chain, including the current task. */
export function assertTaskFencesCurrent(
  expected: readonly TaskFenceSnapshot[],
  current: readonly Pick<Task, 'id' | 'status' | 'executionEpoch'>[],
): void {
  if (expected.length === 0 || expected.length !== current.length) {
    throw new DomainError('EXECUTION_FENCE_CONFLICT', 409);
  }
  const ids = new Set<string>();
  for (const [index, snapshot] of expected.entries()) {
    const actual = current[index];
    if (
      ids.has(snapshot.taskId) ||
      actual === undefined ||
      actual.id !== snapshot.taskId ||
      actual.executionEpoch !== snapshot.executionEpoch
    ) {
      throw new DomainError('EXECUTION_FENCE_CONFLICT', 409);
    }
    ids.add(snapshot.taskId);
    if (isTerminalTaskStatus(actual.status)) {
      throw new DomainError('TASK_TERMINATED', 409, { taskId: actual.id });
    }
  }
}

function assertTaskNotTerminal(task: Task): void {
  if (isTerminalTaskStatus(task.status)) {
    throw new DomainError('TASK_TERMINATED', 409);
  }
}
