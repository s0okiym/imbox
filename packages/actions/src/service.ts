import {
  lockRunToolAuthority,
  assertRunToolLease,
  runToolState,
  type LeaseClaim,
} from '@imbox/runtime';
import type { RuntimeSourcePort } from '@imbox/application';
import { createHash, randomUUID } from 'node:crypto';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import {
  sql,
  withTenant,
  lockTaskRoots,
  lockPrincipal,
  type Db,
  type TenantTransaction as Tx,
} from '@imbox/db';
import {
  appendEvent,
  authorizeTenant,
  command,
  expectedVersion,
  fail,
  ApplicationError,
  CursorCodec,
  taskOwnerAvailable,
  type AuthContext,
} from '@imbox/application';
import {
  createAction as newAction,
  prepareAction,
  approveAction,
  cancelAction,
  startActionAttempt,
  dispatchActionAttempt,
  recordAttemptOutcome,
  recordActionOutcome,
  scheduleActionRetry,
  assertTaskFencesCurrent,
  isTerminalTaskStatus,
  acquireLease,
  assertLeaseValid,
  DomainError,
  type Action as DomainAction,
  type ActionAttempt as DomainAttempt,
} from '@imbox/domain';
import { canonical, type JournalPort, type IntentRecord, type FreezeRecord } from './journal.js';
import { bindProviderReceipt, recoveredIntent } from './recovery-proof.js';
import { createActionRecoveryService } from './recovery.js';
import { reserveActionBudget, resolveActionBudget } from './budget.js';
import type { ToolRegistry, ToolObservation } from './tools.js';
import type {
  ActionClaim,
  ActionRow,
  ApprovalRow,
  AttemptRow,
  GrantRow,
  TaskRow,
} from './types.js';
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const json = (v: unknown) => JSON.stringify(v);
const asAction = (a: ActionRow): DomainAction => ({
  id: a.id,
  taskId: a.task_id,
  businessKey: a.business_key,
  parameterFingerprint: a.fingerprint,
  status: a.status,
  version: BigInt(a.version),
  attemptCount: a.attempt_count,
  lastAttemptId: a.last_attempt_id,
  nextAttemptAtMs: a.next_attempt_at?.getTime() ?? null,
});
const asAttempt = (a: AttemptRow): DomainAttempt => ({
  id: a.id,
  actionId: a.action_id,
  attemptNo: a.attempt_no,
  version: BigInt(a.version),
  status: a.status,
  sideEffect: a.side_effect,
});
interface Principal {
  principal_version: string;
  principal_id: string;
  kind: 'human' | 'agent' | 'service';
  authz_revision: string;
  role: string;
}
interface Options {
  db: Db;
  tools: ToolRegistry;
  journal: JournalPort;
  cursorSecret: string;
  leaseSeconds?: number;
  sources?: RuntimeSourcePort;
}

