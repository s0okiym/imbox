import { sql, type TenantTransaction as Tx } from '@imbox/db';
import {
  reserveBudget,
  markReservationUnknown,
  releaseBudgetReservation,
  settleBudget,
  type BudgetLedger,
  type BudgetReservation,
} from '@imbox/domain';
import { ApplicationError } from '@imbox/application';
import { randomUUID } from 'node:crypto';
export interface BudgetTask {
  id: string;
  parent_task_id: string | null;
}
interface ReservationRow {
  id: string;
  action_id: string;
  run_id: string | null;
  attempt_id: string;
  task_id: string;
  account_ids: string[];
  currency: string;
  amount_microunits: string;
  actual_microunits: string | null;
  status: BudgetReservation['status'];
  usage_key: string | null;
}
interface AccountRow {
  task_id: string;
  currency: string;
  limit_microunits: string;
  reserved_microunits: string;
  spent_microunits: string;
  version: string;
  blocked: boolean;
}
async function ledger(
  tx: Tx,
  chain: BudgetTask[],
  reservation?: ReservationRow,
): Promise<BudgetLedger> {
  const accounts = [];
  for (const task of chain) {
    const b = (
      await sql<AccountRow>`select * from task_budgets where task_id=${task.id} for update`.execute(
        tx,
      )
    ).rows[0];
    if (!b) throw new Error('Missing persisted Task budget');
    accounts.push({
      id: task.id,
      parentId: task.parent_task_id,
      currency: b.currency,
      limit: BigInt(b.limit_microunits),
      reserved: BigInt(b.reserved_microunits),
      settled: BigInt(b.spent_microunits),
      revision: BigInt(b.version),
      blocked: b.blocked,
    });
  }
  return {
    accounts,
    reservations: reservation
      ? [
          {
            id: reservation.id,
            leafAccountId: reservation.task_id,
            accountIds: reservation.account_ids,
            currency: reservation.currency,
            amount: BigInt(reservation.amount_microunits),
            status: reservation.status,
            usageId: reservation.usage_key,
            actualAmount:
              reservation.actual_microunits === null ? null : BigInt(reservation.actual_microunits),
          },
        ]
      : [],
    usageRecords: [],
  };
}
async function persist(tx: Tx, value: BudgetLedger) {
  for (const a of value.accounts)
    await sql`update task_budgets set reserved_microunits=${a.reserved.toString()},spent_microunits=${a.settled.toString()},version=${a.revision.toString()},blocked=${a.blocked},overrun_microunits=greatest(0,${(a.reserved + a.settled).toString()}::bigint-limit_microunits) where task_id=${a.id}`.execute(
      tx,
    );
}
/** Caller holds sorted Task root and complete root-to-leaf Task locks. Shared counters match runtime. */
export async function reserveActionBudget(
  tx: Tx,
  tenantId: string,
  action: {
    id: string;
    task_id: string;
    run_id?: string | null;
    currency: string;
    estimate_microunits: string;
  },
  attemptId: string,
  chain: BudgetTask[],
): Promise<string> {
  const id = randomUUID();
  if (action.run_id) {
    const changed =
      await sql`update agent_runs set budget_reserved_microunits=budget_reserved_microunits+${action.estimate_microunits}::bigint where id=${action.run_id} and budget_currency=${action.currency} and not budget_blocked and budget_reserved_microunits::numeric+budget_spent_microunits::numeric+${action.estimate_microunits}::numeric<=budget_limit_microunits returning id`.execute(
        tx,
      );
    if (changed.rows.length !== 1) throw new ApplicationError('BUDGET_EXCEEDED', 409);
  }
  const result = reserveBudget(await ledger(tx, chain), {
    reservationId: id,
    leafAccountId: action.task_id,
    amount: BigInt(action.estimate_microunits),
    currency: action.currency,
  });
  await persist(tx, result.ledger);
  await sql`insert into action_budget_reservations(tenant_id,id,action_id,attempt_id,task_id,account_ids,currency,amount_microunits,run_id) values(${tenantId},${id},${action.id},${attemptId},${action.task_id},${JSON.stringify(result.reservation.accountIds)}::jsonb,${action.currency},${action.estimate_microunits},${action.run_id ?? null})`.execute(
    tx,
  );
  return id;
}
export async function resolveActionBudget(
  tx: Tx,
  attemptId: string,
  chain: BudgetTask[],
  resolution:
    | { kind: 'unknown' }
    | { kind: 'release' }
    | { kind: 'settle'; actual: string; usageKey: string },
): Promise<void> {
  const r = (
    await sql<ReservationRow>`select * from action_budget_reservations where attempt_id=${attemptId} for update`.execute(
      tx,
    )
  ).rows[0];
  if (!r) throw new Error('Missing Action reservation');
  if (resolution.kind === 'unknown' && r.status === 'unknown') return;
  if (resolution.kind === 'release' && r.status === 'released') return;
  if (
    resolution.kind === 'settle' &&
    r.status === 'settled' &&
    r.actual_microunits === resolution.actual &&
    r.usage_key === resolution.usageKey
  )
    return;
  const previous = await ledger(tx, chain, r);
  const next =
    resolution.kind === 'unknown'
      ? markReservationUnknown(previous, r.id)
      : resolution.kind === 'release'
        ? releaseBudgetReservation(previous, { reservationId: r.id, confirmedNoCharge: true })
        : settleBudget(previous, {
            reservationId: r.id,
            usageId: resolution.usageKey,
            actualAmount: BigInt(resolution.actual),
          });
  if (r.run_id && resolution.kind !== 'unknown') {
    const actual = resolution.kind === 'settle' ? resolution.actual : '0';
    await sql`update agent_runs set budget_reserved_microunits=budget_reserved_microunits-${r.amount_microunits}::bigint,budget_spent_microunits=budget_spent_microunits+${actual}::bigint,budget_blocked=budget_blocked or budget_reserved_microunits::numeric-${r.amount_microunits}::numeric+budget_spent_microunits::numeric+${actual}::numeric>budget_limit_microunits where id=${r.run_id}`.execute(
      tx,
    );
  }
  await persist(tx, next);
  const updated = next.reservations[0]!;
  await sql`update action_budget_reservations set status=${updated.status},actual_microunits=${updated.actualAmount?.toString() ?? null},usage_key=${updated.usageId},updated_at=clock_timestamp() where id=${r.id}`.execute(
    tx,
  );
}
