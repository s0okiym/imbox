import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  acquireLease,
  assertLeaseValid,
  createRequest,
  releaseLease,
  renewLease,
  reviseRequestProposal,
  transitionRequest,
} from '../src/index.js';

describe('execution leases', () => {
  it('rejects an expired worker before another worker has claimed its lease', () => {
    const lease = acquireLease(null, { runId: 'run', holderId: 'old', nowMs: 100, ttlMs: 60 });
    const claim = { runId: 'run', holderId: 'old', generation: 1n, nowMs: 160 };
    expect(() => assertLeaseValid(lease, claim)).toThrowError('LEASE_EXPIRED');
    expect(() => renewLease(lease, { ...claim, ttlMs: 60 })).toThrowError('LEASE_EXPIRED');
    const replacement = acquireLease(lease, {
      runId: 'run',
      holderId: 'new',
      nowMs: 160,
      ttlMs: 60,
    });
    expect(replacement.generation).toBe(2n);
    expect(() => assertLeaseValid(replacement, { ...claim, nowMs: 161 })).toThrowError(
      'LEASE_CONFLICT',
    );
  });

  it('requires matching run, holder and generation independently', () => {
    const lease = acquireLease(null, { runId: 'run', holderId: 'worker', nowMs: 0, ttlMs: 60 });
    const claim = { runId: 'run', holderId: 'worker', generation: 1n, nowMs: 10 };
    for (const wrong of [
      { ...claim, runId: 'other' },
      { ...claim, holderId: 'other' },
      { ...claim, generation: 2n },
    ]) {
      expect(() => assertLeaseValid(lease, wrong)).toThrowError('LEASE_CONFLICT');
    }
    expect(() =>
      acquireLease(lease, { runId: 'run', holderId: 'other', nowMs: 10, ttlMs: 60 }),
    ).toThrowError('LEASE_NOT_EXPIRED');
    const released = releaseLease(lease, claim);
    expect(() => assertLeaseValid(released, claim)).toThrowError('LEASE_EXPIRED');
  });

  it('expiry is a strict boundary for every generated lease', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (nowMs, ttlMs) => {
          const lease = acquireLease(null, { runId: 'r', holderId: 'w', nowMs, ttlMs });
          assertLeaseValid(lease, {
            runId: 'r',
            holderId: 'w',
            generation: 1n,
            nowMs: nowMs + ttlMs - 1,
          });
          expect(() =>
            assertLeaseValid(lease, {
              runId: 'r',
              holderId: 'w',
              generation: 1n,
              nowMs: nowMs + ttlMs,
            }),
          ).toThrowError('LEASE_EXPIRED');
        },
      ),
    );
  });
});

function request() {
  return createRequest({
    id: 'request',
    taskId: 'task',
    kind: 'handoff',
    proposerPrincipalId: 'owner',
    recipientPrincipalId: 'agent',
    nowMs: 0,
    expiresAtMs: 100,
  });
}

describe('collaboration requests', () => {
  it('accepted proposal versions are fixed and accepted facts cannot be withdrawn', () => {
    const original = request();
    const revised = reviseRequestProposal(original, {
      expectedVersion: 1n,
      nowMs: 10,
      expiresAtMs: 120,
    });
    expect(() =>
      transitionRequest(revised, 'accepted', {
        expectedVersion: 2n,
        expectedProposalVersion: 1n,
        nowMs: 20,
      }),
    ).toThrowError('PROPOSAL_VERSION_CONFLICT');
    const accepted = transitionRequest(revised, 'accepted', {
      expectedVersion: 2n,
      expectedProposalVersion: 2n,
      nowMs: 20,
    });
    expect(accepted.acceptedProposalVersion).toBe(2n);
    expect(() =>
      transitionRequest(accepted, 'withdrawn', {
        expectedVersion: 3n,
        expectedProposalVersion: 2n,
        nowMs: 21,
      }),
    ).toThrowError('INVALID_STATE_TRANSITION');
    expect(() =>
      reviseRequestProposal(accepted, { expectedVersion: 3n, nowMs: 30, expiresAtMs: 130 }),
    ).toThrowError('INVALID_STATE_TRANSITION');
  });

  it('cannot accept an expired request even before the expiry worker runs', () => {
    const original = request();
    expect(() =>
      transitionRequest(original, 'accepted', {
        expectedVersion: 1n,
        expectedProposalVersion: 1n,
        nowMs: 100,
      }),
    ).toThrowError('REQUEST_EXPIRED');
    expect(
      transitionRequest(original, 'expired', {
        expectedVersion: 1n,
        expectedProposalVersion: 1n,
        nowMs: 100,
      }).status,
    ).toBe('expired');
  });

  it('clarification does not itself become acceptance', () => {
    const original = request();
    const clarification = transitionRequest(original, 'needs_clarification', {
      expectedVersion: 1n,
      expectedProposalVersion: 1n,
      nowMs: 1,
    });
    expect(() =>
      transitionRequest(clarification, 'accepted', {
        expectedVersion: 2n,
        expectedProposalVersion: 1n,
        nowMs: 2,
      }),
    ).toThrowError('INVALID_STATE_TRANSITION');
    const pending = transitionRequest(clarification, 'pending', {
      expectedVersion: 2n,
      expectedProposalVersion: 1n,
      nowMs: 2,
    });
    expect(pending.acceptedProposalVersion).toBeNull();
  });
});
