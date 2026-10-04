import { createHash } from 'node:crypto';
import { sql, type TenantTransaction as Tx } from '@imbox/db';
import { canonical, type IntentRecord, type JournalRecord } from './journal.js';

export const recoveryHash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const freezeDigest = (records: readonly JournalRecord[]): string =>
  recoveryHash(
    records
      .filter((r) => r.kind === 'freeze')
      .map((r) => r.id)
      .sort(),
  );
export const journalDigest = (records: readonly JournalRecord[]): string =>
  recoveryHash(
    records.filter((r) => r.kind !== 'unfreeze').toSorted((a, b) => a.id.localeCompare(b.id)),
  );
export async function recoveredIntent(
  tx: Tx,
  intent: IntentRecord,
  records?: readonly JournalRecord[],
): Promise<boolean> {
  const found = (
    await sql<{
      outcome: string;
      receipt_id: string;
      actual_microunits: string;
    }>`select t.outcome,t.receipt_id,t.actual_microunits from action_recovery_tombstones t join action_reconciliation_cases c on c.tenant_id=t.tenant_id and c.id=t.case_id where t.attempt_id=${intent.attempt_id} and t.action_id=${intent.action_id} and t.intent_hash=${recoveryHash(intent)} and c.status='resolved'`.execute(
      tx,
    )
  ).rows[0];
  if (!found) return false;
  return !records?.some(
    (r) =>
      r.kind === 'receipt' &&
      r.attempt_id === intent.attempt_id &&
      r.outcome !== 'unknown' &&
      (r.action_id !== intent.action_id ||
        r.fingerprint !== intent.fingerprint ||
        r.outcome !== found.outcome ||
        r.receipt_id !== found.receipt_id ||
        r.actual_microunits !== found.actual_microunits),
  );
}
export interface ReceiptBinding {
  tenantId: string;
  toolId: string;
  receiptId: string;
  actionId: string;
  attemptId: string;
  fingerprint: string;
  outcome: 'succeeded' | 'no_effect';
  actualMicrounits: string;
}
/** Shared by ordinary receipts and orphan recovery, so one provider receipt cannot fund two facts. */
export async function bindProviderReceipt(tx: Tx, b: ReceiptBinding): Promise<boolean> {
  await sql`insert into action_provider_receipt_bindings(tenant_id,tool_id,external_id,action_id,attempt_id,fingerprint,outcome,actual_microunits) values(${b.tenantId},${b.toolId},${b.receiptId},${b.actionId},${b.attemptId},${b.fingerprint},${b.outcome},${b.actualMicrounits}) on conflict do nothing`.execute(
    tx,
  );
  return (
    (
      await sql`select 1 from action_provider_receipt_bindings where tool_id=${b.toolId} and external_id=${b.receiptId} and action_id=${b.actionId} and attempt_id=${b.attemptId} and fingerprint=${b.fingerprint} and outcome=${b.outcome} and actual_microunits=${b.actualMicrounits}::bigint for share`.execute(
        tx,
      )
    ).rows.length === 1
  );
}
