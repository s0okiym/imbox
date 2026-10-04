import { assertNonEmpty, assertTimestamp, assertVersion, DomainError } from './error.js';

export const REQUEST_STATUSES = [
  'pending',
  'needs_clarification',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
  'superseded',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type RequestKind = 'consult' | 'review' | 'delegate' | 'handoff';

export interface CollaborationRequest {
  readonly id: string;
  readonly taskId: string;
  readonly kind: RequestKind;
  readonly proposerPrincipalId: string;
  readonly recipientPrincipalId: string;
  readonly status: RequestStatus;
  readonly version: bigint;
  readonly proposalVersion: bigint;
  readonly acceptedProposalVersion: bigint | null;
  readonly expiresAtMs: number;
}

export function isTerminalRequestStatus(status: RequestStatus): boolean {
  return status !== 'pending' && status !== 'needs_clarification';
}

export function createRequest(input: {
  readonly id: string;
  readonly taskId: string;
  readonly kind: RequestKind;
  readonly proposerPrincipalId: string;
  readonly recipientPrincipalId: string;
  readonly expiresAtMs: number;
  readonly nowMs: number;
}): CollaborationRequest {
  assertNonEmpty(input.id, 'id');
  assertNonEmpty(input.taskId, 'taskId');
  assertNonEmpty(input.proposerPrincipalId, 'proposerPrincipalId');
  assertNonEmpty(input.recipientPrincipalId, 'recipientPrincipalId');
  assertTimestamp(input.expiresAtMs, 'expiresAtMs');
  assertTimestamp(input.nowMs, 'nowMs');
  if (input.expiresAtMs <= input.nowMs) {
    throw new DomainError('REQUEST_EXPIRED', 410);
  }
  return {
    id: input.id,
    taskId: input.taskId,
    kind: input.kind,
    proposerPrincipalId: input.proposerPrincipalId,
    recipientPrincipalId: input.recipientPrincipalId,
    expiresAtMs: input.expiresAtMs,
    status: 'pending',
    version: 1n,
    proposalVersion: 1n,
    acceptedProposalVersion: null,
  };
}

/** The application separately verifies the authenticated decision maker. */
export function transitionRequest(
  request: CollaborationRequest,
  target: RequestStatus,
  input: {
    readonly expectedVersion: bigint;
    readonly expectedProposalVersion: bigint;
    readonly nowMs: number;
  },
): CollaborationRequest {
  assertVersion(request.version, input.expectedVersion);
  assertTimestamp(input.nowMs, 'nowMs');
  if (request.proposalVersion !== input.expectedProposalVersion) {
    throw new DomainError('PROPOSAL_VERSION_CONFLICT', 409);
  }
  if (isTerminalRequestStatus(request.status)) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: request.status, to: target });
  }
  if (target === 'expired') {
    if (input.nowMs < request.expiresAtMs) {
      throw new DomainError('INVALID_STATE_TRANSITION', 409, { to: target });
    }
  } else if (input.nowMs >= request.expiresAtMs) {
    throw new DomainError('REQUEST_EXPIRED', 410);
  }
  const allowed =
    target === 'rejected' ||
    target === 'withdrawn' ||
    target === 'expired' ||
    target === 'superseded' ||
    (request.status === 'pending' && (target === 'accepted' || target === 'needs_clarification')) ||
    (request.status === 'needs_clarification' && target === 'pending');
  if (!allowed) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: request.status, to: target });
  }
  return {
    ...request,
    status: target,
    version: request.version + 1n,
    acceptedProposalVersion: target === 'accepted' ? request.proposalVersion : null,
  };
}

export function reviseRequestProposal(
  request: CollaborationRequest,
  input: {
    readonly expectedVersion: bigint;
    readonly nowMs: number;
    readonly expiresAtMs: number;
  },
): CollaborationRequest {
  assertVersion(request.version, input.expectedVersion);
  assertTimestamp(input.nowMs, 'nowMs');
  assertTimestamp(input.expiresAtMs, 'expiresAtMs');
  if (isTerminalRequestStatus(request.status)) {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, { from: request.status, to: 'revise' });
  }
  if (input.nowMs >= request.expiresAtMs || input.expiresAtMs <= input.nowMs) {
    throw new DomainError('REQUEST_EXPIRED', 410);
  }
  return {
    ...request,
    status: 'pending',
    version: request.version + 1n,
    proposalVersion: request.proposalVersion + 1n,
    expiresAtMs: input.expiresAtMs,
  };
}
