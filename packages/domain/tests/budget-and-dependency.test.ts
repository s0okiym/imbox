import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addTaskDependency,
  assertAcyclicDependencies,
  createBudgetLedger,
  findDependencyCycle,
  markReservationUnknown,
  releaseBudgetReservation,
  reserveBudget,
  settleBudget,
} from '../src/index.js';

function ledger(limit = 100n) {
  return createBudgetLedger([
    { id: 'root', parentId: null, currency: 'USD', limit },
    { id: 'child-a', parentId: 'root', currency: 'USD', limit },
    { id: 'child-b', parentId: 'root', currency: 'USD', limit },
  ]);
}

describe('hierarchical budget ledger', () => {
  it('siblings share root capacity instead of each receiving the whole allowance', () => {
    const initial = ledger();
    const first = reserveBudget(initial, {
      reservationId: 'r1',
      leafAccountId: 'child-a',
      amount: 70n,
      currency: 'USD',
    });
    expect(() =>
      reserveBudget(first.ledger, {
        reservationId: 'r2',
        leafAccountId: 'child-b',
        amount: 40n,
        currency: 'USD',
      }),
    ).toThrowError('BUDGET_EXCEEDED');
    expect(initial.accounts.every((account) => account.reserved === 0n)).toBe(true);
    expect(first.ledger.accounts.find((account) => account.id === 'root')?.reserved).toBe(70n);
  });

  it('enforces narrower child limits even when the root has funds', () => {
    const initial = createBudgetLedger([
      { id: 'root', parentId: null, currency: 'USD', limit: 100n },
      { id: 'child', parentId: 'root', currency: 'USD', limit: 20n },
    ]);
    expect(() =>
      reserveBudget(initial, {
        reservationId: 'r',
        leafAccountId: 'child',
        amount: 21n,
        currency: 'USD',
      }),
    ).toThrowError('BUDGET_EXCEEDED');
  });

  it('retains unknown cost reservations independently of worker lifetime', () => {
    const reserved = reserveBudget(ledger(), {
      reservationId: 'r',
      leafAccountId: 'child-a',
      amount: 80n,
      currency: 'USD',
    }).ledger;
    const unknown = markReservationUnknown(reserved, 'r');
    expect(unknown.accounts).toEqual(reserved.accounts);
    expect(() =>
      releaseBudgetReservation(unknown, { reservationId: 'r', confirmedNoCharge: false }),
    ).toThrowError('CHARGE_STATUS_UNKNOWN');
    expect(() =>
      reserveBudget(unknown, {
        reservationId: 'r2',
        leafAccountId: 'child-b',
        amount: 21n,
        currency: 'USD',
      }),
    ).toThrowError('BUDGET_EXCEEDED');
    const confirmed = releaseBudgetReservation(unknown, {
      reservationId: 'r',
      confirmedNoCharge: true,
    });
    expect(confirmed.accounts.every((account) => account.reserved === 0n)).toBe(true);
  });

  it('records real over-estimate charges and blocks new work without inventing a hard cap', () => {
    const reserved = reserveBudget(ledger(), {
      reservationId: 'r',
      leafAccountId: 'child-a',
      amount: 50n,
      currency: 'USD',
    }).ledger;
    const settled = settleBudget(reserved, {
      reservationId: 'r',
      usageId: 'provider/account/charge-1',
      actualAmount: 120n,
    });
    expect(settled.accounts.find((account) => account.id === 'root')).toMatchObject({
      reserved: 0n,
      settled: 120n,
      blocked: true,
    });
    expect(() =>
      reserveBudget(settled, {
        reservationId: 'r2',
        leafAccountId: 'child-b',
        amount: 1n,
        currency: 'USD',
      }),
    ).toThrowError('BUDGET_BLOCKED');
  });

  it('same keys are idempotent but cannot acquire different business meanings', () => {
    const input = { reservationId: 'r', leafAccountId: 'child-a', amount: 20n, currency: 'USD' };
    const reserved = reserveBudget(ledger(), input);
    expect(reserveBudget(reserved.ledger, input).ledger).toBe(reserved.ledger);
    expect(() => reserveBudget(reserved.ledger, { ...input, amount: 21n })).toThrowError(
      'IDEMPOTENCY_CONFLICT',
    );
    const settled = settleBudget(reserved.ledger, {
      reservationId: 'r',
      usageId: 'usage',
      actualAmount: 10n,
    });
    expect(settleBudget(settled, { reservationId: 'r', usageId: 'usage', actualAmount: 10n })).toBe(
      settled,
    );
    expect(() =>
      settleBudget(settled, { reservationId: 'r', usageId: 'usage-new', actualAmount: 10n }),
    ).toThrowError('USAGE_CONFLICT');
    expect(() =>
      settleBudget(settled, { reservationId: 'r', usageId: 'usage', actualAmount: 11n }),
    ).toThrowError('USAGE_CONFLICT');
    const second = reserveBudget(settled, { ...input, reservationId: 'r2' }).ledger;
    expect(() =>
      settleBudget(second, { reservationId: 'r2', usageId: 'usage', actualAmount: 10n }),
    ).toThrowError('USAGE_CONFLICT');
  });

  it('preserves exact bigint costs beyond JavaScript number precision', () => {
    const amount = 9_007_199_254_740_993n;
    const reserved = reserveBudget(ledger(amount), {
      reservationId: 'r',
      leafAccountId: 'child-a',
      amount,
      currency: 'USD',
    }).ledger;
    const settled = settleBudget(reserved, {
      reservationId: 'r',
      usageId: 'u',
      actualAmount: amount - 1n,
    });
    expect(settled.accounts.find((account) => account.id === 'root')?.settled).toBe(amount - 1n);
  });

  it('reservations and unique settlements conserve the root ledger under repetition', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            estimate: fc.bigInt({ min: 1n, max: 1_000n }),
            fraction: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (operations) => {
          const totalEstimate = operations.reduce((sum, operation) => sum + operation.estimate, 0n);
          let current = ledger(totalEstimate);
          let totalActual = 0n;
          for (const [index, operation] of operations.entries()) {
            const reservationId = `r-${index}`;
            const input = {
              reservationId,
              leafAccountId: index % 2 === 0 ? 'child-a' : 'child-b',
              amount: operation.estimate,
              currency: 'USD',
            };
            current = reserveBudget(current, input).ledger;
            current = reserveBudget(current, input).ledger;
            current = markReservationUnknown(current, reservationId);
            const actualAmount = (operation.estimate * BigInt(operation.fraction)) / 100n;
            const settlement = { reservationId, usageId: `usage-${index}`, actualAmount };
            current = settleBudget(current, settlement);
            current = settleBudget(current, settlement);
            totalActual += actualAmount;
          }
          const root = current.accounts.find((account) => account.id === 'root');
          expect(root).toMatchObject({ reserved: 0n, settled: totalActual, blocked: false });
          expect(current.usageRecords).toHaveLength(operations.length);
          expect(
            current.accounts
              .filter((account) => account.parentId === 'root')
              .reduce((sum, account) => sum + account.settled, 0n),
          ).toBe(totalActual);
        },
      ),
    );
  });
});

