import { assertNonEmpty, assertNonNegative, DomainError } from './error.js';

export interface BudgetAccountSpec {
  readonly id: string;
  readonly parentId: string | null;
  readonly currency: string;
  readonly limit: bigint;
}

export interface BudgetAccount extends BudgetAccountSpec {
  /** Aggregates this account and its descendants; do not sum parents and children. */
  readonly reserved: bigint;
  readonly settled: bigint;
  readonly revision: bigint;
  readonly blocked: boolean;
}

export type ReservationStatus = 'held' | 'unknown' | 'settled' | 'released';

export interface BudgetReservation {
  readonly id: string;
  readonly leafAccountId: string;
  readonly accountIds: readonly string[];
  readonly currency: string;
  readonly amount: bigint;
  readonly status: ReservationStatus;
  readonly usageId: string | null;
  readonly actualAmount: bigint | null;
}

export interface UsageRecord {
  /** The application namespaces this by provider/account/external usage identity. */
  readonly id: string;
  readonly reservationId: string;
  readonly amount: bigint;
  readonly currency: string;
}

export interface BudgetLedger {
  readonly accounts: readonly BudgetAccount[];
  readonly reservations: readonly BudgetReservation[];
  readonly usageRecords: readonly UsageRecord[];
}

export function createBudgetLedger(specs: readonly BudgetAccountSpec[]): BudgetLedger {
  const ids = new Set<string>();
  for (const spec of specs) {
    assertNonEmpty(spec.id, 'account.id');
    assertNonEmpty(spec.currency, 'account.currency');
    assertNonNegative(spec.limit, 'account.limit');
    if (ids.has(spec.id))
      throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'duplicate_account' });
    ids.add(spec.id);
  }
  const accounts: readonly BudgetAccount[] = specs.map((spec) => ({
    ...spec,
    reserved: 0n,
    settled: 0n,
    revision: 1n,
    blocked: false,
  }));
  for (const account of accounts) accountChain(accounts, account.id);
  return { accounts, reservations: [], usageRecords: [] };
}

/** Pure atomic proposal: persist all changed ancestor counters and the reservation together. */
export function reserveBudget(
  ledger: BudgetLedger,
  input: {
    readonly reservationId: string;
    readonly leafAccountId: string;
    readonly amount: bigint;
    readonly currency: string;
  },
): { readonly ledger: BudgetLedger; readonly reservation: BudgetReservation } {
  assertNonEmpty(input.reservationId, 'reservationId');
  assertNonNegative(input.amount, 'amount');
  const existing = ledger.reservations.find(
    (reservation) => reservation.id === input.reservationId,
  );
  if (existing !== undefined) {
    if (
      existing.leafAccountId !== input.leafAccountId ||
      existing.amount !== input.amount ||
      existing.currency !== input.currency
    ) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
    }
    return { ledger, reservation: existing };
  }
  const chain = accountChain(ledger.accounts, input.leafAccountId);
  for (const account of chain) {
    if (account.currency !== input.currency)
      throw new DomainError('INVALID_ARGUMENT', 400, { field: 'currency' });
    if (account.blocked) throw new DomainError('BUDGET_BLOCKED', 409, { accountId: account.id });
    if (account.reserved + account.settled + input.amount > account.limit) {
      throw new DomainError('BUDGET_EXCEEDED', 409, { accountId: account.id });
    }
  }
  const accountIds = chain.map((account) => account.id);
  const affected = new Set(accountIds);
  const reservation: BudgetReservation = {
    id: input.reservationId,
    leafAccountId: input.leafAccountId,
    accountIds,
    currency: input.currency,
    amount: input.amount,
    status: 'held',
    usageId: null,
    actualAmount: null,
  };
  return {
    ledger: {
      ...ledger,
      accounts: ledger.accounts.map((account) =>
        affected.has(account.id)
          ? {
              ...account,
              reserved: account.reserved + input.amount,
              revision: account.revision + 1n,
            }
          : account,
      ),
      reservations: [...ledger.reservations, reservation],
    },
    reservation,
  };
}

export function markReservationUnknown(ledger: BudgetLedger, reservationId: string): BudgetLedger {
  const reservation = findReservation(ledger, reservationId);
  if (reservation.status === 'unknown') return ledger;
  if (reservation.status !== 'held') {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, {
      from: reservation.status,
      to: 'unknown',
    });
  }
  return replaceReservation(ledger, { ...reservation, status: 'unknown' });
}

