import { assertNonEmpty, assertTimestamp, DomainError } from './error.js';

export interface ExecutionLease {
  readonly runId: string;
  readonly holderId: string;
  readonly generation: bigint;
  readonly expiresAtMs: number;
}

export interface LeaseClaim {
  readonly runId: string;
  readonly holderId: string;
  readonly generation: bigint;
  /** The application must supply database clock time after acquiring its locks. */
  readonly nowMs: number;
}

export function acquireLease(
  previous: ExecutionLease | null,
  input: {
    readonly runId: string;
    readonly holderId: string;
    readonly nowMs: number;
    readonly ttlMs: number;
  },
): ExecutionLease {
  assertNonEmpty(input.runId, 'runId');
  assertNonEmpty(input.holderId, 'holderId');
  const expiresAtMs = computeExpiration(input.nowMs, input.ttlMs);
  if (previous !== null) {
    if (previous.runId !== input.runId || previous.generation < 1n) {
      throw new DomainError('LEASE_CONFLICT', 409);
    }
    if (previous.expiresAtMs > input.nowMs) {
      throw new DomainError('LEASE_NOT_EXPIRED', 409);
    }
  }
  return {
    runId: input.runId,
    holderId: input.holderId,
    generation: previous === null ? 1n : previous.generation + 1n,
    expiresAtMs,
  };
}

export function assertLeaseValid(lease: ExecutionLease, claim: LeaseClaim): void {
  assertTimestamp(claim.nowMs, 'nowMs');
  if (
    lease.runId !== claim.runId ||
    lease.holderId !== claim.holderId ||
    lease.generation !== claim.generation ||
    lease.generation < 1n
  ) {
    throw new DomainError('LEASE_CONFLICT', 409);
  }
  if (lease.expiresAtMs <= claim.nowMs) {
    throw new DomainError('LEASE_EXPIRED', 409);
  }
}

export function renewLease(
  lease: ExecutionLease,
  input: LeaseClaim & { readonly ttlMs: number },
): ExecutionLease {
  assertLeaseValid(lease, input);
  return { ...lease, expiresAtMs: computeExpiration(input.nowMs, input.ttlMs) };
}

export function releaseLease(lease: ExecutionLease, input: LeaseClaim): ExecutionLease {
  assertLeaseValid(lease, input);
  return { ...lease, expiresAtMs: input.nowMs };
}

function computeExpiration(nowMs: number, ttlMs: number): number {
  assertTimestamp(nowMs, 'nowMs');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new DomainError('INVALID_ARGUMENT', 400, { field: 'ttlMs' });
  }
  const expiresAtMs = nowMs + ttlMs;
  assertTimestamp(expiresAtMs, 'expiresAtMs');
  return expiresAtMs;
}
