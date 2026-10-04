import { describe, expect, it } from 'vitest';
import {
  approveAction,
  cancelAction,
  createAction,
  dispatchActionAttempt,
  prepareAction,
  recordActionOutcome,
  recordAttemptOutcome,
  scheduleActionRetry,
  startActionAttempt,
} from '../src/index.js';

function action() {
  return createAction({
    id: 'action',
    taskId: 'task',
    businessKey: 'send-announcement-1',
    parameterFingerprint: 'sha256:immutable-body',
  });
}

function admitted() {
  const ready = prepareAction(action(), 1n, false);
  return startActionAttempt(ready, { expectedVersion: 2n, attemptId: 'attempt-1', nowMs: 0 });
}

describe('action and attempt separation', () => {
  it('an action awaiting approval cannot be dispatched', () => {
    const waiting = prepareAction(action(), 1n, true);
    expect(() =>
      startActionAttempt(waiting, { expectedVersion: 2n, attemptId: 'attempt-1', nowMs: 0 }),
    ).toThrowError('INVALID_STATE_TRANSITION');
    const ready = approveAction(waiting, 2n);
    expect(
      startActionAttempt(ready, { expectedVersion: 3n, attemptId: 'attempt-1', nowMs: 0 }).action
        .status,
    ).toBe('executing');
  });

  it('unknown outcomes never enter the ordinary retry path and cannot be cancelled away', () => {
    const initial = admitted();
    const sent = dispatchActionAttempt(initial.attempt, 1n);
    const unknownAttempt = recordAttemptOutcome(sent, {
      expectedVersion: 2n,
      status: 'unknown',
      sideEffect: 'possible',
    });
    const unknownAction = recordActionOutcome(initial.action, unknownAttempt, 3n);
    expect(unknownAction.status).toBe('unknown');
    expect(() =>
      startActionAttempt(unknownAction, {
        expectedVersion: 4n,
        attemptId: 'attempt-2',
        nowMs: 100,
      }),
    ).toThrowError('INVALID_STATE_TRANSITION');
    expect(() => cancelAction(unknownAction, 4n)).toThrowError('INVALID_STATE_TRANSITION');
    expect(() =>
      scheduleActionRetry(initial.action, unknownAttempt, {
        expectedVersion: 3n,
        nextAttemptAtMs: 100,
        maxAttempts: 3,
        contractAllowsRetry: true,
        authorizationValid: true,
      }),
    ).toThrowError('RETRY_NOT_SAFE');
    const observed = recordAttemptOutcome(unknownAttempt, {
      expectedVersion: 3n,
      status: 'succeeded',
      sideEffect: 'confirmed',
    });
    expect(recordActionOutcome(unknownAction, observed, 4n).status).toBe('succeeded');
  });

  it('a safe retry preserves business identity, respects delay, and creates a fresh attempt', () => {
    const initial = admitted();
    const failed = recordAttemptOutcome(initial.attempt, {
      expectedVersion: 1n,
      status: 'failed',
      sideEffect: 'none',
    });
    const ready = scheduleActionRetry(initial.action, failed, {
      expectedVersion: 3n,
      nextAttemptAtMs: 100,
      maxAttempts: 2,
      contractAllowsRetry: true,
      authorizationValid: true,
    });
    expect(ready).toMatchObject({
      id: initial.action.id,
      businessKey: initial.action.businessKey,
      parameterFingerprint: initial.action.parameterFingerprint,
      status: 'ready',
      attemptCount: 1,
    });
    expect(() =>
      startActionAttempt(ready, { expectedVersion: 4n, attemptId: 'attempt-2', nowMs: 99 }),
    ).toThrowError('INVALID_STATE_TRANSITION');
    const second = startActionAttempt(ready, {
      expectedVersion: 4n,
      attemptId: 'attempt-2',
      nowMs: 100,
    });
    expect(second.attempt.attemptNo).toBe(2);
    expect(() => recordActionOutcome(second.action, failed, 5n)).toThrowError('VERSION_CONFLICT');
    const secondFailure = recordAttemptOutcome(second.attempt, {
      expectedVersion: 1n,
      status: 'failed',
      sideEffect: 'none',
    });
    expect(() =>
      scheduleActionRetry(second.action, secondFailure, {
        expectedVersion: 5n,
        nextAttemptAtMs: 200,
        maxAttempts: 2,
        contractAllowsRetry: true,
        authorizationValid: true,
      }),
    ).toThrowError('RETRY_EXHAUSTED');
  });

  it('partial effects and revoked authority prohibit ordinary retries', () => {
    const initial = admitted();
    const partial = recordAttemptOutcome(initial.attempt, {
      expectedVersion: 1n,
      status: 'failed',
      sideEffect: 'confirmed',
    });
    const noEffect = recordAttemptOutcome(initial.attempt, {
      expectedVersion: 1n,
      status: 'failed',
      sideEffect: 'none',
    });
    const retry = {
      expectedVersion: 3n,
      nextAttemptAtMs: 100,
      maxAttempts: 3,
      contractAllowsRetry: true,
      authorizationValid: true,
    };
    expect(() => scheduleActionRetry(initial.action, partial, retry)).toThrowError(
      'RETRY_NOT_SAFE',
    );
    expect(() =>
      scheduleActionRetry(initial.action, noEffect, { ...retry, authorizationValid: false }),
    ).toThrowError('RETRY_NOT_SAFE');
    const terminal = recordActionOutcome(initial.action, noEffect, 3n);
    expect(() =>
      scheduleActionRetry(terminal, noEffect, { ...retry, expectedVersion: 4n }),
    ).toThrowError('INVALID_STATE_TRANSITION');
  });

  it('a receipt for another action or old attempt cannot settle the current action', () => {
    const initial = admitted();
    const outcome = recordAttemptOutcome(initial.attempt, {
      expectedVersion: 1n,
      status: 'succeeded',
      sideEffect: 'confirmed',
    });
    expect(() =>
      recordActionOutcome(initial.action, { ...outcome, actionId: 'other' }, 3n),
    ).toThrowError('VERSION_CONFLICT');
    expect(() =>
      recordActionOutcome(initial.action, { ...outcome, attemptNo: 2 }, 3n),
    ).toThrowError('VERSION_CONFLICT');
  });
});