describe('task dependency graph', () => {
  it('detects a cross-root cycle closed by previously disjoint edges', () => {
    const initial = [
      { taskId: 'A', dependsOnTaskId: 'B' },
      { taskId: 'C', dependsOnTaskId: 'D' },
    ];
    const first = addTaskDependency(initial, { taskId: 'B', dependsOnTaskId: 'C' });
    expect(() => addTaskDependency(first, { taskId: 'D', dependsOnTaskId: 'A' })).toThrowError(
      'DEPENDENCY_CYCLE',
    );
    expect(initial).toHaveLength(2);
  });

  it('handles duplicate edges, self-loops and long chains without recursion', () => {
    const edge = { taskId: 'A', dependsOnTaskId: 'B' };
    expect(addTaskDependency([edge], edge)).toHaveLength(1);
    expect(findDependencyCycle([{ taskId: 'A', dependsOnTaskId: 'A' }])).toEqual(['A', 'A']);
    const chain = Array.from({ length: 20_000 }, (_, index) => ({
      taskId: String(index),
      dependsOnTaskId: String(index + 1),
    }));
    expect(findDependencyCycle(chain)).toBeNull();
  });

  it('arbitrary ordered DAG edges remain acyclic; adding the reverse of an edge closes a cycle', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 0, max: 50 })), {
          maxLength: 100,
        }),
        (pairs) => {
          const edges = pairs
            .filter(([left, right]) => left !== right)
            .map(([left, right]) => ({
              taskId: String(Math.min(left, right)),
              dependsOnTaskId: String(Math.max(left, right)),
            }));
          assertAcyclicDependencies(edges);
          const first = edges[0];
          if (first !== undefined) {
            expect(() =>
              addTaskDependency(edges, {
                taskId: first.dependsOnTaskId,
                dependsOnTaskId: first.taskId,
              }),
            ).toThrowError('DEPENDENCY_CYCLE');
          }
        },
      ),
    );
  });
});
