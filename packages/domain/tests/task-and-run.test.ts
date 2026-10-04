import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  acceptTaskHandoff,
  advanceTask,
  assertRunSupportsActivity,
  assertTaskFencesCurrent,
  attachRunToTask,
  blockTask,
  createRun,
  createTask,
  DomainError,
  reopenTask,
  resumeTask,
  RUN_STATUSES,
  terminateTask,
  transitionRun,
} from '../src/index.js';

function task() {
  return createTask({
    id: 'task',
    ownerPrincipalId: 'alice',
    accountablePrincipalId: 'sponsor',
    acceptanceBaseline: 'acceptance-v1',
  });
}

describe('task responsibility and fencing', () => {
  it('handoff changes exactly one owner and preserves the accountable principal', () => {
    const initial = Object.freeze(task());
    const changed = acceptTaskHandoff(initial, {
      expectedVersion: 1n,
      expectedOwnerPrincipalId: 'alice',
      newOwnerPrincipalId: 'agent',
    });
    expect(changed).toMatchObject({
      ownerPrincipalId: 'agent',
      accountablePrincipalId: 'sponsor',
      version: 2n,
      executionEpoch: 2n,
    });
    expect(initial.ownerPrincipalId).toBe('alice');
    expect(() =>
      acceptTaskHandoff(changed, {
        expectedVersion: 1n,
        expectedOwnerPrincipalId: 'alice',
        newOwnerPrincipalId: 'bob',
      }),
    ).toThrowError('VERSION_CONFLICT');
    expect(() =>
      acceptTaskHandoff(changed, {
        expectedVersion: 2n,
        expectedOwnerPrincipalId: 'alice',
        newOwnerPrincipalId: 'bob',
      }),
    ).toThrowError('OWNER_CONFLICT');
  });

  it('completion requires independent acceptance, closed required work and evidence', () => {
    const active = advanceTask(task(), 'active', 1n);
    const review = advanceTask(active, 'in_review', 2n);
    const completion = {
      acceptanceConfirmed: true,
      requiredChildrenClosed: true,
      requiredActionsClosed: true,
      evidenceRefs: ['submission-1'],
    };
    for (const field of [
      'acceptanceConfirmed',
      'requiredChildrenClosed',
      'requiredActionsClosed',
    ] as const) {
      expect(() =>
        terminateTask(review, {
          expectedVersion: 3n,
          status: 'completed',
          reason: 'reviewed',
          completion: { ...completion, [field]: false },
        }),
      ).toThrowError('ACCEPTANCE_REQUIRED');
    }
    expect(() =>
      terminateTask(active, {
        expectedVersion: 2n,
        status: 'completed',
        reason: 'done',
        completion,
      }),
    ).toThrowError('ACCEPTANCE_REQUIRED');
    const done = terminateTask(review, {
      expectedVersion: 3n,
      status: 'completed',
      reason: 'accepted',
      completion,
    });
    expect(done.status).toBe('completed');
    expect(done.executionEpoch).toBe(2n);
    expect(() => blockTask(done, done.version, 'owner disabled')).toThrowError(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('block/resume restores the recorded state and never changes ownership', () => {
    const active = advanceTask(task(), 'active', 1n);
    const blocked = blockTask(active, 2n, 'owner unavailable');
    expect(resumeTask(blocked, 3n)).toMatchObject({
      status: 'active',
      ownerPrincipalId: 'alice',
      blockedFrom: null,
      executionEpoch: 1n,
    });
  });

  it('ancestor cancellation blocks a child before child state propagation', () => {
    const parent = task();
    const child = createTask({
      id: 'child',
      ownerPrincipalId: 'agent',
      accountablePrincipalId: 'sponsor',
      acceptanceBaseline: 'v1',
    });
    const snapshots = [
      { taskId: parent.id, executionEpoch: 1n },
      { taskId: child.id, executionEpoch: 1n },
    ];
    assertTaskFencesCurrent(snapshots, [parent, child]);
    const cancelled = terminateTask(parent, {
      expectedVersion: 1n,
      status: 'cancelled',
      reason: 'user cancelled',
    });
    expect(() => assertTaskFencesCurrent(snapshots, [cancelled, child])).toThrowError(
      'EXECUTION_FENCE_CONFLICT',
    );
    expect(() => assertTaskFencesCurrent(snapshots, [child])).toThrowError(
      'EXECUTION_FENCE_CONFLICT',
    );
  });

  it('every cancellation/reopen cycle permanently fences all previous generations', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (cycles) => {
        let current = task();
        const oldEpochs: bigint[] = [];
        for (let index = 0; index < cycles; index += 1) {
          oldEpochs.push(current.executionEpoch);
          const closed = terminateTask(current, {
            expectedVersion: current.version,
            status: 'cancelled',
            reason: 'stop',
          });
          current = reopenTask(closed, {
            expectedVersion: closed.version,
            reason: 'new decision',
            acceptanceBaseline: `baseline-${index}`,
          });
        }
        expect(current.executionEpoch).toBe(1n + 2n * BigInt(cycles));
        for (const executionEpoch of oldEpochs) {
          expect(() =>
            assertTaskFencesCurrent([{ taskId: current.id, executionEpoch }], [current]),
          ).toThrowError('EXECUTION_FENCE_CONFLICT');
        }
      }),
    );
  });
});

