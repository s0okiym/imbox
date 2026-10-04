export type DomainErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE_TRANSITION'
  | 'VERSION_CONFLICT'
  | 'OWNER_CONFLICT'
  | 'ACCEPTANCE_REQUIRED'
  | 'TASK_REQUIRED'
  | 'TASK_TERMINATED'
  | 'EXECUTION_FENCE_CONFLICT'
  | 'REQUEST_EXPIRED'
  | 'PROPOSAL_VERSION_CONFLICT'
  | 'LEASE_CONFLICT'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_EXPIRED'
  | 'CANCELLATION_NOT_CONFIRMED'
  | 'CHECKPOINT_REQUIRED'
  | 'RETRY_NOT_SAFE'
  | 'RETRY_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'BUDGET_BLOCKED'
  | 'RESERVATION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'USAGE_CONFLICT'
  | 'CHARGE_STATUS_UNKNOWN'
  | 'DEPENDENCY_CYCLE';

/** Application adapters may map status to HTTP; details must still be redacted. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: DomainErrorCode, status: number, details?: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field });
  }
}

export function assertVersion(actual: bigint, expected: bigint): void {
  if (actual !== expected) {
    throw new DomainError('VERSION_CONFLICT', 409, {
      expected: expected.toString(),
      actual: actual.toString(),
    });
  }
}

export function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field });
  }
}

export function assertNonNegative(value: bigint, field: string): void {
  if (value < 0n) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field });
  }
}
