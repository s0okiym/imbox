import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  authorizeTenant,
  command,
  CursorCodec,
  fail,
  type AuthContext,
} from '@imbox/application';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import {
  lockPrincipal,
  lockTaskRoots,
  sql,
  withTenant,
  type Db,
  type TenantTransaction as Tx,
} from '@imbox/db';
import {
  canonical,
  type FreezeRecord,
  type IntentRecord,
  type JournalPort,
  type JournalRecord,
  type RecoveryRecord,
  type UnfreezeRecord,
} from './journal.js';
import {
  bindProviderReceipt,
  freezeDigest,
  journalDigest,
  recoveredIntent,
  recoveryHash,
} from './recovery-proof.js';
import type { ToolObservation, ToolRegistry } from './tools.js';

interface CaseRow {
  id: string;
  action_id: string;
  attempt_id: string;
  reason: string;
  status: 'open' | 'resolved';
  version: string;
  journal_record: IntentRecord | null;
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}
interface EvidenceRow {
  id: string;
  case_id: string;
  intent_hash: string;
  observation: ToolObservation;
  evidence_hash: string;
  created_at: Date;
}
interface Operation {
  id: string;
  kind: 'freeze' | 'confirm' | 'unfreeze';
  state: 'prepared' | 'completed';
  authorized_by: string;
  principal_version: string;
  authz_revision: string;
  journal_record: FreezeRecord | RecoveryRecord | UnfreezeRecord;
  journal_digest: string | null;
  freeze_digest: string | null;
  fence_revision: string | null;
}
interface Fence {
  frozen: boolean;
  revision: string;
}
const evidenceDto = (r: EvidenceRow) => ({
  id: r.id,
  case_id: r.case_id,
  intent_hash: r.intent_hash,
  evidence_hash: r.evidence_hash,
  outcome: r.observation.status,
  receipt_id: r.observation.status === 'unknown' ? null : r.observation.receiptId,
  actual_microunits: r.observation.status === 'unknown' ? null : r.observation.actualMicrounits,
  reason: r.observation.status === 'unknown' ? r.observation.reason : null,
  created_at: r.created_at.toISOString(),
});
const intentDto = (r: IntentRecord | null) =>
  r
    ? {
        task_id: r.task_id,
        fingerprint: r.fingerprint,
        business_key: r.business_key,
        tool_id: r.tool_id,
        tool_version: r.tool_version ?? null,
        target_id: r.target_id,
        currency: r.currency,
        estimate_microunits: r.estimate_microunits,
        budget_account_ids: r.budget_account_ids ?? null,
        created_at: r.created_at,
      }
    : null;

