import { assertNonEmpty, assertTimestamp, assertVersion, DomainError } from './error.js';

export const ACTION_STATUSES = [
  'proposed',
  'awaiting_approval',
  'ready',
  'executing',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const ATTEMPT_STATUSES = [
  'prepared',
  'in_flight',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type SideEffectObservation = 'not_attempted' | 'none' | 'possible' | 'confirmed';

export interface Action {
  readonly id: string;
  readonly taskId: string;
  readonly businessKey: string;
  readonly parameterFingerprint: string;
  readonly status: ActionStatus;
  readonly version: bigint;
  readonly attemptCount: number;
  readonly lastAttemptId: string | null;
  readonly nextAttemptAtMs: number | null;
}

export interface ActionAttempt {
  readonly id: string;
  readonly actionId: string;
  readonly attemptNo: number;
  readonly version: bigint;
  readonly status: AttemptStatus;
  readonly sideEffect: SideEffectObservation;
}

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function createAction(input: {
  readonly id: string;
  readonly taskId: string;
  readonly businessKey: string;
  readonly parameterFingerprint: string;
}): Action {
  assertNonEmpty(input.id, 'id');
  assertNonEmpty(input.taskId, 'taskId');
  assertNonEmpty(input.businessKey, 'businessKey');
  assertNonEmpty(input.parameterFingerprint, 'parameterFingerprint');
  return {
    ...input,
    status: 'proposed',
    version: 1n,
    attemptCount: 0,
    lastAttemptId: null,
    nextAttemptAtMs: null,
  };
}

/** ready is only permissible after the application's current policy/approval checks. */
export function prepareAction(
  action: Action,
  expectedVersion: bigint,
  approvalRequired: boolean,
): Action {
  assertVersion(action.version, expectedVersion);
  requireActionStatus(action, ['proposed']);
  return {
    ...action,
    status: approvalRequired ? 'awaiting_approval' : 'ready',
    version: action.version + 1n,
  };
}

export function approveAction(action: Action, expectedVersion: bigint): Action {
  assertVersion(action.version, expectedVersion);
  requireActionStatus(action, ['awaiting_approval']);
  return { ...action, status: 'ready', version: action.version + 1n };
}

export function cancelAction(action: Action, expectedVersion: bigint): Action {
  assertVersion(action.version, expectedVersion);
  requireActionStatus(action, ['proposed', 'awaiting_approval', 'ready']);
  return { ...action, status: 'cancelled', version: action.version + 1n };
}

/** This models admission, not a network send. The application must persist both. */
export function startActionAttempt(
  action: Action,
  input: { readonly expectedVersion: bigint; readonly attemptId: string; readonly nowMs: number },
): { readonly action: Action; readonly attempt: ActionAttempt } {
  assertVersion(action.version, input.expectedVersion);
  requireActionStatus(action, ['ready']);
  assertNonEmpty(input.attemptId, 'attemptId');
  assertTimestamp(input.nowMs, 'nowMs');
  if (action.nextAttemptAtMs !== null && input.nowMs < action.nextAttemptAtMs) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { reason: 'retry_not_due' });
  }
  if (action.lastAttemptId === input.attemptId || !Number.isSafeInteger(action.attemptCount + 1)) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'attemptId/attemptCount' });
  }
  const attemptNo = action.attemptCount + 1;
  return {
    action: {
      ...action,
      status: 'executing',
      version: action.version + 1n,
      attemptCount: attemptNo,
      lastAttemptId: input.attemptId,
      nextAttemptAtMs: null,
    },
    attempt: {
      id: input.attemptId,
      actionId: action.id,
      attemptNo,
      version: 1n,
      status: 'prepared',
      sideEffect: 'not_attempted',
    },
  };
}

export function dispatchActionAttempt(
  attempt: ActionAttempt,
  expectedVersion: bigint,
): ActionAttempt {
  assertVersion(attempt.version, expectedVersion);
  if (attempt.status !== 'prepared') {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, {
      from: attempt.status,
      to: 'in_flight',
    });
  }
  return { ...attempt, status: 'in_flight', sideEffect: 'possible', version: attempt.version + 1n };
}

/** Observation authenticity and evidence are checked outside this pure model. */
export function recordAttemptOutcome(
  attempt: ActionAttempt,
  input: {
    readonly expectedVersion: bigint;
    readonly status: 'succeeded' | 'failed' | 'unknown';
    readonly sideEffect: 'none' | 'possible' | 'confirmed';
  },
): ActionAttempt {
  assertVersion(attempt.version, input.expectedVersion);
  if (
    attempt.status !== 'prepared' &&
    attempt.status !== 'in_flight' &&
    attempt.status !== 'unknown'
  ) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, {
      from: attempt.status,
      to: input.status,
    });
  }
  if (
    (input.status === 'unknown' && input.sideEffect !== 'possible') ||
    (input.status === 'succeeded' && input.sideEffect !== 'confirmed') ||
    (input.status === 'failed' && input.sideEffect === 'possible') ||
    (attempt.status === 'unknown' && input.status === 'unknown')
  ) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'status/sideEffect' });
  }
  return {
    ...attempt,
    status: input.status,
    sideEffect: input.sideEffect,
    version: attempt.version + 1n,
  };
}

export function recordActionOutcome(
  action: Action,
  attempt: ActionAttempt,
  expectedVersion: bigint,
): Action {
  assertVersion(action.version, expectedVersion);
  requireActionStatus(action, ['executing', 'unknown']);
  assertLatestAttempt(action, attempt);
  if (
    attempt.status !== 'succeeded' &&
    attempt.status !== 'failed' &&
    attempt.status !== 'unknown'
  ) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, {
      from: attempt.status,
      to: 'action_outcome',
    });
  }
  if (action.status === 'unknown' && attempt.status === 'unknown') {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: action.status, to: 'unknown' });
  }
  return { ...action, status: attempt.status, version: action.version + 1n };
}

export function scheduleActionRetry(
  action: Action,
  attempt: ActionAttempt,
  input: {
    readonly expectedVersion: bigint;
    readonly nextAttemptAtMs: number;
    readonly maxAttempts: number;
    readonly contractAllowsRetry: boolean;
    readonly authorizationValid: boolean;
  },
): Action {
  assertVersion(action.version, input.expectedVersion);
  requireActionStatus(action, ['executing']);
  assertLatestAttempt(action, attempt);
  assertTimestamp(input.nextAttemptAtMs, 'nextAttemptAtMs');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'maxAttempts' });
  }
  if (
    attempt.status !== 'failed' ||
    attempt.sideEffect !== 'none' ||
    !input.contractAllowsRetry ||
    !input.authorizationValid
  ) {
    throw new DomainError('RETRY_NOT_SAFE', 409);
  }
  if (action.attemptCount >= input.maxAttempts) {
    throw new DomainError('RETRY_EXHAUSTED', 409);
  }
  return {
    ...action,
    status: 'ready',
    nextAttemptAtMs: input.nextAttemptAtMs,
    version: action.version + 1n,
  };
}

function requireActionStatus(action: Action, allowed: readonly ActionStatus[]): void {
  if (!allowed.includes(action.status)) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: action.status });
  }
}

function assertLatestAttempt(action: Action, attempt: ActionAttempt): void {
  if (
    attempt.actionId !== action.id ||
    attempt.id !== action.lastAttemptId ||
    attempt.attemptNo !== action.attemptCount
  ) {
    throw new DomainError('VERSION_CONFLICT', 409, { reason: 'not_current_attempt' });
  }
}