export function createActionService(options: Options) {
  const { db, tools, journal } = options;
  const cursors = new CursorCodec(options.cursorSecret);
  const leaseSeconds = options.leaseSeconds ?? 60;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 300)
    throw new Error('Action lease must be 1..300 seconds');
  async function txFor<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withTenant(db, tenantId, fn);
    } catch (error) {
      if (error instanceof DomainError)
        throw new ApplicationError(
          error.code === 'INVALID_ARGUMENT' ? 'VALIDATION_FAILED' : error.code,
          error.status,
        );
      throw error;
    }
  }
  async function transaction<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>) {
    return txFor(auth.tenantId, async (tx) => {
      await authorizeTenant(tx, auth);
      return fn(tx);
    });
  }
  async function task(tx: Tx, id: string): Promise<TaskRow> {
    return (
      (await sql<TaskRow>`select * from tasks where id=${id}`.execute(tx)).rows[0] ??
      fail('NOT_FOUND', 404)
    );
  }
  async function action(tx: Tx, id: string): Promise<ActionRow> {
    return (
      (await sql<ActionRow>`select * from actions where id=${id}`.execute(tx)).rows[0] ??
      fail('NOT_FOUND', 404)
    );
  }
  async function grant(tx: Tx, id: string): Promise<GrantRow> {
    return (
      (await sql<GrantRow>`select * from capability_grants where id=${id}`.execute(tx)).rows[0] ??
      fail('NOT_FOUND', 404)
    );
  }
  async function now(tx: Tx) {
    return (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)).rows[0]!.now;
  }
  async function principal(tx: Tx, id: string): Promise<Principal> {
    const global = await lockPrincipal(tx, id);
    if (!global || global.status !== 'active') fail('FORBIDDEN', 403);
    const tenant =
      (
        await sql<
          Pick<Principal, 'principal_id' | 'authz_revision' | 'role'>
        >`select principal_id,authz_revision,role from tenant_principals where principal_id=${id} and status='active' for share`.execute(
          tx,
        )
      ).rows[0] ?? fail('FORBIDDEN', 403);
    return { ...tenant, kind: global.kind, principal_version: global.version };
  }
  async function workspace(tx: Tx, t: TaskRow, principalId: string) {
    return (
      (
        await sql<{
          role: string;
          version: string;
        }>`select role,version from memberships where workspace_id=${t.workspace_id} and principal_id=${principalId} and status='active' for share`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function access(tx: Tx, t: TaskRow, principalId: string) {
    await workspace(tx, t, principalId);
    return (
      (
        await sql<{
          role: string;
          version: string;
        }>`select role,version from task_participants where task_id=${t.id} and principal_id=${principalId} and status='active' for share`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function authority(tx: Tx, t: TaskRow, principalId: string) {
    const actor = await principal(tx, principalId);
    const member = await workspace(tx, t, principalId);
    const participant = await access(tx, t, principalId);
    return { actor, workspace: member, participant };
  }
  async function admin(tx: Tx, auth: AuthContext, t: TaskRow) {
    const p = await principal(tx, auth.principalId);
    const w = await workspace(tx, t, auth.principalId);
    if (p.kind !== 'human' || !['owner', 'admin'].includes(p.role) || w.role !== 'admin')
      fail('FORBIDDEN', 403);
    await access(tx, t, auth.principalId);
  }
  async function lockedChain(tx: Tx, tenantId: string, taskId: string, live = true) {
    const root = await task(tx, taskId);
    await lockTaskRoots(tx, tenantId, [root.root_task_id]);
    const rows = (
      await sql<
        TaskRow & { depth: number }
      >`with recursive chain as (select t.*,0 as depth from tasks t where id=${taskId} union all select p.*,c.depth+1 from tasks p join chain c on p.id=c.parent_task_id and p.tenant_id=c.tenant_id) select * from chain order by depth desc`.execute(
        tx,
      )
    ).rows;
    const result: TaskRow[] = [];
    const time = await now(tx);
    for (const r of rows) {
      const current = (
        await sql<TaskRow>`select * from tasks where id=${r.id} for update`.execute(tx)
      ).rows[0]!;
      if (
        live &&
        (!(await taskOwnerAvailable(tx, current)) ||
          isTerminalTaskStatus(current.status) ||
          current.status === 'blocked' ||
          (current.execution_deadline && current.execution_deadline <= time))
      )
        fail('TASK_TERMINATED', 409);
      result.push(current);
    }
    if (!result.length) fail('NOT_FOUND', 404);
    return result;
  }
  async function safety(tx: Tx, tenantId: string) {
    await sql`insert into action_safety_fences(tenant_id) values(${tenantId}) on conflict do nothing`.execute(
      tx,
    );
    const fence = (
      await sql<{
        frozen: boolean;
      }>`select frozen from action_safety_fences where tenant_id=${tenantId} for share`.execute(tx)
    ).rows[0]!;
    if (fence.frozen) fail('SERVICE_UNAVAILABLE', 503);
  }
  function registered(id: string, version: string, targetId: string) {
    try {
      return tools.get(id, version, targetId);
    } catch {
      return fail('VALIDATION_FAILED', 400);
    }
  }
  async function artifactBodies(
    tx: Tx,
    t: TaskRow,
    refs: C['ActionResourceRef'][],
    readerIds: string[],
  ) {
    const artifacts = refs.filter((ref) => ref.type === 'artifact_version');
    if (!artifacts.length) return [];
    if (!options.sources) fail('SERVICE_UNAVAILABLE', 503);
    const readers: AuthContext[] = [];
    for (const id of readerIds) {
      const person = await principal(tx, id);
      readers.push({
        tenantId: (
          await sql<{ tenant_id: string }>`select tenant_id from tasks where id=${t.id}`.execute(tx)
        ).rows[0]!.tenant_id,
        principalId: id,
        kind: person.kind,
        authzRevision: person.authz_revision,
      });
    }
    const bodies: string[] = [];
    for (const ref of artifacts) {
      const source = await options.sources!.read(tx, {
        creator: readers[0]!,
        agent: readers.at(-1)!,
        reference: { ...ref, required: true },
        scope: { taskId: t.id, conversationId: null },
      });
      if (typeof source.payload.body !== 'string') fail('VALIDATION_FAILED', 400);
      bodies.push(source.payload.body as string);
    }
    return bodies;
  }
  async function validateResources(
    tx: Tx,
    t: TaskRow,
    refs: C['ActionResourceRef'][],
    readerIds: string[],
    parameters?: C['ActionParameters'],
  ) {
    if (new Set(refs.map((ref) => `${ref.type}:${ref.id}:${ref.version}`)).size !== refs.length)
      fail('VALIDATION_FAILED', 400);
    for (const ref of refs) {
      if (ref.type !== 'task') continue;
      if (ref.id !== t.id) fail('DISCLOSURE_DENIED', 403);
      expectedVersion(t.version, ref.version);
    }
    const bodies = await artifactBodies(tx, t, refs, readerIds);
    // One explicit immutable artifact per publication; never silently join or truncate contents.
    if (parameters && bodies.length && (bodies.length !== 1 || bodies[0] !== parameters.text))
      fail('VERSION_CONFLICT', 409);
  }
  const sameReference = (a: C['ActionResourceRef'], b: C['ActionResourceRef']) =>
    a.type === b.type &&
    a.id === b.id &&
    a.version === b.version &&
    (a.type !== 'artifact_version' || (b.type === 'artifact_version' && a.sha256 === b.sha256));
  async function installation(tx: Tx, p: Principal) {
    if (p.kind !== 'agent') return null;
    const row = (
      await sql<{
        id: string;
        authz_revision: string;
      }>`select id,authz_revision from agent_installations where agent_principal_id=${p.principal_id} and status='active' for share`.execute(
        tx,
      )
    ).rows[0];
    if (!row) fail('FORBIDDEN', 403);
    return row!;
  }
  async function grantCurrent(
    tx: Tx,
    a: Pick<
      ActionRow,
      | 'grant_id'
      | 'grant_revision'
      | 'task_id'
      | 'executor_id'
      | 'tool_id'
      | 'tool_version'
      | 'target_id'
      | 'currency'
      | 'estimate_microunits'
      | 'resource_versions'
    >,
  ) {
    const g =
      (
        await sql<GrantRow>`select * from capability_grants where id=${a.grant_id} for share`.execute(
          tx,
        )
      ).rows[0] ?? fail('FORBIDDEN', 403);
    const time = await now(tx);
    if (
      g.status !== 'active' ||
      g.expires_at <= time ||
      g.revision !== a.grant_revision ||
      g.task_id !== a.task_id ||
      g.executor_principal_id !== a.executor_id ||
      g.tool_id !== a.tool_id ||
      g.tool_version !== a.tool_version ||
      g.target_id !== a.target_id ||
      !g.allow_execute ||
      !g.allow_disclosure
    )
      fail('FORBIDDEN', 403);
    if (g.currency !== a.currency || BigInt(a.estimate_microunits) > BigInt(g.limit_microunits))
      fail('BUDGET_EXCEEDED', 409);
    for (const ref of a.resource_versions)
      if (!g.resource_versions.some((item) => sameReference(item, ref)))
        fail('DISCLOSURE_DENIED', 403);
    const chain = await lockedChain(tx, g.tenant_id, g.task_id);
    assertTaskFencesCurrent(
      g.ancestor_fences.map((f) => ({
        taskId: f.taskId,
        executionEpoch: BigInt(f.executionEpoch),
      })),
      chain.map((t) => ({ id: t.id, status: t.status, executionEpoch: BigInt(t.execution_epoch) })),
    );
    const target = chain.at(-1)!;
    const snapshot = {
      issuer: await authority(tx, target, g.issued_by),
      executor: await authority(tx, target, g.executor_principal_id),
    };
    if (hash(snapshot) !== hash(g.authority_snapshot)) fail('FORBIDDEN', 403);
    return g;
  }
  async function actors(tx: Tx, a: ActionRow) {
    const people = new Map<string, Principal>();
    for (const id of [...new Set([a.requester_id, a.executor_id])].sort())
      people.set(id, await principal(tx, id));
    const requester = people.get(a.requester_id)!;
    const executor = people.get(a.executor_id)!;
    expectedVersion(requester.authz_revision, a.requester_revision);
    expectedVersion(executor.authz_revision, a.executor_revision);
    const install = await installation(tx, executor);
    if (
      (install?.id ?? null) !== a.executor_installation_id ||
      (install?.authz_revision ?? null) !== a.executor_installation_revision
    )
      fail('FORBIDDEN', 403);
    await authorizeTenant(tx, {
      tenantId: a.tenant_id,
      principalId: a.executor_id,
      kind: executor.kind,
      authzRevision: executor.authz_revision,
    });
    return { requester, executor };
  }
  async function verifyAdmission(tx: Tx, a: ActionRow, chain: TaskRow[]) {
    assertTaskFencesCurrent(
      a.ancestor_fences.map((f) => ({
        taskId: f.taskId,
        executionEpoch: BigInt(f.executionEpoch),
      })),
      chain.map((t) => ({ id: t.id, status: t.status, executionEpoch: BigInt(t.execution_epoch) })),
    );
    const t = chain.at(-1)!;
    if (
      hash(a.authority_snapshot) !==
      hash({
        requester: await authority(tx, t, a.requester_id),
        executor: await authority(tx, t, a.executor_id),
      })
    )
      fail('FORBIDDEN', 403);
    const requester = await access(tx, t, a.requester_id);
    const executor = await access(tx, t, a.executor_id);
    if (
      !['owner', 'contributor'].includes(requester.role) ||
      !['owner', 'contributor'].includes(executor.role) ||
      t.status !== 'active'
    )
      fail('FORBIDDEN', 403);
    await validateResources(
      tx,
      t,
      a.resource_versions,
      [a.requester_id, a.executor_id],
      a.parameters,
    );
    const deps = (
      await sql<{
        blocked: boolean;
      }>`select exists(select 1 from task_dependencies d join tasks p on p.id=d.prerequisite_task_id and p.tenant_id=d.tenant_id where d.dependent_task_id=${a.task_id} and p.status<>'completed') as blocked`.execute(
        tx,
      )
    ).rows[0]!;
    if (deps.blocked) fail('DEPENDENCY_BLOCKED', 409);
    return grantCurrent(tx, a);
  }
  async function approval(tx: Tx, a: ActionRow) {
    return (
      await sql<ApprovalRow>`select * from action_approvals where action_id=${a.id} and action_version=${a.approval_binding_version} for update`.execute(
        tx,
      )
    ).rows[0];
  }
  async function approved(tx: Tx, a: ActionRow, g: GrantRow, t: TaskRow) {
    if (!a.approval_required) return;
    const p = await approval(tx, a);
    const time = await now(tx);
    if (
      !p ||
      p.status !== 'approved' ||
      p.expires_at <= time ||
      p.action_version !== a.approval_binding_version ||
      p.fingerprint !== a.fingerprint ||
      p.target_id !== a.target_id ||
      !p.decided_by ||
      !g.approver_ids.includes(p.decided_by)
    )
      fail('FORBIDDEN', 403);
    const human = await principal(tx, p.decided_by);
    const member = await access(tx, t, p.decided_by);
    if (human.kind !== 'human' || !['owner', 'reviewer'].includes(member.role))
      fail('FORBIDDEN', 403);
    if (hash(p.authority_snapshot) !== hash(await authority(tx, t, p.decided_by)))
      fail('FORBIDDEN', 403);
    await sql`update action_approvals set consumed_at=coalesce(consumed_at,clock_timestamp()) where id=${p.id}`.execute(
      tx,
    );
  }
  async function saveAction(tx: Tx, id: string, state: DomainAction) {
    await sql`update actions set status=${state.status},version=${state.version.toString()},attempt_count=${state.attemptCount},last_attempt_id=${state.lastAttemptId},next_attempt_at=${state.nextAttemptAtMs === null ? null : new Date(state.nextAttemptAtMs)},updated_at=clock_timestamp() where id=${id}`.execute(
      tx,
    );
    return action(tx, id);
  }
  async function saveAttempt(tx: Tx, state: DomainAttempt) {
    await sql`update action_attempts set status=${state.status},version=${state.version.toString()},side_effect=${state.sideEffect},updated_at=clock_timestamp() where id=${state.id}`.execute(
      tx,
    );
  }
  async function event(tx: Tx, a: ActionRow, type: string) {
    await appendEvent(
      tx,
      {
        tenantId: a.tenant_id,
        principalId: a.requester_id,
        authzRevision: a.requester_revision,
        kind: (
          await sql<{
            kind: AuthContext['kind'];
          }>`select kind from principals where id=${a.requester_id}`.execute(tx)
        ).rows[0]!.kind,
      },
      {
        aggregateType: 'action',
        aggregateId: a.id,
        version: a.version,
        type,
        payload: { task_id: a.task_id, status: a.status },
        target: `task:${a.task_id}`,
      },
    );
  }
  function grantDto(g: GrantRow) {
    return assertContract('CapabilityGrant', {
      id: g.id,
      task_id: g.task_id,
      executor_principal_id: g.executor_principal_id,
      issued_by: g.issued_by,
      tool_id: g.tool_id,
      tool_version: g.tool_version,
      target_id: g.target_id,
      allow_execute: g.allow_execute,
      allow_disclosure: g.allow_disclosure,
      resource_versions: g.resource_versions,
      approver_principal_ids: g.approver_ids,
      budget: { currency: g.currency, limit_microunits: g.limit_microunits },
      status: g.status,
      revision: g.revision,
      expires_at: g.expires_at.toISOString(),
      created_at: g.created_at.toISOString(),
    });
  }
  async function dto(tx: Tx, auth: AuthContext, id: string) {
    const a = await action(tx, id);
    const t = await task(tx, a.task_id);
    await access(tx, t, auth.principalId);
    let restricted = false;
    try {
      await artifactBodies(tx, t, a.resource_versions, [auth.principalId]);
    } catch (error) {
      if (!(error instanceof ApplicationError) || ![403, 404, 409, 503].includes(error.status))
        throw error;
      restricted = true;
    }
    const p = (
      await sql<ApprovalRow>`select * from action_approvals where action_id=${id} and action_version=${a.approval_binding_version}`.execute(
        tx,
      )
    ).rows[0];
    return assertContract('Action', {
      id: a.id,
      task_id: a.task_id,
      requester_id: a.requester_id,
      executor_id: a.executor_id,
      grant_id: a.grant_id,
      grant_revision: a.grant_revision,
      tool_id: a.tool_id,
      tool_version: a.tool_version,
      target_id: a.target_id,
      parameters: restricted ? { text: '来源已不可用；正文已隐藏。' } : a.parameters,
      ...(restricted ? { content_restricted: true } : {}),
      resource_versions: a.resource_versions,
      business_key: a.business_key,
      fingerprint: a.fingerprint,
      status: a.status,
      version: a.version,
      approval_binding_version: a.approval_binding_version,
      approval_required: a.approval_required,
      required: a.required,
      attempt_count: a.attempt_count,
      estimate: { currency: a.currency, limit_microunits: a.estimate_microunits },
      ...(p
        ? {
            approval: {
              id: p.id,
              action_id: p.action_id,
              action_version: p.action_version,
              fingerprint: p.fingerprint,
              target_id: p.target_id,
              status: p.status,
              expires_at: p.expires_at.toISOString(),
              ...(p.decided_by ? { decided_by: p.decided_by } : {}),
              consumed: p.consumed_at !== null,
            },
          }
        : {}),
      created_at: a.created_at.toISOString(),
      view_scope: t.id,
      authz_generation: t.authz_generation,
      projection_id: a.id,
      projection_revision: a.version,
    });
  }
  async function createApproval(tx: Tx, a: ActionRow, g: GrantRow) {
    if (a.approval_required)
      await sql`insert into action_approvals(tenant_id,id,action_id,action_version,fingerprint,target_id,expires_at) values(${a.tenant_id},${randomUUID()},${a.id},${a.approval_binding_version},${a.fingerprint},${a.target_id},least(${g.expires_at}::timestamptz,clock_timestamp()+interval '1 hour'))`.execute(
        tx,
      );
  }
  function fingerprint(input: {
    taskId: string;
    executorId: string;
    grantId: string;
    grantRevision: string;
    toolId: string;
    toolVersion: string;
    targetId: string;
    parameters: C['ActionParameters'];
    resources: C['ActionResourceRef'][];
    currency: string;
    estimate: string;
  }) {
    return hash(input);
  }
  async function validateLease(tx: Tx, a: ActionRow, claim: ActionClaim) {
    const current = await now(tx);
    if (!a.lease_holder || !a.lease_expires_at) fail('LEASE_CONFLICT', 409);
    assertLeaseValid(
      {
        runId: a.id,
        holderId: a.lease_holder!,
        generation: BigInt(a.lease_generation),
        expiresAtMs: a.lease_expires_at!.getTime(),
      },
      {
        runId: claim.actionId,
        holderId: claim.holder,
        generation: BigInt(claim.generation),
        nowMs: current.getTime(),
      },
    );
    if (a.last_attempt_id !== claim.attemptId || a.fingerprint !== claim.fingerprint)
      fail('VERSION_CONFLICT', 409);
  }
  async function frozen(tenantId: string) {
    if (await journal.frozen(tenantId)) fail('SERVICE_UNAVAILABLE', 503);
  }
  async function recover(
    tenantId: string,
    reason: 'restore' | 'missing_action' = 'restore',
    frozenRecord?: FreezeRecord,
  ) {
    if (frozenRecord) await journal.append(frozenRecord);
    else await journal.freeze(tenantId, reason);
    const journalRecords = await journal.records(tenantId);
    const records = journalRecords.filter((r): r is IntentRecord => r.kind === 'intent');
    return txFor(tenantId, async (tx) => {
      await sql`insert into action_safety_fences(tenant_id,frozen,reason) values(${tenantId},true,${reason}) on conflict(tenant_id) do update set frozen=true,reason=excluded.reason,revision=action_safety_fences.revision+1,updated_at=clock_timestamp()`.execute(
        tx,
      );
      const cases = [];
      for (const intent of records) {
        if (await recoveredIntent(tx, intent, journalRecords)) continue;
        const found = (
          await sql<{
            id: string;
            action_id: string;
            fingerprint: string;
            lease_generation: string;
            status: string;
          }>`select id,action_id,fingerprint,lease_generation,status from action_attempts where id=${intent.attempt_id}`.execute(
            tx,
          )
        ).rows[0];
        const matches =
          found !== undefined &&
          found.action_id === intent.action_id &&
          found.fingerprint === intent.fingerprint &&
          found.lease_generation === intent.lease_generation;
        if (matches && ['succeeded', 'failed', 'cancelled'].includes(found.status)) continue;
        const id = randomUUID();
        const caseReason = !found
          ? 'missing_after_restore'
          : matches
            ? 'recovery_in_flight'
            : 'recovery_identity_conflict';
        await sql`insert into action_reconciliation_cases(tenant_id,id,action_id,attempt_id,reason,journal_record) values(${tenantId},${id},${intent.action_id},${intent.attempt_id},${caseReason},${json(intent)}::jsonb) on conflict(tenant_id,attempt_id) do update set status='open',reason=excluded.reason,journal_record=excluded.journal_record,version=action_reconciliation_cases.version+1,resolved_at=null,resolved_by=null`.execute(
          tx,
        );
        cases.push({ action_id: intent.action_id, attempt_id: intent.attempt_id, missing: !found });
      }
      return { frozen: true as const, cases };
    });
  }
  async function auditJournal(tenantId: string) {
    await frozen(tenantId);
    const journalRecords = await journal.records(tenantId);
    const records = journalRecords.filter((r): r is IntentRecord => r.kind === 'intent');
    const missing = await txFor(tenantId, async (tx) => {
      for (const intent of records) {
        if (await recoveredIntent(tx, intent, journalRecords)) continue;
        const found = (
          await sql<{
            fingerprint: string;
            lease_generation: string;
          }>`select fingerprint,lease_generation from action_attempts where id=${intent.attempt_id} and action_id=${intent.action_id}`.execute(
            tx,
          )
        ).rows[0];
        if (
          !found ||
          found.fingerprint !== intent.fingerprint ||
          found.lease_generation !== intent.lease_generation
        )
          return true;
      }
      return false;
    });
    if (missing) {
      await recover(tenantId, 'missing_action');
      fail('SERVICE_UNAVAILABLE', 503);
    }
  }
  async function record(claim: ActionClaim, observation: ToolObservation, allowRetry: boolean) {
    return txFor(claim.tenantId, async (tx) => {
      // Serialize receipt/case creation against freeze/unfreeze without blocking reconciliation.
      await sql`insert into action_safety_fences(tenant_id) values(${claim.tenantId}) on conflict do nothing`.execute(
        tx,
      );
      await sql`select 1 from action_safety_fences where tenant_id=${claim.tenantId} for share`.execute(
        tx,
      );
      const initial = await action(tx, claim.actionId);
      const chain = await lockedChain(tx, claim.tenantId, initial.task_id, false);
      if (initial.run_id)
        await sql`select 1 from agent_runs where id=${initial.run_id} for update`.execute(tx);
      const a = (
        await sql<ActionRow>`select * from actions where id=${claim.actionId} for update`.execute(
          tx,
        )
      ).rows[0]!;
      const attempt =
        (
          await sql<AttemptRow>`select * from action_attempts where id=${claim.attemptId} for update`.execute(
            tx,
          )
        ).rows[0] ?? fail('NOT_FOUND', 404);
      if (
        attempt.action_id !== a.id ||
        attempt.lease_generation !== claim.generation ||
        attempt.fingerprint !== claim.fingerprint
      )
        fail('LEASE_CONFLICT', 409);
      if (observation.status !== 'unknown') {
        if (
          !(await bindProviderReceipt(tx, {
            tenantId: a.tenant_id,
            toolId: a.tool_id,
            receiptId: observation.receiptId,
            actionId: a.id,
            attemptId: attempt.id,
            fingerprint: observation.fingerprint,
            outcome: observation.status,
            actualMicrounits: observation.actualMicrounits,
          }))
        )
          observation = { status: 'unknown', reason: 'invalid_response' };
      }
      if (observation.status !== 'unknown') {
        const existing = (
          await sql<{
            action_id: string;
            attempt_id: string;
            fingerprint: string;
            status: string;
            actual_microunits: string;
          }>`select * from action_receipts where tool_id=${a.tool_id} and external_id=${observation.receiptId}`.execute(
            tx,
          )
        ).rows[0];
        if (existing) {
          if (
            existing.action_id === a.id &&
            existing.attempt_id === attempt.id &&
            existing.fingerprint === observation.fingerprint &&
            existing.status === observation.status &&
            existing.actual_microunits === observation.actualMicrounits
          )
            return { status: a.status, conflict: false };
          observation = { status: 'unknown', reason: 'invalid_response' };
        }
      }
      if (!['executing', 'unknown'].includes(a.status) || a.last_attempt_id !== attempt.id) {
        await sql`insert into action_reconciliation_cases(tenant_id,id,action_id,attempt_id,reason) values(${a.tenant_id},${randomUUID()},${a.id},${attempt.id},'conflicting_late_receipt') on conflict(tenant_id,attempt_id) do update set status='open',reason='conflicting_late_receipt',resolved_at=null,resolved_by=null,version=action_reconciliation_cases.version+1`.execute(
          tx,
        );
        return { status: a.status, conflict: true };
      }
      if (observation.status === 'unknown') {
        if (attempt.status !== 'unknown') {
          const next = recordAttemptOutcome(asAttempt(attempt), {
            expectedVersion: BigInt(attempt.version),
            status: 'unknown',
            sideEffect: 'possible',
          });
          await saveAttempt(tx, next);
          await saveAction(tx, a.id, recordActionOutcome(asAction(a), next, BigInt(a.version)));
          await resolveActionBudget(tx, attempt.id, chain, { kind: 'unknown' });
          await event(tx, await action(tx, a.id), 'action.outcome_unknown');
        }
        await sql`insert into action_reconciliation_cases(tenant_id,id,action_id,attempt_id,reason) values(${a.tenant_id},${randomUUID()},${a.id},${attempt.id},${observation.reason}) on conflict(tenant_id,attempt_id) do nothing`.execute(
          tx,
        );
        return { status: 'unknown' as const, conflict: observation.reason === 'invalid_response' };
      }
      if (observation.fingerprint !== a.fingerprint) fail('VERSION_CONFLICT', 409);
      const nextAttempt = recordAttemptOutcome(asAttempt(attempt), {
        expectedVersion: BigInt(attempt.version),
        status: observation.status === 'succeeded' ? 'succeeded' : 'failed',
        sideEffect: observation.status === 'succeeded' ? 'confirmed' : 'none',
      });
      await saveAttempt(tx, nextAttempt);
      await sql`insert into action_receipts(tenant_id,id,action_id,attempt_id,tool_id,external_id,fingerprint,status,actual_microunits,evidence_hash) values(${a.tenant_id},${randomUUID()},${a.id},${attempt.id},${a.tool_id},${observation.receiptId},${a.fingerprint},${observation.status},${observation.actualMicrounits},${hash(observation)})`.execute(
        tx,
      );
      await resolveActionBudget(
        tx,
        attempt.id,
        chain,
        observation.status === 'succeeded'
          ? {
              kind: 'settle',
              actual: observation.actualMicrounits,
              usageKey: `${a.tool_id}:${observation.receiptId}`,
            }
          : { kind: 'release' },
      );
      const tool = registered(a.tool_id, a.tool_version, a.target_id);
      let nextAction: DomainAction;
      if (
        observation.status === 'no_effect' &&
        observation.safeRetry &&
        allowRetry &&
        a.status === 'executing' &&
        a.attempt_count < tool.definition.maxAttempts
      ) {
        nextAction = scheduleActionRetry(asAction(a), nextAttempt, {
          expectedVersion: BigInt(a.version),
          nextAttemptAtMs: (await now(tx)).getTime() + tool.definition.retryDelayMs,
          maxAttempts: tool.definition.maxAttempts,
          contractAllowsRetry: true,
          authorizationValid: true,
        });
      } else nextAction = recordActionOutcome(asAction(a), nextAttempt, BigInt(a.version));
      await saveAction(tx, a.id, nextAction);
      await sql`update actions set lease_holder=null,lease_expires_at=null where id=${a.id}`.execute(
        tx,
      );
      await sql`update action_reconciliation_cases set status='resolved',resolved_at=clock_timestamp(),version=version+1 where attempt_id=${attempt.id}`.execute(
        tx,
      );
      await event(
        tx,
        await action(tx, a.id),
        nextAction.status === 'ready' ? 'action.retry_scheduled' : `action.${nextAction.status}`,
      );
      return { status: nextAction.status, conflict: false };
    });
  }
  async function prepareInTransaction(
    tx: Tx,
    auth: AuthContext,
    input: C['CreateActionInput'],
    runId: string | null = null,
  ) {
    const requester = await principal(tx, auth.principalId);
    const executor = await principal(tx, input.executor_principal_id);
    const install = await installation(tx, executor);
    const chain = await lockedChain(tx, auth.tenantId, input.task_id);
    const t = chain.at(-1)!;
    const requesterRole = await access(tx, t, auth.principalId);
    const executorRole = await access(tx, t, executor.principal_id);
    if (
      !['owner', 'contributor'].includes(requesterRole.role) ||
      !['owner', 'contributor'].includes(executorRole.role) ||
      t.status !== 'active'
    )
      fail('FORBIDDEN', 403);
    await validateResources(
      tx,
      t,
      input.resource_versions,
      [auth.principalId, input.executor_principal_id],
      input.parameters,
    );
    const g = await grant(tx, input.grant_id);
    const tool = registered(input.tool_id, input.tool_version, input.target_id);
    if (
      input.estimate.currency !== tool.definition.currency ||
      BigInt(input.estimate.limit_microunits) < BigInt(tool.definition.estimateMicrounits)
    )
      fail('VALIDATION_FAILED', 400);
    const data = {
      taskId: t.id,
      executorId: executor.principal_id,
      grantId: g.id,
      grantRevision: g.revision,
      toolId: input.tool_id,
      toolVersion: input.tool_version,
      targetId: input.target_id,
      parameters: input.parameters,
      resources: input.resource_versions,
      currency: input.estimate.currency,
      estimate: input.estimate.limit_microunits,
    };
    const fp = fingerprint(data);
    if (
      (
        await sql`select 1 from action_recovery_tombstones where business_key=${input.business_key}`.execute(
          tx,
        )
      ).rows.length
    )
      fail('IDEMPOTENCY_CONFLICT', 409);
    const existing = (
      await sql<ActionRow>`select * from actions where business_key=${input.business_key}`.execute(
        tx,
      )
    ).rows[0];
    if (existing) {
      if (existing.fingerprint !== fp || existing.requester_id !== auth.principalId)
        fail('IDEMPOTENCY_CONFLICT', 409);
      return existing.id;
    }
    const id = randomUUID();
    const initial = newAction({
      id,
      taskId: t.id,
      businessKey: input.business_key,
      parameterFingerprint: fp,
    });
    if (runId && !tool.definition.approvalRequired) fail('FORBIDDEN', 403);
    const state = prepareAction(initial, initial.version, tool.definition.approvalRequired);
    await grantCurrent(tx, {
      grant_id: g.id,
      grant_revision: g.revision,
      task_id: t.id,
      executor_id: executor.principal_id,
      tool_id: input.tool_id,
      tool_version: input.tool_version,
      target_id: input.target_id,
      currency: input.estimate.currency,
      estimate_microunits: input.estimate.limit_microunits,
      resource_versions: input.resource_versions,
    });
    await sql`insert into actions(tenant_id,id,task_id,root_task_id,requester_id,requester_revision,executor_id,executor_revision,executor_installation_id,executor_installation_revision,grant_id,grant_revision,ancestor_fences,resource_versions,tool_id,tool_version,target_id,parameters,fingerprint,business_key,status,version,approval_binding_version,approval_required,required,currency,estimate_microunits) values(${auth.tenantId},${id},${t.id},${t.root_task_id},${auth.principalId},${requester.authz_revision},${executor.principal_id},${executor.authz_revision},${install?.id ?? null},${install?.authz_revision ?? null},${g.id},${g.revision},${json(chain.map((item) => ({ taskId: item.id, executionEpoch: item.execution_epoch })))}::jsonb,${json(input.resource_versions)}::jsonb,${input.tool_id},${input.tool_version},${input.target_id},${json(input.parameters)}::jsonb,${fp},${input.business_key},${state.status},${state.version.toString()},${state.version.toString()},${tool.definition.approvalRequired},${input.required ?? true},${input.estimate.currency},${input.estimate.limit_microunits})`.execute(
      tx,
    );
    await sql`update actions set authority_snapshot=${json({ requester: await authority(tx, t, auth.principalId), executor: await authority(tx, t, executor.principal_id) })}::jsonb where id=${id}`.execute(
      tx,
    );
    if (runId) await sql`update actions set run_id=${runId} where id=${id}`.execute(tx);
    const a = await action(tx, id);
    await event(tx, { ...a, version: '1', status: 'proposed' }, 'action.proposed');
    await createApproval(tx, a, g);
    await event(tx, a, 'action.prepared');
    return id;
  }
  const service = {
    async createGrant(auth: AuthContext, input: C['CreateGrantInput'], key: string) {
      assertContract('CreateGrantInput', input);
      return transaction(auth, async (tx) => {
        const id = await command(tx, auth, 'grant.create', key, input, async () => {
          const chain = await lockedChain(tx, auth.tenantId, input.task_id);
          const t = chain.at(-1)!;
          await admin(tx, auth, t);
          registered(input.tool_id, input.tool_version, input.target_id);
          await validateResources(tx, t, input.resource_versions, [
            auth.principalId,
            input.executor_principal_id,
          ]);
          const executor = await principal(tx, input.executor_principal_id);
          await installation(tx, executor);
          const participant = await access(tx, t, executor.principal_id);
          if (!['owner', 'contributor'].includes(participant.role)) fail('FORBIDDEN', 403);
          for (const id of [...input.approver_principal_ids].sort()) {
            const human = await principal(tx, id);
            const p = await access(tx, t, id);
            if (human.kind !== 'human' || !['owner', 'reviewer'].includes(p.role))
              fail('FORBIDDEN', 403);
          }
          if (Date.parse(input.expires_at) <= (await now(tx)).getTime())
            fail('REQUEST_EXPIRED', 410);
          const id = randomUUID();
          await sql`insert into capability_grants(tenant_id,id,task_id,executor_principal_id,issued_by,tool_id,tool_version,target_id,allow_execute,allow_disclosure,resource_versions,approver_ids,currency,limit_microunits,expires_at) values(${auth.tenantId},${id},${t.id},${executor.principal_id},${auth.principalId},${input.tool_id},${input.tool_version},${input.target_id},${input.allow_execute},${input.allow_disclosure},${json(input.resource_versions)}::jsonb,${json(input.approver_principal_ids)}::jsonb,${input.budget.currency},${input.budget.limit_microunits},${input.expires_at})`.execute(
            tx,
          );
          await sql`update capability_grants set ancestor_fences=${json(chain.map((item) => ({ taskId: item.id, executionEpoch: item.execution_epoch })))}::jsonb,authority_snapshot=${json({ issuer: await authority(tx, t, auth.principalId), executor: await authority(tx, t, executor.principal_id) })}::jsonb where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'grant',
            aggregateId: id,
            version: '1',
            type: 'grant.created',
            payload: { task_id: t.id },
            target: `task:${t.id}`,
          });
          return id;
        });
        const g = await grant(tx, id);
        await access(tx, await task(tx, g.task_id), auth.principalId);
        return grantDto(g);
      });
    },
    async getGrant(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        const g = await grant(tx, id);
        await access(tx, await task(tx, g.task_id), auth.principalId);
        return grantDto(g);
      });
    },
    async listGrants(auth: AuthContext) {
      return transaction(auth, async (tx) => {
        const rows = (
          await sql<GrantRow>`select g.* from capability_grants g join task_participants p on p.tenant_id=g.tenant_id and p.task_id=g.task_id join tasks t on t.id=g.task_id and t.tenant_id=g.tenant_id join memberships m on m.tenant_id=t.tenant_id and m.workspace_id=t.workspace_id and m.principal_id=p.principal_id where p.principal_id=${auth.principalId} and p.status='active' and m.status='active' order by g.id limit 200`.execute(
            tx,
          )
        ).rows;
        return assertContract('CapabilityGrantPage', { items: rows.map(grantDto) });
      });
    },
    async revokeGrant(
      auth: AuthContext,
      id: string,
      version: string,
      key: string,
      reason = 'Grant revoked by an authorized administrator',
    ) {
      assertContract('TaskReasonInput', { reason });
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'grant.revoke', key, { id, version, reason }, async () => {
          const before = await grant(tx, id);
          await admin(tx, auth, await task(tx, before.task_id));
          const current = (
            await sql<GrantRow>`select * from capability_grants where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          expectedVersion(current.revision, version);
          if (current.status !== 'active') fail('VERSION_CONFLICT', 409);
          await sql`update capability_grants set status='revoked',revision=revision+1,revoked_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await appendEvent(tx, auth, {
            aggregateType: 'grant',
            aggregateId: id,
            version: (BigInt(version) + 1n).toString(),
            type: 'grant.revoked',
            payload: { task_id: current.task_id, reason },
            target: `task:${current.task_id}`,
          });
          return id;
        });
        const g = await grant(tx, id);
        await access(tx, await task(tx, g.task_id), auth.principalId);
        return grantDto(g);
      });
    },
    async proposeForRun(claim: LeaseClaim, text: string, machine?: AuthContext) {
      assertContract('ActionParameters', { text });
      await frozen(claim.tenantId);
      return txFor(claim.tenantId, async (tx) => {
        await safety(tx, claim.tenantId);
        const requestHash = hash({ text });
        const { run, actors, items } = await lockRunToolAuthority(
          tx,
          claim,
          options.sources,
          machine,
          requestHash,
        );
        const prior = (
          await sql<{
            action_id: string;
            request_hash: string;
          }>`select action_id,request_hash from run_tool_intents where run_id=${run.id}`.execute(tx)
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 409);
          return dto(tx, actors.agent, prior.action_id);
        }
        const g = await grant(tx, run.tool_grant_id!);
        if (g.revision !== run.tool_grant_revision) fail('FORBIDDEN', 403);
        const tool = registered(g.tool_id, g.tool_version, g.target_id);
        const actionId = await prepareInTransaction(
          tx,
          actors.agent,
          {
            task_id: run.task_id!,
            grant_id: g.id,
            executor_principal_id: actors.agent.principalId,
            tool_id: g.tool_id,
            tool_version: g.tool_version,
            target_id: g.target_id,
            parameters: { text },
            resource_versions: items.map((item) => ({
              type: 'task' as const,
              id: item.source_id,
              version: item.source_version,
            })),
            business_key: `run.${run.id}.tool.1`,
            estimate: {
              currency: g.currency,
              limit_microunits: tool.definition.estimateMicrounits,
            },
            required: true,
          },
          run.id,
        );
        await assertRunToolLease(tx, run, claim);
        await sql`insert into run_tool_intents(tenant_id,run_id,action_id,request_hash,lease_generation,lease_holder) values(${claim.tenantId},${run.id},${actionId},${requestHash},${claim.generation},${claim.holder})`.execute(
          tx,
        );
        const updated = (
          await sql<{
            version: string;
          }>`update agent_runs set status='waiting_approval',version=version+1,lease_holder=null,lease_expires_at=null,summary='A proposed tool Action is waiting for human approval and explicit resume.',updated_at=clock_timestamp() where id=${run.id} returning version`.execute(
            tx,
          )
        ).rows[0]!;
        await appendEvent(tx, actors.creator, {
          aggregateType: 'agent_run',
          aggregateId: run.id,
          version: updated.version,
          type: 'run.waiting_approval',
          payload: { action_id: actionId },
          target: `run:${run.id}`,
        });
        return dto(tx, actors.agent, actionId);
      });
    },
    async getRunToolAction(claim: LeaseClaim, machine?: AuthContext) {
      await frozen(claim.tenantId);
      return txFor(claim.tenantId, async (tx) => {
        await safety(tx, claim.tenantId);
        const { actors } = await lockRunToolAuthority(tx, claim, options.sources, machine);
        const binding = await runToolState(tx, claim.runId);
        if (!binding) fail('NOT_FOUND', 404);
        return dto(tx, actors.agent, binding.action_id);
      });
    },
    async getRunIntent(auth: AuthContext, runId: string) {
      return transaction(auth, async (tx) => {
        const allowed = (
          await sql`select 1 from agent_runs r join agent_installations a on a.tenant_id=r.tenant_id and a.id=r.agent_id where r.id=${runId} and (r.created_by=${auth.principalId} or a.agent_principal_id=${auth.principalId})`.execute(
            tx,
          )
        ).rows.length;
        if (!allowed) fail('NOT_FOUND', 404);
        const binding = await runToolState(tx, runId);
        if (!binding) fail('NOT_FOUND', 404);
        return dto(tx, auth, binding.action_id);
      });
    },
    async createAction(auth: AuthContext, input: C['CreateActionInput'], key: string) {
      assertContract('CreateActionInput', input);
      if (auth.machine) fail('FORBIDDEN', 403);
      await frozen(auth.tenantId);
      return transaction(auth, async (tx) => {
        await safety(tx, auth.tenantId);
        const id = await command(tx, auth, 'action.create', key, input, async () => {
          return prepareInTransaction(tx, auth, input);
        });
        return dto(tx, auth, id);
      });
    },
    async getAction(auth: AuthContext, id: string) {
      return transaction(auth, (tx) => dto(tx, auth, id));
    },
    async listActions(auth: AuthContext, query: { cursor?: string; limit?: number } = {}) {
      return transaction(auth, async (tx) => {
        const limit = Math.min(200, Math.max(1, query.limit ?? 50));
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:actions`;
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
          }>`select a.id from actions a join task_participants p on p.tenant_id=a.tenant_id and p.task_id=a.task_id join tasks t on t.id=a.task_id and t.tenant_id=a.tenant_id join memberships m on m.tenant_id=t.tenant_id and m.workspace_id=t.workspace_id and m.principal_id=p.principal_id where p.principal_id=${auth.principalId} and p.status='active' and m.status='active' and a.id>${after}::uuid order by a.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const r of rows.slice(0, limit)) items.push(await dto(tx, auth, r.id));
        return assertContract('ActionPage', {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        });
      });
    },
    async reviseAction(
      auth: AuthContext,
      id: string,
      input: C['ReviseActionInput'],
      version: string,
      key: string,
    ) {
      assertContract('ReviseActionInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'action.revise', key, { id, input, version }, async () => {
          const pre = await action(tx, id);
          if (pre.run_id) fail('FORBIDDEN', 403);
          await actors(tx, pre);
          const chain = await lockedChain(tx, auth.tenantId, pre.task_id);
          const t = chain.at(-1)!;
          await access(tx, t, auth.principalId);
          const a = (
            await sql<ActionRow>`select * from actions where id=${id} for update`.execute(tx)
          ).rows[0]!;
          if (a.requester_id !== auth.principalId) fail('FORBIDDEN', 403);
          expectedVersion(a.version, version);
          if (a.attempt_count !== 0 || !['awaiting_approval', 'ready'].includes(a.status))
            fail('INVALID_STATE_TRANSITION', 409);
          await validateResources(
            tx,
            t,
            input.resource_versions,
            [auth.principalId, a.executor_id],
            input.parameters,
          );
          const g = await verifyAdmission(tx, a, chain);
          const fp = fingerprint({
            taskId: a.task_id,
            executorId: a.executor_id,
            grantId: a.grant_id,
            grantRevision: a.grant_revision,
            toolId: a.tool_id,
            toolVersion: a.tool_version,
            targetId: a.target_id,
            parameters: input.parameters,
            resources: input.resource_versions,
            currency: a.currency,
            estimate: a.estimate_microunits,
          });
          for (const ref of input.resource_versions)
            if (!g.resource_versions.some((v) => sameReference(v, ref)))
              fail('DISCLOSURE_DENIED', 403);
          const nextVersion = (BigInt(a.version) + 1n).toString();
          await sql`update action_approvals set status='revoked' where action_id=${id} and status in ('pending','approved')`.execute(
            tx,
          );
          await sql`update actions set parameters=${json(input.parameters)}::jsonb,resource_versions=${json(input.resource_versions)}::jsonb,fingerprint=${fp},version=${nextVersion},approval_binding_version=${nextVersion},status=${a.approval_required ? 'awaiting_approval' : 'ready'},ancestor_fences=${json(chain.map((t) => ({ taskId: t.id, executionEpoch: t.execution_epoch })))}::jsonb,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          const updated = await action(tx, id);
          await createApproval(tx, updated, g);
          await event(tx, updated, 'action.parameters_revised');
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async decideApproval(
      auth: AuthContext,
      id: string,
      input: C['ActionApprovalDecisionInput'],
      version: string,
      key: string,
    ) {
      assertContract('ActionApprovalDecisionInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'action.approval', key, { id, input, version }, async () => {
          const pre = await action(tx, id);
          const human = await principal(tx, auth.principalId);
          if (human.kind !== 'human') fail('FORBIDDEN', 403);
          await actors(tx, pre);
          const chain = await lockedChain(tx, auth.tenantId, pre.task_id);
          const t = chain.at(-1)!;
          const role = await access(tx, t, auth.principalId);
          if (!['owner', 'reviewer'].includes(role.role)) fail('FORBIDDEN', 403);
          const a = (
            await sql<ActionRow>`select * from actions where id=${id} for update`.execute(tx)
          ).rows[0]!;
          expectedVersion(a.version, version);
          const g = await verifyAdmission(tx, a, chain);
          const p = await approval(tx, a);
          if (
            !p ||
            p.status !== 'pending' ||
            p.expires_at <= (await now(tx)) ||
            !g.approver_ids.includes(auth.principalId) ||
            input.action_version !== p.action_version ||
            input.fingerprint !== p.fingerprint ||
            p.fingerprint !== a.fingerprint
          )
            fail('VERSION_CONFLICT', 409);
          const next =
            input.decision === 'approve'
              ? approveAction(asAction(a), BigInt(version))
              : cancelAction(asAction(a), BigInt(version));
          await sql`update action_approvals set status=${input.decision === 'approve' ? 'approved' : 'rejected'},decided_by=${auth.principalId},decided_at=clock_timestamp(),comment=${input.comment} where id=${p.id}`.execute(
            tx,
          );
          await sql`update action_approvals set authority_snapshot=${json(await authority(tx, t, auth.principalId))}::jsonb where id=${p.id}`.execute(
            tx,
          );
          await event(
            tx,
            await saveAction(tx, id, next),
            `action.${input.decision === 'approve' ? 'approved' : 'rejected'}`,
          );
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async cancel(
      auth: AuthContext,
      id: string,
      version: string,
      key: string,
      reason = 'Action cancelled by its authorized requester',
    ) {
      assertContract('TaskReasonInput', { reason });
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'action.cancel', key, { id, version, reason }, async () => {
          const pre = await action(tx, id);
          await lockedChain(tx, auth.tenantId, pre.task_id, false);
          const t = await task(tx, pre.task_id);
          await access(tx, t, auth.principalId);
          if (![pre.requester_id, t.owner_principal_id].includes(auth.principalId))
            fail('FORBIDDEN', 403);
          const a = (
            await sql<ActionRow>`select * from actions where id=${id} for update`.execute(tx)
          ).rows[0]!;
          const next = cancelAction(asAction(a), BigInt(version));
          const updated = await saveAction(tx, id, next);
          await appendEvent(tx, auth, {
            aggregateType: 'action',
            aggregateId: id,
            version: updated.version,
            type: 'action.cancelled',
            payload: { task_id: t.id, status: updated.status, reason },
            target: `task:${t.id}`,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async claim(
      tenantId: string,
      actionId: string,
      holder: string,
      runClaim?: LeaseClaim,
      machine?: AuthContext,
    ): Promise<ActionClaim> {
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(holder)) fail('VALIDATION_FAILED', 400);
      await auditJournal(tenantId);
      return txFor(tenantId, async (tx) => {
        await safety(tx, tenantId);
        const pre = await action(tx, actionId);
        if (
          (
            await sql`select 1 from action_recovery_tombstones where action_id=${pre.id} or business_key=${pre.business_key}`.execute(
              tx,
            )
          ).rows.length
        )
          fail('IDEMPOTENCY_CONFLICT', 409);
        if (pre.run_id) {
          const bound = runClaim;
          if (!bound || bound.runId !== pre.run_id) fail('FORBIDDEN', 403);
          await lockRunToolAuthority(tx, bound, options.sources, machine);
        } else if (runClaim) fail('FORBIDDEN', 403);
        await actors(tx, pre);
        const chain = await lockedChain(tx, tenantId, pre.task_id);
        const a = (
          await sql<ActionRow>`select * from actions where id=${actionId} for update`.execute(tx)
        ).rows[0]!;
        const grant = await verifyAdmission(tx, a, chain);
        await approved(tx, a, grant, chain.at(-1)!);
        const tool = registered(a.tool_id, a.tool_version, a.target_id);
        if (a.attempt_count >= tool.definition.maxAttempts) fail('RETRY_EXHAUSTED', 409);
        const time = await now(tx);
        const lease = acquireLease(
          a.lease_holder && a.lease_expires_at
            ? {
                runId: a.id,
                holderId: a.lease_holder,
                generation: BigInt(a.lease_generation),
                expiresAtMs: a.lease_expires_at.getTime(),
              }
            : null,
          { runId: a.id, holderId: holder, nowMs: time.getTime(), ttlMs: leaseSeconds * 1000 },
        );
        const generation = (BigInt(a.lease_generation) + 1n).toString();
        const attemptId = randomUUID();
        const next = startActionAttempt(asAction(a), {
          expectedVersion: BigInt(a.version),
          attemptId,
          nowMs: time.getTime(),
        });
        await saveAction(tx, a.id, next.action);
        await sql`update actions set lease_holder=${holder},lease_generation=${generation},lease_expires_at=${new Date(lease.expiresAtMs)} where id=${a.id}`.execute(
          tx,
        );
        await sql`insert into action_attempts(tenant_id,id,action_id,attempt_no,status,side_effect,lease_generation,fingerprint) values(${tenantId},${attemptId},${a.id},${next.attempt.attemptNo},'prepared','not_attempted',${generation},${a.fingerprint})`.execute(
          tx,
        );
        await reserveActionBudget(tx, tenantId, a, attemptId, chain);
        if (runClaim) {
          const bound = (await lockRunToolAuthority(tx, runClaim, options.sources, machine)).run;
          await assertRunToolLease(tx, bound, runClaim);
        }
        await event(tx, await action(tx, a.id), 'action.attempt_prepared');
        return {
          tenantId,
          actionId: a.id,
          attemptId,
          holder,
          generation,
          fingerprint: a.fingerprint,
          ...(runClaim ? { runClaim } : {}),
          ...(machine ? { machine } : {}),
        };
      });
    },
    async dispatch(claim: ActionClaim) {
      await frozen(claim.tenantId);
      return txFor(claim.tenantId, async (tx) => {
        await safety(tx, claim.tenantId);
        const pre = await action(tx, claim.actionId);
        if (
          (
            await sql`select 1 from action_recovery_tombstones where action_id=${pre.id} or business_key=${pre.business_key}`.execute(
              tx,
            )
          ).rows.length
        )
          fail('IDEMPOTENCY_CONFLICT', 409);
        if (pre.run_id) {
          const bound = claim.runClaim;
          if (!bound || bound.runId !== pre.run_id) fail('FORBIDDEN', 403);
          await lockRunToolAuthority(tx, bound, options.sources, claim.machine);
        } else if (claim.runClaim) fail('FORBIDDEN', 403);
        await actors(tx, pre);
        const chain = await lockedChain(tx, claim.tenantId, pre.task_id);
        const a = (
          await sql<ActionRow>`select * from actions where id=${claim.actionId} for update`.execute(
            tx,
          )
        ).rows[0]!;
        await validateLease(tx, a, claim);
        const g = await verifyAdmission(tx, a, chain);
        await approved(tx, a, g, chain.at(-1)!);
        const attempt = (
          await sql<AttemptRow>`select * from action_attempts where id=${claim.attemptId} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (!attempt.journal_intent_id) fail('SERVICE_UNAVAILABLE', 503);
        if (claim.runClaim)
          await lockRunToolAuthority(tx, claim.runClaim, options.sources, claim.machine);
        await saveAttempt(tx, dispatchActionAttempt(asAttempt(attempt), BigInt(attempt.version)));
        return {
          tool: registered(a.tool_id, a.tool_version, a.target_id),
          call: {
            businessKey: a.business_key,
            fingerprint: a.fingerprint,
            parameters: a.parameters,
            identity: { tenantId: claim.tenantId, actionId: a.id, attemptId: attempt.id },
          },
        };
      });
    },
    async persistIntent(claim: ActionClaim) {
      let record = await txFor(claim.tenantId, async (tx): Promise<IntentRecord> => {
        const a =
          (
            await sql<ActionRow>`select * from actions where id=${claim.actionId} for share`.execute(
              tx,
            )
          ).rows[0] ?? fail('NOT_FOUND', 404);
        await validateLease(tx, a, claim);
        const attempt =
          (
            await sql<
              AttemptRow & { created_at: Date }
            >`select * from action_attempts where id=${claim.attemptId} and action_id=${claim.actionId} for share`.execute(
              tx,
            )
          ).rows[0] ?? fail('NOT_FOUND', 404);
        if (
          attempt.lease_generation !== claim.generation ||
          attempt.fingerprint !== claim.fingerprint ||
          !['prepared', 'in_flight'].includes(attempt.status)
        )
          fail('VERSION_CONFLICT', 409);
        return {
          kind: 'intent',
          id: claim.attemptId,
          tenant_id: claim.tenantId,
          action_id: a.id,
          attempt_id: claim.attemptId,
          task_id: a.task_id,
          action_version: a.version,
          lease_generation: claim.generation,
          fingerprint: a.fingerprint,
          business_key: a.business_key,
          tool_id: a.tool_id,
          tool_version: a.tool_version,
          budget_account_ids: a.ancestor_fences.map((fence) => fence.taskId),
          ...(a.run_id ? { run_id: a.run_id } : {}),
          target_id: a.target_id,
          currency: a.currency,
          estimate_microunits: a.estimate_microunits,
          // The journal record identity is the attempt, so its timestamp must survive retries.
          created_at: attempt.created_at.toISOString(),
        };
      });
      const previous = (await journal.records(claim.tenantId)).find(
        (item) => item.id === record.id,
      );
      if (previous?.kind === 'intent') {
        const compatible = { ...record };
        if (previous.tool_version === undefined) delete compatible.tool_version;
        if (previous.budget_account_ids === undefined) delete compatible.budget_account_ids;
        if (canonical(previous) !== canonical(compatible)) fail('IDEMPOTENCY_CONFLICT', 409);
        record = previous;
      }
      await journal.append(record);
      await txFor(claim.tenantId, async (tx) => {
        const current =
          (
            await sql<ActionRow>`select * from actions where id=${claim.actionId} for update`.execute(
              tx,
            )
          ).rows[0] ?? fail('NOT_FOUND', 404);
        await validateLease(tx, current, claim);
        const updated =
          await sql`update action_attempts set journal_intent_id=${record.id} where id=${claim.attemptId} and action_id=${claim.actionId} and lease_generation=${claim.generation} and fingerprint=${claim.fingerprint} and (journal_intent_id is null or journal_intent_id=${record.id}) returning id`.execute(
            tx,
          );
        if (updated.rows.length !== 1) fail('VERSION_CONFLICT', 409);
      });
      return record;
    },
    async recordOutcome(claim: ActionClaim, observation: ToolObservation, allowRetry = true) {
      await journal.append({
        kind: 'receipt',
        id: randomUUID(),
        tenant_id: claim.tenantId,
        action_id: claim.actionId,
        attempt_id: claim.attemptId,
        fingerprint: claim.fingerprint,
        outcome: observation.status,
        ...(observation.status !== 'unknown'
          ? { receipt_id: observation.receiptId, actual_microunits: observation.actualMicrounits }
          : {}),
        created_at: new Date().toISOString(),
      });
      return record(claim, observation, allowRetry);
    },
    async abortPrepared(claim: ActionClaim) {
      return txFor(claim.tenantId, async (tx) => {
        const pre = await action(tx, claim.actionId);
        const chain = await lockedChain(tx, claim.tenantId, pre.task_id, false);
        if (pre.run_id)
          await sql`select 1 from agent_runs where id=${pre.run_id} for update`.execute(tx);
        const a = (
          await sql<ActionRow>`select * from actions where id=${claim.actionId} for update`.execute(
            tx,
          )
        ).rows[0]!;
        const attempt = (
          await sql<AttemptRow>`select * from action_attempts where id=${claim.attemptId} for update`.execute(
            tx,
          )
        ).rows[0]!;
        if (
          attempt.status !== 'prepared' ||
          attempt.lease_generation !== claim.generation ||
          a.last_attempt_id !== attempt.id
        )
          fail('VERSION_CONFLICT', 409);
        const next = recordAttemptOutcome(asAttempt(attempt), {
          expectedVersion: BigInt(attempt.version),
          status: 'failed',
          sideEffect: 'none',
        });
        await saveAttempt(tx, next);
        await resolveActionBudget(tx, attempt.id, chain, { kind: 'release' });
        await saveAction(tx, a.id, recordActionOutcome(asAction(a), next, BigInt(a.version)));
        await sql`update actions set lease_holder=null,lease_expires_at=null where id=${a.id}`.execute(
          tx,
        );
        await event(tx, await action(tx, a.id), 'action.dispatch_denied');
      });
    },
    async reconcile(
      auth: AuthContext,
      id: string,
      input: C['ActionReconcileInput'],
      version: string,
      key: string,
    ) {
      assertContract('ActionReconcileInput', input);
      const reference = await transaction(auth, async (tx) => {
        const a = await action(tx, id);
        const t = await task(tx, a.task_id);
        const role = await access(tx, t, auth.principalId);
        if (
          ![a.requester_id, t.owner_principal_id].includes(auth.principalId) ||
          !['owner', 'contributor'].includes(role.role)
        )
          fail('FORBIDDEN', 403);
        await command(tx, auth, 'action.reconcile', key, { id, input, version }, async () => {
          expectedVersion(a.version, version);
          if (a.status !== 'unknown' || !a.last_attempt_id) fail('INVALID_STATE_TRANSITION', 409);
          return id;
        });
        return a;
      });
      if (reference.status !== 'unknown')
        return transaction(auth, async (tx) => {
          const conflict =
            (
              await sql`select id from action_reconciliation_cases where action_id=${id} and status='open'`.execute(
                tx,
              )
            ).rows.length > 0;
          return assertContract('ActionReconciliation', {
            action: await dto(tx, auth, id),
            outcome: conflict
              ? 'conflict'
              : reference.status === 'succeeded'
                ? 'succeeded'
                : reference.status === 'failed'
                  ? 'no_effect'
                  : 'unknown',
          });
        });
      const tool = registered(reference.tool_id, reference.tool_version, reference.target_id);
      const observation = await tool.lookup({
        businessKey: reference.business_key,
        fingerprint: reference.fingerprint,
      });
      const claim = {
        tenantId: auth.tenantId,
        actionId: id,
        attemptId: reference.last_attempt_id!,
        holder: reference.lease_holder ?? 'reconcile',
        generation: reference.lease_generation,
        fingerprint: reference.fingerprint,
      };
      const result = await service.recordOutcome(claim, observation, false);
      return transaction(auth, async (tx) =>
        assertContract('ActionReconciliation', {
          action: await dto(tx, auth, id),
          outcome: result.conflict ? 'conflict' : observation.status,
        }),
      );
    },
    async recover(tenantId: string) {
      return recover(tenantId);
    },
    auditJournal,
    async pending(tenantId: string) {
      return txFor(tenantId, async (tx) =>
        (
          await sql<{
            id: string;
          }>`select id from actions where run_id is null and status='ready' and (next_attempt_at is null or next_attempt_at<=clock_timestamp()) order by created_at,id limit 50`.execute(
            tx,
          )
        ).rows.map((r) => r.id),
      );
    },
    async expireLeases(tenantId: string) {
      const stale = await txFor(
        tenantId,
        async (tx) =>
          (
            await sql<ActionRow>`select * from actions where status='executing' and lease_expires_at<=clock_timestamp() order by id limit 100`.execute(
              tx,
            )
          ).rows,
      );
      for (const a of stale)
        if (a.last_attempt_id)
          await service.recordOutcome(
            {
              tenantId,
              actionId: a.id,
              attemptId: a.last_attempt_id,
              holder: a.lease_holder ?? 'expired',
              generation: a.lease_generation,
              fingerprint: a.fingerprint,
            },
            { status: 'unknown', reason: 'timeout_or_disconnect' },
            false,
          );
      return stale.length;
    },
  };
  return {
    ...service,
    recovery: createActionRecoveryService({
      db,
      tools,
      journal,
      cursorSecret: options.cursorSecret,
      recover,
    }),
  };
}
export type ActionService = ReturnType<typeof createActionService>;
/** Unknown blocks even optional work; required actions must have a verified successful result. */
export async function requiredActionsClosed(tx: Tx, taskId: string): Promise<boolean> {
  const result = (
    await sql<{
      blocked: boolean;
    }>`with recursive tree as (select id from tasks where id=${taskId} union all select t.id from tasks t join tree p on t.parent_task_id=p.id) select exists(select 1 from actions a where a.task_id in(select id from tree) and (a.status in ('executing','unknown') or (a.required and a.status<>'succeeded'))) or exists(select 1 from action_reconciliation_cases c join actions a on a.id=c.action_id where c.status='open' and a.task_id in(select id from tree)) or exists(select 1 from action_safety_fences where frozen=true) as blocked`.execute(
      tx,
    )
  ).rows[0]!;
  return !result.blocked;
}