export function createActionRecoveryService(options: {
  db: Db;
  tools: ToolRegistry;
  journal: JournalPort;
  cursorSecret: string;
  recover: (tenantId: string, reason: 'restore', record: FreezeRecord) => Promise<unknown>;
}) {
  const { db, tools, journal } = options;
  const cursors = new CursorCodec(options.cursorSecret);
  async function admin(tx: Tx, auth: AuthContext): Promise<string> {
    await authorizeTenant(tx, auth);
    const p = await lockPrincipal(tx, auth.principalId);
    const role = (
      await sql<{
        role: string;
      }>`select role from tenant_principals where principal_id=${auth.principalId} and status='active' for share`.execute(
        tx,
      )
    ).rows[0]?.role;
    if (
      auth.kind !== 'human' ||
      p?.kind !== 'human' ||
      p.status !== 'active' ||
      !['owner', 'admin'].includes(role ?? '')
    )
      fail('FORBIDDEN', 403);
    return p.version;
  }
  async function fence(tx: Tx, tenantId: string, exclusive = false): Promise<Fence> {
    await sql`insert into action_safety_fences(tenant_id) values(${tenantId}) on conflict do nothing`.execute(
      tx,
    );
    return (
      await sql<Fence>`select frozen,revision from action_safety_fences where tenant_id=${tenantId} ${exclusive ? sql`for update` : sql`for share`}`.execute(
        tx,
      )
    ).rows[0]!;
  }
  async function caseRow(tx: Tx, id: string, lock = false): Promise<CaseRow> {
    return (
      (
        await sql<CaseRow>`select * from action_reconciliation_cases where id=${assertContract('Identifier', id)} ${lock ? sql`for update` : sql``}`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function operation(tx: Tx, id: string): Promise<Operation> {
    return (
      (
        await sql<Operation>`select * from action_recovery_operations where id=${id} for update`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function dto(tx: Tx, r: CaseRow): Promise<C['RecoveryCase']> {
    const evidence = (
      await sql<EvidenceRow>`select * from action_recovery_evidence where case_id=${r.id} order by created_at desc,id desc limit 20`.execute(
        tx,
      )
    ).rows;
    return assertContract('RecoveryCase', {
      id: r.id,
      action_id: r.action_id,
      attempt_id: r.attempt_id,
      reason: r.reason,
      status: r.status,
      version: r.version,
      intent: intentDto(r.journal_record),
      evidence: evidence.map(evidenceDto),
      created_at: r.created_at.toISOString(),
      resolved_at: r.resolved_at?.toISOString() ?? null,
      resolved_by: r.resolved_by,
    });
  }
  async function boundIntent(r: CaseRow, records: JournalRecord[]): Promise<IntentRecord> {
    const original = records.find(
      (item): item is IntentRecord =>
        item.kind === 'intent' &&
        item.attempt_id === r.attempt_id &&
        item.action_id === r.action_id,
    );
    if (!original || !r.journal_record || canonical(original) !== canonical(r.journal_record))
      fail('VERSION_CONFLICT', 409);
    return original;
  }
  async function emit(tx: Tx, auth: AuthContext, op: Operation, type: string): Promise<void> {
    await appendEvent(tx, auth, {
      aggregateType: 'action_recovery_operation',
      aggregateId: op.id,
      version: '1',
      type,
      payload: { operation_id: op.id, kind: op.kind },
      target: `action-recovery:${auth.tenantId}`,
    });
  }
  async function complete(auth: AuthContext, id: string): Promise<void> {
    const op = await withTenant(db, auth.tenantId, async (tx) => {
      await admin(tx, auth);
      return operation(tx, id);
    });
    await journal.append(op.journal_record);
    await withTenant(db, auth.tenantId, async (tx) => {
      const version = await admin(tx, auth);
      const current = await operation(tx, id);
      if (current.state === 'completed') return;
      if (
        current.authorized_by !== auth.principalId ||
        current.principal_version !== version ||
        current.authz_revision !== auth.authzRevision
      )
        fail('FORBIDDEN', 403);
      await sql`update action_recovery_operations set state='completed',completed_at=clock_timestamp() where id=${id}`.execute(
        tx,
      );
      await emit(tx, auth, current, `action.recovery_${current.kind}`);
    });
  }
  async function verifiedAccountingChain(
    tx: Tx,
    tenantId: string,
    intent: IntentRecord,
  ): Promise<string[]> {
    const expected = intent.budget_account_ids;
    if (
      !intent.tool_version ||
      !expected?.length ||
      expected.length > 100 ||
      new Set(expected).size !== expected.length ||
      expected.at(-1) !== intent.task_id
    )
      fail('CHARGE_STATUS_UNKNOWN', 409);
    await lockTaskRoots(tx, tenantId, [expected[0]!]);
    let parent: string | null = null;
    for (const id of expected) {
      const task = (
        await sql<{
          parent_task_id: string | null;
          root_task_id: string;
        }>`select parent_task_id,root_task_id from tasks where id=${id} for update`.execute(tx)
      ).rows[0];
      if (!task || task.parent_task_id !== parent || task.root_task_id !== expected[0])
        fail('CHARGE_STATUS_UNKNOWN', 409);
      parent = id;
    }
    if (intent.run_id) {
      const run = (
        await sql<{
          task_id: string;
          budget_currency: string;
        }>`select task_id,budget_currency from agent_runs where id=${intent.run_id} for update`.execute(
          tx,
        )
      ).rows[0];
      if (!run || run.task_id !== intent.task_id || run.budget_currency !== intent.currency)
        fail('CHARGE_STATUS_UNKNOWN', 409);
    }
    return expected;
  }
  async function assertAllAccounted(tx: Tx, records: JournalRecord[]): Promise<void> {
    if (
      (await sql`select 1 from action_reconciliation_cases where status='open' limit 1`.execute(tx))
        .rows.length
    )
      fail('CHARGE_STATUS_UNKNOWN', 409);
    if (
      (await sql`select 1 from actions where status in ('executing','unknown') limit 1`.execute(tx))
        .rows.length
    )
      fail('CHARGE_STATUS_UNKNOWN', 409);
    if (
      (
        await sql`select 1 from action_recovery_operations where state='prepared' and kind='confirm' limit 1`.execute(
          tx,
        )
      ).rows.length
    )
      fail('CHARGE_STATUS_UNKNOWN', 409);
    for (const intent of records.filter((r): r is IntentRecord => r.kind === 'intent')) {
      if (await recoveredIntent(tx, intent, records)) {
        const proof = (
          await sql<{
            id: string;
            journal_record: RecoveryRecord;
          }>`select id,journal_record from action_recovery_operations where kind='confirm' and state='completed' and journal_record->>'attempt_id'=${intent.attempt_id}`.execute(
            tx,
          )
        ).rows;
        if (
          !proof.some((p) =>
            records.some((r) => r.id === p.id && canonical(r) === canonical(p.journal_record)),
          )
        )
          fail('CHARGE_STATUS_UNKNOWN', 409);
        continue;
      }
      const found = (
        await sql<{
          status: string;
          side_effect: string;
        }>`select status,side_effect from action_attempts where id=${intent.attempt_id} and action_id=${intent.action_id} and fingerprint=${intent.fingerprint} and lease_generation=${intent.lease_generation}`.execute(
          tx,
        )
      ).rows[0];
      if (
        !found ||
        !['succeeded', 'failed', 'cancelled'].includes(found.status) ||
        found.side_effect === 'possible'
      )
        fail('CHARGE_STATUS_UNKNOWN', 409);
    }
  }
  const service = {
    async status(auth: AuthContext): Promise<C['RecoveryStatus']> {
      await withTenant(db, auth.tenantId, (tx) => admin(tx, auth));
      const records = await journal.records(auth.tenantId);
      const journalFrozen = await journal.frozen(auth.tenantId);
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const f = await fence(tx, auth.tenantId);
        const counts = (
          await sql<{
            open: string;
            pending: string;
          }>`select (select count(*) from action_reconciliation_cases where status='open') as open,(select count(*) from action_recovery_operations where state='prepared') as pending`.execute(
            tx,
          )
        ).rows[0]!;
        return assertContract('RecoveryStatus', {
          frozen: f.frozen || journalFrozen,
          journal_frozen: journalFrozen,
          database_frozen: f.frozen,
          revision: f.revision,
          open_cases: Number(counts.open),
          pending_operations: Number(counts.pending),
          freeze_digest: freezeDigest(records),
          journal_digest: journalDigest(records),
        });
      });
    },
    async refresh(
      auth: AuthContext,
      raw: { reason: string },
      key: string,
    ): Promise<C['RecoveryStatus']> {
      const input = assertContract('RecoveryReasonInput', raw);
      const id = await withTenant(db, auth.tenantId, async (tx) => {
        const principalVersion = await admin(tx, auth);
        return command(tx, auth, 'action.recovery.freeze', key, input, async () => {
          const id = randomUUID();
          const created = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx))
            .rows[0]!.now;
          const record: FreezeRecord = {
            kind: 'freeze',
            id,
            tenant_id: auth.tenantId,
            reason: 'restore',
            created_at: created.toISOString(),
          };
          await sql`insert into action_recovery_operations(tenant_id,id,kind,authorized_by,principal_version,authz_revision,reason,journal_record) values(${auth.tenantId},${id},'freeze',${auth.principalId},${principalVersion},${auth.authzRevision},${input.reason},${JSON.stringify(record)}::jsonb)`.execute(
            tx,
          );
          return id;
        });
      });
      const op = await withTenant(db, auth.tenantId, (tx) => operation(tx, id));
      if (op.state !== 'completed') {
        if (op.journal_record.kind !== 'freeze') fail('VERSION_CONFLICT', 409);
        await options.recover(auth.tenantId, 'restore', op.journal_record);
        await complete(auth, id);
      }
      return service.status(auth);
    },
    async list(auth: AuthContext, cursor?: string): Promise<C['RecoveryCasePage']> {
      return withTenant(db, auth.tenantId, async (tx) => {
        const version = await admin(tx, auth);
        const binding = `recovery:${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:${version}`;
        const after = cursor ? assertContract('Identifier', cursors.decode(cursor, binding)) : null;
        const rows = (
          await sql<CaseRow>`select * from action_reconciliation_cases where (${after}::uuid is null or id>${after}::uuid) order by id limit 101`.execute(
            tx,
          )
        ).rows;
        return assertContract('RecoveryCasePage', {
          items: await Promise.all(rows.slice(0, 100).map((r) => dto(tx, r))),
          ...(rows.length > 100 ? { next_cursor: cursors.encode(binding, rows[99]!.id) } : {}),
        });
      });
    },
    async get(auth: AuthContext, id: string): Promise<C['RecoveryCase']> {
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        return dto(tx, await caseRow(tx, id));
      });
    },
    async lookup(auth: AuthContext, id: string, key: string): Promise<C['RecoveryEvidence']> {
      const reference = await withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const row = await caseRow(tx, id);
        const evidenceId = await command(
          tx,
          auth,
          'action.recovery.lookup',
          key,
          { id },
          async () => randomUUID(),
        );
        const existing = (
          await sql<EvidenceRow>`select * from action_recovery_evidence where id=${evidenceId}`.execute(
            tx,
          )
        ).rows[0];
        return { row, evidenceId, existing };
      });
      if (reference.existing)
        return assertContract('RecoveryEvidence', evidenceDto(reference.existing));
      const intent = await boundIntent(reference.row, await journal.records(auth.tenantId));
      let observation: ToolObservation = { status: 'unknown', reason: 'invalid_response' };
      if (intent.tool_version && intent.tool_binding) {
        try {
          const tool = tools.get(intent.tool_id, intent.tool_version, intent.target_id);
          if (
            tool.executionBinding === intent.tool_binding &&
            tool.recoveryTransport === 'controlled_http_v1' &&
            tool.lookupRecovery
          )
            observation = await tool.lookupRecovery({
              tenantId: auth.tenantId,
              actionId: intent.action_id,
              attemptId: intent.attempt_id,
              businessKey: intent.business_key,
              fingerprint: intent.fingerprint,
            });
        } catch {
          observation = { status: 'unknown', reason: 'invalid_response' };
        }
      }
      return withTenant(db, auth.tenantId, async (tx) => {
        await admin(tx, auth);
        const current = await caseRow(tx, id, true);
        if (
          current.version !== reference.row.version ||
          canonical(current.journal_record) !== canonical(intent)
        )
          fail('VERSION_CONFLICT', 409);
        const payload = { intent, observation };
        await sql`insert into action_recovery_evidence(tenant_id,id,case_id,intent_hash,outcome,observation,evidence_hash,looked_up_by) values(${auth.tenantId},${reference.evidenceId},${id},${recoveryHash(intent)},${observation.status},${JSON.stringify(observation)}::jsonb,${recoveryHash(payload)},${auth.principalId}) on conflict do nothing`.execute(
          tx,
        );
        const stored = (
          await sql<EvidenceRow>`select * from action_recovery_evidence where id=${reference.evidenceId}`.execute(
            tx,
          )
        ).rows[0]!;
        return assertContract('RecoveryEvidence', evidenceDto(stored));
      });
    },
    async confirm(
      auth: AuthContext,
      id: string,
      raw: { evidence_id: string; confirmed: true; reason: string },
      version: string,
      key: string,
    ): Promise<C['RecoveryCase']> {
      const input = assertContract('RecoveryConfirmInput', raw);
      assertContract('Version', version);
      await withTenant(db, auth.tenantId, (tx) => admin(tx, auth));
      const records = await journal.records(auth.tenantId);
      const operationId = await withTenant(db, auth.tenantId, async (tx) => {
        const principalVersion = await admin(tx, auth);
        const f = await fence(tx, auth.tenantId, true);
        return command(
          tx,
          auth,
          'action.recovery.confirm',
          key,
          { id, input, version },
          async () => {
            if (!f.frozen) fail('VERSION_CONFLICT', 409);
            const row = await caseRow(tx, id, true);
            if (row.version !== version || row.status !== 'open') fail('VERSION_CONFLICT', 409);
            const intent = await boundIntent(row, records);
            const evidence = (
              await sql<EvidenceRow>`select * from action_recovery_evidence where id=${input.evidence_id} and case_id=${id} for share`.execute(
                tx,
              )
            ).rows[0];
            if (
              !evidence ||
              evidence.intent_hash !== recoveryHash(intent) ||
              evidence.evidence_hash !== recoveryHash({ intent, observation: evidence.observation })
            )
              fail('VERSION_CONFLICT', 409);
            const observed = evidence.observation;
            if (observed.status === 'unknown') fail('CHARGE_STATUS_UNKNOWN', 409);
            if (observed.fingerprint !== intent.fingerprint) fail('CHARGE_STATUS_UNKNOWN', 409);
            // Intact attempts use normal outcome reconciliation. Never overwrite conflicting facts.
            if (
              (await sql`select 1 from action_attempts where id=${intent.attempt_id}`.execute(tx))
                .rows.length
            )
              fail('CHARGE_STATUS_UNKNOWN', 409);
            const accounts = await verifiedAccountingChain(tx, auth.tenantId, intent);
            if (
              !(await bindProviderReceipt(tx, {
                tenantId: auth.tenantId,
                toolId: intent.tool_id,
                receiptId: observed.receiptId,
                actionId: intent.action_id,
                attemptId: intent.attempt_id,
                fingerprint: intent.fingerprint,
                outcome: observed.status,
                actualMicrounits: observed.actualMicrounits,
              }))
            )
              fail('CHARGE_STATUS_UNKNOWN', 409);
            const existing = (
              await sql`select 1 from action_recovery_tombstones where attempt_id=${intent.attempt_id} or (business_key=${intent.business_key} and action_id<>${intent.action_id})`.execute(
                tx,
              )
            ).rows.length;
            if (existing) fail('VERSION_CONFLICT', 409);
            const actual = BigInt(assertContract('Counter', observed.actualMicrounits));
            if (intent.run_id) {
              const changed =
                await sql`update agent_runs set budget_spent_microunits=budget_spent_microunits+${actual.toString()}::bigint,budget_blocked=budget_blocked or budget_reserved_microunits::numeric+budget_spent_microunits::numeric+${actual.toString()}::numeric>budget_limit_microunits where id=${intent.run_id} and budget_spent_microunits::numeric+${actual.toString()}::numeric<=9223372036854775807 returning id`.execute(
                  tx,
                );
              if (changed.rows.length !== 1) fail('CHARGE_STATUS_UNKNOWN', 409);
            }
            for (const account of accounts) {
              const b = (
                await sql<{
                  currency: string;
                  spent_microunits: string;
                  reserved_microunits: string;
                  limit_microunits: string;
                }>`select * from task_budgets where task_id=${account} for update`.execute(tx)
              ).rows[0];
              if (!b || b.currency !== intent.currency) fail('CHARGE_STATUS_UNKNOWN', 409);
              const spent = BigInt(b.spent_microunits) + actual,
                total = spent + BigInt(b.reserved_microunits);
              if (spent > 9223372036854775807n || total > 9223372036854775807n)
                fail('CHARGE_STATUS_UNKNOWN', 409);
              await sql`update task_budgets set spent_microunits=${spent.toString()},blocked=blocked or ${total > BigInt(b.limit_microunits)},overrun_microunits=greatest(0,${total.toString()}::bigint-limit_microunits),version=version+1 where task_id=${account}`.execute(
                tx,
              );
            }
            await sql`insert into action_recovery_tombstones(tenant_id,attempt_id,action_id,business_key,case_id,evidence_id,intent_hash,tool_id,receipt_id,outcome,currency,actual_microunits,budget_account_ids,confirmed_by,run_id) values(${auth.tenantId},${intent.attempt_id},${intent.action_id},${intent.business_key},${id},${evidence.id},${recoveryHash(intent)},${intent.tool_id},${observed.receiptId},${observed.status},${intent.currency},${observed.actualMicrounits},${JSON.stringify(accounts)}::jsonb,${auth.principalId},${intent.run_id ?? null})`.execute(
              tx,
            );
            await sql`update action_reconciliation_cases set status='resolved',version=version+1,resolved_at=clock_timestamp(),resolved_by=${auth.principalId} where id=${id}`.execute(
              tx,
            );
            const opId = randomUUID();
            const time = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx))
              .rows[0]!.now;
            const record: RecoveryRecord = {
              kind: 'recovery',
              id: opId,
              tenant_id: auth.tenantId,
              action_id: intent.action_id,
              attempt_id: intent.attempt_id,
              intent_hash: recoveryHash(intent),
              evidence_hash: evidence.evidence_hash,
              receipt_id: observed.receiptId,
              outcome: observed.status,
              actual_microunits: observed.actualMicrounits,
              confirmed_by: auth.principalId,
              created_at: time.toISOString(),
            };
            await sql`insert into action_recovery_operations(tenant_id,id,kind,authorized_by,principal_version,authz_revision,reason,journal_record) values(${auth.tenantId},${opId},'confirm',${auth.principalId},${principalVersion},${auth.authzRevision},${input.reason},${JSON.stringify(record)}::jsonb)`.execute(
              tx,
            );
            return opId;
          },
        );
      });
      await complete(auth, operationId);
      return service.get(auth, id);
    },
    async unfreeze(
      auth: AuthContext,
      raw: { confirmed: true; reason: string; freeze_digest: string; journal_digest: string },
      version: string,
      key: string,
    ): Promise<C['RecoveryStatus']> {
      const input = assertContract('RecoveryUnfreezeInput', raw);
      assertContract('Version', version);
      await withTenant(db, auth.tenantId, (tx) => admin(tx, auth));
      const records = await journal.records(auth.tenantId);
      const id = await withTenant(db, auth.tenantId, async (tx) => {
        const principalVersion = await admin(tx, auth);
        return command(tx, auth, 'action.recovery.unfreeze', key, { input, version }, async () => {
          const f = await fence(tx, auth.tenantId, true);
          if (
            !f.frozen ||
            f.revision !== version ||
            input.freeze_digest !== freezeDigest(records) ||
            input.journal_digest !== journalDigest(records)
          )
            fail('VERSION_CONFLICT', 409);
          await assertAllAccounted(tx, records);
          const id = randomUUID(),
            created = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx))
              .rows[0]!.now;
          const record: UnfreezeRecord = {
            kind: 'unfreeze',
            id,
            tenant_id: auth.tenantId,
            freeze_digest: input.freeze_digest,
            journal_digest: input.journal_digest,
            authorized_by: auth.principalId,
            created_at: created.toISOString(),
          };
          await sql`insert into action_recovery_operations(tenant_id,id,kind,authorized_by,principal_version,authz_revision,reason,journal_record,journal_digest,freeze_digest,fence_revision) values(${auth.tenantId},${id},'unfreeze',${auth.principalId},${principalVersion},${auth.authzRevision},${input.reason},${JSON.stringify(record)}::jsonb,${input.journal_digest},${input.freeze_digest},${f.revision})`.execute(
            tx,
          );
          return id;
        });
      });
      const op = await withTenant(db, auth.tenantId, (tx) => operation(tx, id));
      if (op.state === 'completed') return service.status(auth);
      const before = await journal.records(auth.tenantId);
      if (op.freeze_digest !== freezeDigest(before) || op.journal_digest !== journalDigest(before))
        fail('VERSION_CONFLICT', 409);
      await journal.append(op.journal_record);
      const after = await journal.records(auth.tenantId);
      await withTenant(db, auth.tenantId, async (tx) => {
        const principalVersion = await admin(tx, auth);
        const current = await operation(tx, id);
        const f = await fence(tx, auth.tenantId, true);
        if (current.state === 'completed') return;
        if (
          current.authorized_by !== auth.principalId ||
          current.principal_version !== principalVersion ||
          current.authz_revision !== auth.authzRevision
        )
          fail('FORBIDDEN', 403);
        if (
          !f.frozen ||
          f.revision !== current.fence_revision ||
          current.freeze_digest !== freezeDigest(after) ||
          current.journal_digest !== journalDigest(after)
        )
          fail('VERSION_CONFLICT', 409);
        await assertAllAccounted(tx, after);
        await sql`update action_safety_fences set frozen=false,reason='human_recovery_confirmed',revision=revision+1,updated_at=clock_timestamp() where tenant_id=${auth.tenantId}`.execute(
          tx,
        );
        await sql`update action_recovery_operations set state='completed',completed_at=clock_timestamp() where id=${id}`.execute(
          tx,
        );
        await emit(tx, auth, current, 'action.recovery_unfreeze');
      });
      return service.status(auth);
    },
  };
  return service;
}
export type ActionRecoveryService = ReturnType<typeof createActionRecoveryService>;