describe('run lifecycle', () => {
  it('a lightweight reply needs no task, while persistent actions do', () => {
    const run = createRun({
      id: 'run',
      originScope: { kind: 'conversation', conversationId: 'chat' },
    });
    assertRunSupportsActivity(run, 'conversation_reply');
    assertRunSupportsActivity(run, 'private_draft');
    for (const activity of [
      'external_action',
      'delegation',
      'scheduled_work',
      'persistent_work',
      'acceptance',
    ] as const) {
      expect(() => assertRunSupportsActivity(run, activity)).toThrowError('TASK_REQUIRED');
    }
    const promoted = attachRunToTask(run, 'task', 1n);
    expect(promoted.originScope).toEqual(run.originScope);
    assertRunSupportsActivity(promoted, 'external_action');
    expect(run.taskId).toBeNull();
  });

  it('a finished run cannot be resumed, even when its task is reopened', () => {
    const queued = createRun({ id: 'run', originScope: { kind: 'task', taskId: 'task' } });
    const running = transitionRun(queued, 'running', { expectedVersion: 1n });
    const done = transitionRun(running, 'completed', { expectedVersion: 2n });
    for (const target of RUN_STATUSES) {
      expect(() => transitionRun(done, target, { expectedVersion: 3n })).toThrowError(
        'INVALID_STATE_TRANSITION',
      );
    }
  });

  it('waiting, paused and cancelling runs can expire without losing cancellation intent', () => {
    const queued = createRun({ id: 'run', originScope: { kind: 'task', taskId: 'task' } });
    const running = transitionRun(queued, 'running', { expectedVersion: 1n });
    for (const status of [
      'waiting_input',
      'waiting_approval',
      'waiting_dependency',
      'paused',
      'cancelling',
    ] as const) {
      const intermediate = transitionRun(running, status, {
        expectedVersion: 2n,
        safeCheckpointConfirmed: true,
      });
      const expired = transitionRun(intermediate, 'expired', { expectedVersion: 3n });
      expect(expired.status).toBe('expired');
      expect(expired.cancellationRequested).toBe(status === 'cancelling');
    }
  });

  it('cancelled requires platform execution revocation and registration of unresolved actions', () => {
    const run = createRun({ id: 'run', originScope: { kind: 'task', taskId: 'task' } });
    const cancelling = transitionRun(run, 'cancelling', { expectedVersion: 1n });
    expect(() =>
      transitionRun(cancelling, 'cancelled', {
        expectedVersion: 2n,
        executionAuthorityTerminated: true,
      }),
    ).toThrowError('CANCELLATION_NOT_CONFIRMED');
    expect(
      transitionRun(cancelling, 'cancelled', {
        expectedVersion: 2n,
        executionAuthorityTerminated: true,
        unresolvedActionsRegistered: true,
      }).status,
    ).toBe('cancelled');
  });

  it('pause is only confirmed at a safe checkpoint', () => {
    const run = transitionRun(
      createRun({ id: 'run', originScope: { kind: 'task', taskId: 'task' } }),
      'running',
      { expectedVersion: 1n },
    );
    expect(() => transitionRun(run, 'paused', { expectedVersion: 2n })).toThrowError(
      'CHECKPOINT_REQUIRED',
    );
  });

  it('errors retain machine-readable code/status and safe explicit details', () => {
    const error = new DomainError('VERSION_CONFLICT', 409, { expected: '1' });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.status).toBe(409);
    expect(error.details).toEqual({ expected: '1' });
  });
});