/** Actual incurred cost is recorded even above the estimate/limit; new work is then blocked. */
export function settleBudget(
  ledger: BudgetLedger,
  input: {
    readonly reservationId: string;
    readonly usageId: string;
    readonly actualAmount: bigint;
  },
): BudgetLedger {
  assertNonEmpty(input.usageId, 'usageId');
  assertNonNegative(input.actualAmount, 'actualAmount');
  const reservation = findReservation(ledger, input.reservationId);
  const existingUsage = ledger.usageRecords.find((usage) => usage.id === input.usageId);
  if (existingUsage !== undefined) {
    if (
      existingUsage.reservationId !== input.reservationId ||
      existingUsage.amount !== input.actualAmount ||
      reservation.status !== 'settled' ||
      reservation.usageId !== input.usageId ||
      reservation.actualAmount !== input.actualAmount
    ) {
      throw new DomainError('USAGE_CONFLICT', 409);
    }
    return ledger;
  }
  if (reservation.status !== 'held' && reservation.status !== 'unknown') {
    throw new DomainError('USAGE_CONFLICT', 409, { status: reservation.status });
  }
  const affected = new Set(reservation.accountIds);
  const accounts = ledger.accounts.map((account) => {
    if (!affected.has(account.id)) return account;
    if (account.reserved < reservation.amount) {
      throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'inconsistent_reserved_balance' });
    }
    const reserved = account.reserved - reservation.amount;
    const settled = account.settled + input.actualAmount;
    return {
      ...account,
      reserved,
      settled,
      blocked: account.blocked || reserved + settled > account.limit,
      revision: account.revision + 1n,
    };
  });
  const settledReservation: BudgetReservation = {
    ...reservation,
    status: 'settled',
    usageId: input.usageId,
    actualAmount: input.actualAmount,
  };
  return {
    accounts,
    reservations: ledger.reservations.map((entry) =>
      entry.id === reservation.id ? settledReservation : entry,
    ),
    usageRecords: [
      ...ledger.usageRecords,
      {
        id: input.usageId,
        reservationId: reservation.id,
        amount: input.actualAmount,
        currency: reservation.currency,
      },
    ],
  };
}

export function releaseBudgetReservation(
  ledger: BudgetLedger,
  input: { readonly reservationId: string; readonly confirmedNoCharge: boolean },
): BudgetLedger {
  const reservation = findReservation(ledger, input.reservationId);
  if (reservation.status === 'released') return ledger;
  if (reservation.status !== 'held' && reservation.status !== 'unknown') {
    throw new DomainError('INVALID_STATE_TRANSITION', 409, {
      from: reservation.status,
      to: 'released',
    });
  }
  if (!input.confirmedNoCharge) throw new DomainError('CHARGE_STATUS_UNKNOWN', 409);
  const affected = new Set(reservation.accountIds);
  const accounts = ledger.accounts.map((account) => {
    if (!affected.has(account.id)) return account;
    if (account.reserved < reservation.amount) {
      throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'inconsistent_reserved_balance' });
    }
    return {
      ...account,
      reserved: account.reserved - reservation.amount,
      revision: account.revision + 1n,
    };
  });
  return {
    ...ledger,
    accounts,
    reservations: ledger.reservations.map((entry) =>
      entry.id === reservation.id ? { ...entry, status: 'released' } : entry,
    ),
  };
}

function findReservation(ledger: BudgetLedger, reservationId: string): BudgetReservation {
  const reservation = ledger.reservations.find((entry) => entry.id === reservationId);
  if (reservation === undefined) throw new DomainError('RESERVATION_NOT_FOUND', 404);
  return reservation;
}

function replaceReservation(ledger: BudgetLedger, reservation: BudgetReservation): BudgetLedger {
  return {
    ...ledger,
    reservations: ledger.reservations.map((entry) =>
      entry.id === reservation.id ? reservation : entry,
    ),
  };
}

function accountChain(
  accounts: readonly BudgetAccount[],
  leafId: string,
): readonly BudgetAccount[] {
  const indexed = new Map(accounts.map((account) => [account.id, account]));
  if (indexed.size !== accounts.length)
    throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'duplicate_account' });
  const chain: BudgetAccount[] = [];
  const visited = new Set<string>();
  let current: string | null = leafId;
  while (current !== null) {
    if (visited.has(current))
      throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'budget_parent_cycle' });
    visited.add(current);
    const account = indexed.get(current);
    if (account === undefined)
      throw new DomainError('INVALID_ARGUMENT', 400, {
        reason: 'missing_budget_account',
        accountId: current,
      });
    if (chain[0] !== undefined && chain[0].currency !== account.currency) {
      throw new DomainError('INVALID_ARGUMENT', 400, { reason: 'mixed_budget_currency' });
    }
    assertNonNegative(account.limit, 'account.limit');
    assertNonNegative(account.reserved, 'account.reserved');
    assertNonNegative(account.settled, 'account.settled');
    chain.push(account);
    current = account.parentId;
  }
  return chain.reverse();
}
