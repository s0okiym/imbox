import { recordPolicy, type PolicyLedger } from './policy-ledger.js';
import type { RunPromotionPort } from './run-promotion-port.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactEvidencePort } from './resource-ports.js';
import { assertContract, type ContractTypes } from '@imbox/contracts';
import {
  lockDependencyGraph,
  lockTaskRoots,
  sql,
  withTenant,
  type Db,
  type TenantTransaction,
} from '@imbox/db';
import {
  acceptTaskHandoff,
  advanceTask,
  blockTask,
  createTask as newDomainTask,
  createRequest as newDomainRequest,
  DomainError,
  isTerminalTaskStatus,
  reopenTask as domainReopen,
  resumeTask,
  reviseRequestProposal,
  terminateTask,
  transitionRequest,
  addTaskDependency,
  assertTaskFencesCurrent,
  type Task as DomainTask,
  type TaskStatus,
  type CollaborationRequest as DomainRequest,
  type RequestStatus,
} from '@imbox/domain';
import {
  appendEvent,
  authorizeTenant,
  authorizeConversation,
  command,
  CursorCodec,
  expectedVersion,
  fail,
  ApplicationError,
  type AuthContext,
} from './common.js';

type C = ContractTypes;
type Tx = TenantTransaction;
type PageQuery = { cursor?: string; limit?: number };
type TaskRow = {
  tenant_id: string;
  id: string;
  workspace_id: string | null;
  root_task_id: string;
  parent_task_id: string | null;
  title: string;
  goal: string;
  acceptance_criteria: string[];
  reviewer_ids: string[];
  owner_principal_id: string;
  accountable_principal_id: string;
  created_by: string;
  status: TaskStatus;
  version: string;
  goal_version: string;
  execution_epoch: string;
  authz_generation: string;
  archived: boolean;
  blocked_from: 'open' | 'active' | 'in_review' | null;
  state_reason: string | null;
  due_at: Date | null;
  execution_deadline: Date | null;
  created_at: Date;
};
type Fence = { taskId: string; executionEpoch: string };
type RequestRow = {
  ancestor_fences: Fence[];
  id: string;
  task_id: string;
  kind: 'consult' | 'review' | 'delegate' | 'handoff';
  requester_principal_id: string;
  recipient_principal_id: string;
  status: string;
  proposal: C['WorkProposal'];
  proposal_version: string;
  expected_task_version: string;
  task_epoch: string;
  goal_version: string;
  expires_at: Date;
  version: string;
  created_at: Date;
};
type Participant = {
  principal_id: string;
  role: 'owner' | 'contributor' | 'reviewer' | 'observer';
  version: string;
};
type SubmissionRow = {
  ancestor_fences: Fence[];
  id: string;
  task_id: string;
  submitted_by: string;
  goal_version: string;
  task_epoch: string;
  evidence: C['Evidence'][];
  summary: string;
  created_at: Date;
};
const json = (value: unknown) => JSON.stringify(value);
const terminal = isTerminalTaskStatus;
const n = (value: string) => (BigInt(value) + 1n).toString();
const domainStatus = (status: string): RequestStatus =>
  status === 'clarification_requested'
    ? 'needs_clarification'
    : status === 'cancelled'
      ? 'withdrawn'
      : (status as RequestStatus);
const databaseStatus = (status: RequestStatus) =>
  status === 'needs_clarification'
    ? 'clarification_requested'
    : status === 'withdrawn'
      ? 'cancelled'
      : status;
const asDomain = (t: TaskRow): DomainTask => ({
  id: t.id,
  ownerPrincipalId: t.owner_principal_id,
  accountablePrincipalId: t.accountable_principal_id,
  status: t.status,
  version: BigInt(t.version),
  executionEpoch: BigInt(t.execution_epoch),
  acceptanceBaseline: t.goal_version,
  blockedFrom: t.blocked_from,
  reason: t.state_reason,
});
const asRequest = (r: RequestRow): DomainRequest => ({
  id: r.id,
  taskId: r.task_id,
  kind: r.kind,
  proposerPrincipalId: r.requester_principal_id,
  recipientPrincipalId: r.recipient_principal_id,
  status: domainStatus(r.status),
  version: BigInt(r.version),
  proposalVersion: BigInt(r.proposal_version),
  acceptedProposalVersion: r.status === 'accepted' ? BigInt(r.proposal_version) : null,
  expiresAtMs: r.expires_at.getTime(),
});
const view = (id: string, revision: string, generation: string) => ({
  view_scope: id,
  authz_generation: generation,
  projection_id: id,
  projection_revision: revision,
});

export function createTaskService(
  db: Db,
  cursorSecret: string,
  options: {
    requiredActionsClosed?: (tx: Tx, taskId: string) => Promise<boolean>;
    artifacts?: ArtifactEvidencePort;
    promotion?: RunPromotionPort;
    policyLedger?: PolicyLedger;
  } = {},
) {
  const cursors = new CursorCodec(cursorSecret);
  async function transaction<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await withTenant(db, auth.tenantId, async (tx) => {
        await authorizeTenant(tx, auth);
        return fn(tx);
      });
    } catch (error) {
      if (error instanceof DomainError)
        throw new ApplicationError(
          error.code === 'INVALID_ARGUMENT' ? 'VALIDATION_FAILED' : error.code,
          error.status,
        );
      throw error;
    }
  }
  async function row(tx: Tx, id: string): Promise<TaskRow> {
    const result = await sql<TaskRow>`select * from tasks where id = ${id}`.execute(tx);
    return result.rows[0] ?? fail('NOT_FOUND', 404);
  }
  async function member(
    tx: Tx,
    auth: AuthContext,
    workspaceId: string,
    principalId = auth.principalId,
  ) {
    const result = await sql<{
      role: string;
    }>`select m.role from memberships m join tenant_principals p on p.tenant_id=m.tenant_id and p.principal_id=m.principal_id join principals global_p on global_p.id=m.principal_id where m.tenant_id=${auth.tenantId} and m.workspace_id=${workspaceId} and m.principal_id=${principalId} and m.status='active' and p.status='active' and global_p.status='active' for share of m,p`.execute(
      tx,
    );
    return result.rows[0] ?? fail('NOT_FOUND', 404);
  }
  async function members(tx: Tx, auth: AuthContext, workspaceId: string, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) await member(tx, auth, workspaceId, id);
  }
  async function access(tx: Tx, auth: AuthContext, task: TaskRow): Promise<Participant> {
    if (!task.workspace_id) fail('NOT_FOUND', 404);
    await member(tx, auth, task.workspace_id!);
    const result =
      await sql<Participant>`select principal_id,role,version from task_participants where task_id=${task.id} and principal_id=${auth.principalId} and status='active' for share`.execute(
        tx,
      );
    return result.rows[0] ?? fail('NOT_FOUND', 404);
  }
  function own(auth: AuthContext, task: TaskRow) {
    if (task.owner_principal_id !== auth.principalId) fail('FORBIDDEN', 403);
  }
  function alive(task: TaskRow) {
    if (terminal(task.status)) fail('TASK_TERMINATED', 409);
  }
  async function locked(
    tx: Tx,
    auth: AuthContext,
    id: string,
    includeTerminal = false,
  ): Promise<TaskRow> {
    const preliminary = await row(tx, id);
    await lockTaskRoots(tx, auth.tenantId, [preliminary.root_task_id]);
    const chain = await sql<
      TaskRow & { depth: number }
    >`with recursive ancestors as (select t.*,0 as depth from tasks t where t.id=${id} union all select p.*,a.depth+1 from tasks p join ancestors a on p.id=a.parent_task_id and p.tenant_id=a.tenant_id) select * from ancestors order by depth desc`.execute(
      tx,
    );
    for (const ancestor of chain.rows) {
      const current = (
        await sql<TaskRow>`select * from tasks where id=${ancestor.id} for update`.execute(tx)
      ).rows[0]!;
      if (current.id !== id || !includeTerminal) alive(current);
    }
    return row(tx, id);
  }
  async function fences(tx: Tx, id: string): Promise<Fence[]> {
    const rows = (
      await sql<{
        id: string;
        execution_epoch: string;
      }>`with recursive ancestors as (select id,parent_task_id,execution_epoch,0 as depth from tasks where id=${id} union all select p.id,p.parent_task_id,p.execution_epoch,a.depth+1 from tasks p join ancestors a on p.id=a.parent_task_id) select id,execution_epoch from ancestors order by depth desc`.execute(
        tx,
      )
    ).rows;
    return rows.map((t) => ({ taskId: t.id, executionEpoch: t.execution_epoch }));
  }
  async function verifyFences(tx: Tx, id: string, expected: Fence[]) {
    const current = await fences(tx, id);
    const currentTasks = [];
    for (const t of current) {
      const actual = await row(tx, t.taskId);
      currentTasks.push({
        id: actual.id,
        status: actual.status,
        executionEpoch: BigInt(actual.execution_epoch),
      });
    }
    assertTaskFencesCurrent(
      expected.map((t) => ({ taskId: t.taskId, executionEpoch: BigInt(t.executionEpoch) })),
      currentTasks,
    );
  }
  async function dto(tx: Tx, auth: AuthContext, id: string) {
    const t = await row(tx, id);
    await access(tx, auth, t);
    const budget =
      (
        await sql<
          C['Budget']
        >`select currency,limit_microunits,reserved_microunits,spent_microunits from task_budgets where task_id=${id}`.execute(
          tx,
        )
      ).rows[0] ?? fail('NOT_FOUND', 404);
    return assertContract('Task', {
      id: t.id,
      workspace_id: t.workspace_id,
      root_task_id: t.root_task_id,
      ...(t.parent_task_id ? { parent_task_id: t.parent_task_id } : {}),
      title: t.title,
      goal: t.goal,
      goal_version: t.goal_version,
      reviewer_principal_ids: t.reviewer_ids,
      owner_principal_id: t.owner_principal_id,
      accountable_principal_id: t.accountable_principal_id,
      status: t.status,
      archived: t.archived,
      version: t.version,
      execution_epoch: t.execution_epoch,
      created_at: t.created_at.toISOString(),
      ...(t.due_at ? { due_at: t.due_at.toISOString() } : {}),
      acceptance_criteria: t.acceptance_criteria,
      budget,
      ...view(t.id, t.version, t.authz_generation),
    });
  }
  async function event(
    tx: Tx,
    auth: AuthContext,
    t: TaskRow,
    type: string,
    payload: Record<string, unknown> = {},
  ) {
    await appendEvent(tx, auth, {
      aggregateType: 'task',
      aggregateId: t.id,
      version: t.version,
      type,
      payload,
      target: `task:${t.id}`,
    });
  }
  async function save(tx: Tx, t: TaskRow, state: DomainTask) {
    await sql`update tasks set owner_principal_id=${state.ownerPrincipalId},status=${state.status},version=${state.version.toString()},execution_epoch=${state.executionEpoch.toString()},blocked_from=${state.blockedFrom},state_reason=${state.reason},updated_at=clock_timestamp() where id=${t.id}`.execute(
      tx,
    );
    return row(tx, t.id);
  }
  async function touch(tx: Tx, id: string, authz = false) {
    await sql`update tasks set version=version+1,authz_generation=authz_generation+${authz ? 1 : 0},updated_at=clock_timestamp() where id=${id}`.execute(
      tx,
    );
    return row(tx, id);
  }
  async function grantParticipant(
    tx: Tx,
    auth: AuthContext,
    id: string,
    principal: string,
    role: Participant['role'],
  ) {
    await sql`insert into task_participants(tenant_id,task_id,principal_id,role) values(${auth.tenantId},${id},${principal},${role}) on conflict(tenant_id,task_id,principal_id) do update set role=excluded.role,status='active',version=task_participants.version+1,updated_at=clock_timestamp()`.execute(
      tx,
    );
  }
  async function supersede(tx: Tx, auth: AuthContext, taskId: string, except?: string) {
    const requests =
      await sql<RequestRow>`select * from collaboration_requests where task_id=${taskId} and status in ('pending','clarification_requested') and (${except ?? null}::uuid is null or id<>${except ?? null}::uuid) order by id for update`.execute(
        tx,
      );
    for (const r of requests.rows) {
      await sql`update collaboration_requests set status='superseded',version=version+1,updated_at=clock_timestamp() where id=${r.id}`.execute(
        tx,
      );
      await sql`insert into request_decisions(tenant_id,id,request_id,proposal_version,actor_principal_id,decision) values(${auth.tenantId},${randomUUID()},${r.id},${r.proposal_version},${auth.principalId},'supersede')`.execute(
        tx,
      );
      await requestEvent(tx, auth, { ...r, version: n(r.version) }, 'request.superseded');
    }
  }
  async function insertTask(
    tx: Tx,
    auth: AuthContext,
    input: C['CreateTaskInput'],
    ownerId: string,
    parent?: TaskRow,
    accountableId = auth.principalId,
  ) {
    const id = randomUUID();
    const domain = newDomainTask({
      id,
      ownerPrincipalId: ownerId,
      accountablePrincipalId: accountableId,
      acceptanceBaseline: '1',
    });
    if (parent) {
      const count = (
        await sql<{
          n: string;
        }>`select count(*)::text as n from tasks where root_task_id=${parent.root_task_id}`.execute(
          tx,
        )
      ).rows[0]!;
      const depth = (
        await sql<{
          n: string;
        }>`with recursive ancestors as (select id,parent_task_id from tasks where id=${parent.id} union all select p.id,p.parent_task_id from tasks p join ancestors a on p.id=a.parent_task_id) select count(*)::text as n from ancestors`.execute(
          tx,
        )
      ).rows[0]!;
      if (Number(count.n) >= 200 || Number(depth.n) >= 5) fail('VALIDATION_FAILED', 400);
      const budget = (
        await sql<{
          currency: string;
          limit_microunits: string;
        }>`select currency,limit_microunits from task_budgets where task_id=${parent.id} for update`.execute(
          tx,
        )
      ).rows[0]!;
      if (
        input.budget.currency !== budget.currency ||
        BigInt(input.budget.limit_microunits) > BigInt(budget.limit_microunits)
      )
        fail('BUDGET_EXCEEDED', 409);
    }
    await sql`insert into tasks(tenant_id,id,root_task_id,parent_task_id,workspace_id,owner_principal_id,accountable_principal_id,created_by,title,goal,acceptance_criteria,reviewer_ids,due_at,execution_deadline,version,execution_epoch) values(${auth.tenantId},${id},${parent?.root_task_id ?? id},${parent?.id ?? null},${input.workspace_id},${ownerId},${domain.accountablePrincipalId},${auth.principalId},${input.title},${input.goal},${json(input.acceptance_criteria)}::jsonb,${json(input.reviewer_principal_ids)}::jsonb,${input.due_at ?? null},${input.execution_deadline ?? null},'1','1')`.execute(
      tx,
    );
    await grantParticipant(tx, auth, id, ownerId, 'owner');
    if (ownerId !== accountableId) await grantParticipant(tx, auth, id, accountableId, 'reviewer');
    for (const reviewer of input.reviewer_principal_ids)
      if (reviewer !== ownerId) await grantParticipant(tx, auth, id, reviewer, 'reviewer');
    await sql`insert into task_budgets(tenant_id,task_id,currency,limit_microunits) values(${auth.tenantId},${id},${input.budget.currency},${input.budget.limit_microunits})`.execute(
      tx,
    );
    const result = await row(tx, id);
    await event(tx, auth, result, 'task.created');
    return result;
  }
  async function getRequestRow(tx: Tx, id: string): Promise<RequestRow> {
    return (
      (await sql<RequestRow>`select * from collaboration_requests where id=${id}`.execute(tx))
        .rows[0] ?? fail('NOT_FOUND', 404)
    );
  }
  async function requestAccess(tx: Tx, auth: AuthContext, r: RequestRow) {
    const task = await row(tx, r.task_id);
    if (!task.workspace_id) fail('NOT_FOUND', 404);
    await member(tx, auth, task.workspace_id!);
    if (![r.requester_principal_id, r.recipient_principal_id].includes(auth.principalId))
      fail('NOT_FOUND', 404);
    return task;
  }
  async function requestDto(tx: Tx, auth: AuthContext, id: string) {
    const r = await getRequestRow(tx, id);
    const t = await requestAccess(tx, auth, r);
    await verifyStoredArtifacts(tx, auth, t.id, r.proposal.inputs);
    const receipt = (
      await sql<{
        received_at: Date;
      }>`select received_at from agent_request_deliveries where request_id=${r.id} and proposal_version=${r.proposal_version} and recipient_id=${r.recipient_principal_id}`.execute(
        tx,
      )
    ).rows[0];
    return assertContract('CollaborationRequest', {
      received_at: receipt?.received_at.toISOString() ?? null,
      id: r.id,
      task_id: r.task_id,
      kind: r.kind,
      proposer_id: r.requester_principal_id,
      recipient_id: r.recipient_principal_id,
      proposal_version: r.proposal_version,
      version: r.version,
      expected_task_version: r.expected_task_version,
      execution_epoch: r.task_epoch,
      goal_version: r.goal_version,
      status: r.status,
      proposal: r.proposal,
      goal: r.proposal.goal,
      request_expires_at: r.expires_at.toISOString(),
      created_at: r.created_at.toISOString(),
      ...view(r.id, r.version, t.authz_generation),
    });
  }
  async function requestEvent(tx: Tx, auth: AuthContext, r: RequestRow, type: string) {
    await appendEvent(tx, auth, {
      aggregateType: 'request',
      aggregateId: r.id,
      version: r.version,
      type,
      payload: { task_id: r.task_id },
      target: `request:${r.id}`,
    });
  }
  async function proposalHistory(tx: Tx, auth: AuthContext, r: RequestRow) {
    await sql`insert into request_proposals(tenant_id,request_id,proposal_version,proposal,task_version,task_epoch,goal_version,created_by,expires_at,ancestor_fences) values(${auth.tenantId},${r.id},${r.proposal_version},${json(r.proposal)}::jsonb,${r.expected_task_version},${r.task_epoch},${r.goal_version},${auth.principalId},${r.expires_at},${json(r.ancestor_fences)}::jsonb)`.execute(
      tx,
    );
  }
  async function evidence(
    tx: Tx,
    auth: AuthContext,
    inputs: C['EvidenceInput'][],
    taskId: string,
  ): Promise<C['Evidence'][]> {
    const result: C['Evidence'][] = [];
    for (const input of inputs) {
      if (input.type === 'artifact_version') {
        if (!options.artifacts) fail('VALIDATION_FAILED', 400);
        result.push(await options.artifacts!.verify(tx, auth, taskId, input));
        continue;
      }
      for (const source of input.source_refs) {
        const t = await row(tx, source.id);
        await access(tx, auth, t);
        expectedVersion(t.version, source.version);
      }
      result.push({
        type: 'text',
        id: randomUUID(),
        text: input.text,
        source_refs: input.source_refs,
        sha256: createHash('sha256').update(input.text).digest('hex'),
      });
    }
    return result;
  }
  async function verifyStoredArtifacts(
    tx: Tx,
    auth: AuthContext,
    taskId: string,
    inputs: (C['Evidence'] | C['EvidenceInput'])[],
  ) {
    for (const input of inputs)
      if (input.type === 'artifact_version') {
        if (!options.artifacts) fail('NOT_FOUND', 404);
        await options.artifacts!.verify(tx, auth, taskId, input);
      }
  }
  async function lockInputRoots(
    tx: Tx,
    auth: AuthContext,
    t: TaskRow,
    inputs: C['EvidenceInput'][],
    dependencies: string[] = [],
  ) {
    const roots = [t.root_task_id];
    const ids = [
      ...dependencies,
      ...inputs.flatMap((input) =>
        input.type === 'text' ? input.source_refs.map((source) => source.id) : [],
      ),
    ];
    for (const id of [...new Set(ids)]) roots.push((await row(tx, id)).root_task_id);
    await lockTaskRoots(tx, auth.tenantId, roots);
  }
  async function pendingHandoffActions(tx: Tx, taskId: string): Promise<string[]> {
    // Direct task actions only. Never expose parameters, credentials or descendant-task data.
    const result = await sql<{ id: string }>`select a.id from actions a where a.task_id=${taskId}
      and (a.status not in ('succeeded','failed','cancelled')
        or (a.required and a.status<>'succeeded')
        or exists(select 1 from action_reconciliation_cases c where c.tenant_id=a.tenant_id and c.action_id=a.id and c.status='open'))
      order by a.id limit 101`.execute(tx);
    if (result.rows.length > 100) fail('HANDOFF_ACTIONS_LIMIT', 409);
    return result.rows.map((item) => item.id);
  }
  async function validateHandoffActions(tx: Tx, taskId: string, ids: string[]) {
    if (ids.length) {
      const references = await sql<{
        id: string;
      }>`select id from actions where task_id=${taskId} and id=any(${ids}::uuid[])`.execute(tx);
      if (references.rows.length !== ids.length) fail('NOT_FOUND', 404);
    }
    // Completion after proposal is harmless; newly outstanding work requires a new explicit offer.
    const offered = new Set(ids);
    if ((await pendingHandoffActions(tx, taskId)).some((id) => !offered.has(id)))
      fail('HANDOFF_ACTIONS_CHANGED', 409);
  }
  async function validateProposal(
    tx: Tx,
    auth: AuthContext,
    t: TaskRow,
    p: C['WorkProposal'],
    kind: RequestRow['kind'],
    recipient: string,
  ) {
    await members(tx, auth, t.workspace_id!, [
      recipient,
      ...p.acceptance.reviewer_principal_ids,
      p.escalation_principal_id,
    ]);
    if (kind === 'handoff' && !p.handoff) fail('VALIDATION_FAILED', 400);
    if (kind !== 'handoff' && p.handoff) fail('VALIDATION_FAILED', 400);
    if (p.handoff) await validateHandoffActions(tx, t.id, p.handoff.pending_action_ids);
    if (kind !== 'delegate' && p.dependencies.length) fail('VALIDATION_FAILED', 400);
    const b = (await sql<C['Budget']>`select * from task_budgets where task_id=${t.id}`.execute(tx))
      .rows[0]!;
    if (
      p.budget.currency !== b.currency ||
      BigInt(p.budget.limit_microunits) > BigInt(b.limit_microunits)
    )
      fail('BUDGET_EXCEEDED', 409);
    if (
      kind === 'handoff' &&
      (p.goal !== t.goal ||
        json(p.acceptance.criteria) !== json(t.acceptance_criteria) ||
        json([...p.acceptance.reviewer_principal_ids].sort()) !==
          json([...t.reviewer_ids].sort()) ||
        p.budget.limit_microunits !== b.limit_microunits)
    )
      fail('VALIDATION_FAILED', 400);
    await evidence(tx, auth, p.inputs, t.id);
    for (const id of p.dependencies) {
      const dependency = await row(tx, id);
      await access(tx, auth, dependency);
    }
  }
  async function agreementDto(tx: Tx, id: string) {
    const r = (
      await sql<{
        id: string;
        request_id: string;
        task_id: string;
        accepted_by: string;
        accepted_version: string;
        terms: C['WorkProposal'];
        child_task_id: string | null;
        created_at: Date;
      }>`select * from agreements where request_id=${id}`.execute(tx)
    ).rows[0];
    return r
      ? assertContract('Agreement', {
          id: r.id,
          request_id: r.request_id,
          task_id: r.task_id,
          accepted_by: r.accepted_by,
          accepted_version: r.accepted_version,
          terms: r.terms,
          ...(r.child_task_id ? { child_task_id: r.child_task_id } : {}),
          created_at: r.created_at.toISOString(),
        })
      : undefined;
  }
  async function dependencyEdges(tx: Tx) {
    return (
      await sql<{
        dependent_task_id: string;
        prerequisite_task_id: string;
      }>`select dependent_task_id,prerequisite_task_id from task_dependencies order by dependent_task_id,prerequisite_task_id limit 10001`.execute(
        tx,
      )
    ).rows.map((e) => ({ taskId: e.dependent_task_id, dependsOnTaskId: e.prerequisite_task_id }));
  }
  async function putDependency(tx: Tx, auth: AuthContext, id: string, prerequisite: string) {
    const edges = await dependencyEdges(tx);
    if (edges.length >= 10000) fail('VALIDATION_FAILED', 400);
    addTaskDependency(edges, { taskId: id, dependsOnTaskId: prerequisite });
    await sql`insert into task_dependencies(tenant_id,dependent_task_id,prerequisite_task_id) values(${auth.tenantId},${id},${prerequisite}) on conflict do nothing`.execute(
      tx,
    );
  }
  async function actionsClosed(tx: Tx, id: string): Promise<boolean> {
    if (options.requiredActionsClosed) return options.requiredActionsClosed(tx, id);
    // M2 has no Action persistence. A later installation of that table must supply its admission gate.
    const installed = (
      await sql<{ exists: boolean }>`select to_regclass('actions') is not null as exists`.execute(
        tx,
      )
    ).rows[0]!;
    return !installed.exists;
  }
  async function readyDependencies(tx: Tx, id: string) {
    const open = (
      await sql<{
        n: string;
      }>`select count(*)::text as n from task_dependencies d join tasks p on p.id=d.prerequisite_task_id and p.tenant_id=d.tenant_id where d.dependent_task_id=${id} and p.status<>'completed'`.execute(
        tx,
      )
    ).rows[0]!;
    if (Number(open.n) > 0) fail('DEPENDENCY_BLOCKED', 409);
  }
  return {
    supportsRunPromotion: !!options.promotion,
    async promoteRun(
      auth: AuthContext,
      runId: string,
      input: C['PromoteRunInput'],
      version: string,
      key: string,
    ) {
      assertContract('PromoteRunInput', input);
      assertContract('Identifier', runId);
      assertContract('Version', version);
      if (!options.promotion) fail('SERVICE_UNAVAILABLE', 503);
      return transaction(auth, async (tx) => {
        if (auth.kind !== 'human') fail('FORBIDDEN', 403);
        const taskId = await command(
          tx,
          auth,
          'task.promote_run',
          key,
          { runId, input, version },
          async () => {
            await sql`select pg_advisory_xact_lock(hashtextextended(${`${auth.tenantId}:promote:${runId}`},0))`.execute(
              tx,
            );
            const origin = await options.promotion!.validate(tx, auth, runId, version, 'create');
            if (origin.workspaceId !== input.task.workspace_id) fail('DISCLOSURE_DENIED', 403);
            if (
              (await sql`select 1 from task_run_origins where run_id=${runId}`.execute(tx)).rows
                .length
            )
              fail('VERSION_CONFLICT', 409);
            const membership = await member(tx, auth, input.task.workspace_id);
            if (membership.role === 'guest') fail('FORBIDDEN', 403);
            await members(tx, auth, input.task.workspace_id, input.task.reviewer_principal_ids);
            for (const reviewer of input.task.reviewer_principal_ids) {
              const permitted = await tx
                .selectFrom('conversation_members')
                .select('principal_id')
                .where('conversation_id', '=', origin.conversationId)
                .where('principal_id', '=', reviewer)
                .where('status', '=', 'active')
                .forShare()
                .executeTakeFirst();
              if (!permitted) fail('DISCLOSURE_DENIED', 403);
            }
            const task = await insertTask(tx, auth, input.task, auth.principalId);
            await sql`insert into task_run_origins(tenant_id,task_id,run_id,run_version,conversation_id,context_manifest_id,created_by) values(${auth.tenantId},${task.id},${runId},${version},${origin.conversationId},${origin.manifestId},${auth.principalId})`.execute(
              tx,
            );
            await appendEvent(tx, auth, {
              aggregateType: 'task_run_origin',
              aggregateId: task.id,
              version: '1',
              type: 'task.promoted_from_run',
              payload: { run_id: runId, run_version: version },
              target: `task:${task.id}`,
            });
            return task.id;
          },
        );
        await options.promotion!.validate(tx, auth, runId, version, 'read');
        return dto(tx, auth, taskId);
      });
    },
    async runOrigin(auth: AuthContext, taskId: string) {
      return transaction(auth, async (tx) => {
        const t = await row(tx, taskId);
        await access(tx, auth, t);
        const origin = (
          await sql<{
            run_id: string;
            run_version: string;
            conversation_id: string;
            context_manifest_id: string;
            created_at: Date;
          }>`select run_id,run_version,conversation_id,context_manifest_id,created_at from task_run_origins where task_id=${taskId}`.execute(
            tx,
          )
        ).rows[0];
        if (!origin) return assertContract('TaskRunOrigin', { access: 'none' });
        if (!options.promotion) return assertContract('TaskRunOrigin', { access: 'restricted' });
        try {
          await options.promotion.validate(tx, auth, origin.run_id, origin.run_version, 'read');
        } catch (error) {
          if (error instanceof ApplicationError && [403, 404, 409].includes(error.status))
            return assertContract('TaskRunOrigin', { access: 'restricted' });
          throw error;
        }
        return assertContract('TaskRunOrigin', {
          access: 'available',
          ...origin,
          created_at: origin.created_at.toISOString(),
        });
      });
    },
    async createTask(auth: AuthContext, input: C['CreateTaskInput'], key: string) {
      assertContract('CreateTaskInput', input);
      return transaction(auth, async (tx) => {
        const id = await command(tx, auth, 'task.create', key, input, async () => {
          const membership = await member(tx, auth, input.workspace_id);
          if (membership.role === 'guest') fail('FORBIDDEN', 403);
          await members(tx, auth, input.workspace_id, input.reviewer_principal_ids);
          return (await insertTask(tx, auth, input, auth.principalId)).id;
        });
        return dto(tx, auth, id);
      });
    },
    async getTask(auth: AuthContext, id: string) {
      return transaction(auth, (tx) => dto(tx, auth, id));
    },
    async handoffActions(auth: AuthContext, id: string) {
      assertContract('Identifier', id);
      return transaction(auth, async (tx) => {
        // A preview is advisory. Authorize before exposing lifecycle state; the
        // proposal/acceptance transaction performs the authoritative root-locked check.
        await access(tx, auth, await row(tx, id));
        const t = await row(tx, id);
        own(auth, t);
        return assertContract('TaskHandoffActions', {
          task_id: t.id,
          task_version: t.version,
          pending_action_ids: await pendingHandoffActions(tx, t.id),
        });
      });
    },
    async listTasks(auth: AuthContext, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const limit = Math.min(200, Math.max(1, query.limit ?? 50));
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:tasks`;
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
          }>`select t.id from tasks t join task_participants p on p.tenant_id=t.tenant_id and p.task_id=t.id join memberships m on m.tenant_id=t.tenant_id and m.workspace_id=t.workspace_id and m.principal_id=p.principal_id where p.principal_id=${auth.principalId} and p.status='active' and m.status='active' and t.id>${after}::uuid order by t.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const r of rows.slice(0, limit)) items.push(await dto(tx, auth, r.id));
        return assertContract('TaskPage', {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        });
      });
    },
    async updateTask(
      auth: AuthContext,
      id: string,
      input: C['UpdateTaskInput'],
      version: string,
      key: string,
    ) {
      assertContract('UpdateTaskInput', input);
      if (!Object.keys(input).length) fail('VALIDATION_FAILED', 400);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.update', key, { id, input, version }, async () => {
          const t = await locked(tx, auth, id, true);
          await access(tx, auth, t);
          own(auth, t);
          expectedVersion(t.version, version);
          const changed = input.goal !== undefined || input.acceptance_criteria !== undefined;
          if (changed) alive(t);
          await sql`update tasks set title=${input.title ?? t.title},goal=${input.goal ?? t.goal},acceptance_criteria=${json(input.acceptance_criteria ?? t.acceptance_criteria)}::jsonb,archived=${input.archived ?? t.archived},due_at=${input.due_at ?? t.due_at},goal_version=goal_version+${changed ? 1 : 0},execution_epoch=execution_epoch+${changed ? 1 : 0},status=${changed && t.status === 'in_review' ? 'active' : t.status},version=version+1,updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          if (changed) await supersede(tx, auth, id);
          await event(tx, auth, await row(tx, id), 'task.updated');
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async participants(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        await access(tx, auth, await row(tx, id));
        return assertContract('TaskParticipantPage', {
          items: (
            await sql<Participant>`select principal_id,role,version from task_participants where task_id=${id} and status='active' order by principal_id limit 200`.execute(
              tx,
            )
          ).rows,
        });
      });
    },
    async changeParticipant(
      auth: AuthContext,
      id: string,
      principalId: string,
      role: 'contributor' | 'reviewer' | 'observer' | null,
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(
          tx,
          auth,
          'task.participant',
          key,
          { id, principalId, role, version },
          async () => {
            const pre = await row(tx, id);
            await members(tx, auth, pre.workspace_id!, [principalId]);
            const t = await locked(tx, auth, id);
            await access(tx, auth, t);
            own(auth, t);
            expectedVersion(t.version, version);
            if (principalId === t.owner_principal_id || principalId === t.accountable_principal_id)
              fail('FORBIDDEN', 403);
            const reviewers = t.reviewer_ids.filter((p) => p !== principalId);
            if (role === 'reviewer') reviewers.push(principalId);
            if (!reviewers.length) fail('ACCEPTANCE_REQUIRED', 409);
            if (role) await grantParticipant(tx, auth, id, principalId, role);
            else {
              const participant = (
                await sql<{
                  version: string;
                }>`select version from task_participants where task_id=${id} and principal_id=${principalId} and status='active' for update`.execute(
                  tx,
                )
              ).rows[0];
              if (participant)
                await recordPolicy(tx, auth, options.policyLedger, {
                  kind: 'revocation.task',
                  target_id: id,
                  target_version: participant.version,
                  subject_id: principalId,
                });
              await sql`update task_participants set status='removed',version=version+1,updated_at=clock_timestamp() where task_id=${id} and principal_id=${principalId}`.execute(
                tx,
              );
            }
            const changed = json([...reviewers].sort()) !== json([...t.reviewer_ids].sort());
            await sql`update tasks set reviewer_ids=${json(reviewers)}::jsonb,goal_version=goal_version+${changed ? 1 : 0},execution_epoch=execution_epoch+${changed ? 1 : 0} where id=${id}`.execute(
              tx,
            );
            const result = await touch(tx, id, true);
            await supersede(tx, auth, id);
            await event(tx, auth, result, 'task.participants_changed');
            return id;
          },
        );
        return dto(tx, auth, id);
      });
    },
    async linkConversation(
      auth: AuthContext,
      id: string,
      input: C['TaskConversationLinkInput'],
      version: string,
      key: string,
    ) {
      assertContract('TaskConversationLinkInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.link', key, { id, input, version }, async () => {
          const t = await locked(tx, auth, id, true);
          await access(tx, auth, t);
          own(auth, t);
          expectedVersion(t.version, version);
          const c = await authorizeConversation(tx, auth, input.conversation_id);
          if (c.row.workspace_id !== t.workspace_id) fail('DISCLOSURE_DENIED', 403);
          await sql`insert into task_conversation_links(tenant_id,task_id,conversation_id,disclosure_scope_ref,public_summary) values(${auth.tenantId},${id},${input.conversation_id},${input.conversation_id},${input.public_summary}) on conflict(tenant_id,task_id,conversation_id) do update set public_summary=excluded.public_summary,version=task_conversation_links.version+1,updated_at=clock_timestamp()`.execute(
            tx,
          );
          await event(tx, auth, await touch(tx, id), 'task.summary_disclosed', {
            conversation_id: input.conversation_id,
            public_summary: input.public_summary,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async conversationSummaries(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        await authorizeConversation(tx, auth, id);
        return assertContract('TaskSummaryPage', {
          items: (
            await sql<
              C['TaskSummary']
            >`select task_id,conversation_id,public_summary,version from task_conversation_links where conversation_id=${id} order by task_id limit 200`.execute(
              tx,
            )
          ).rows,
        });
      });
    },
    async changeState(
      auth: AuthContext,
      id: string,
      input: C['TaskStateInput'],
      version: string,
      key: string,
    ) {
      assertContract('TaskStateInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.state', key, { id, input, version }, async () => {
          const t = await locked(tx, auth, id);
          await access(tx, auth, t);
          own(auth, t);
          expectedVersion(t.version, version);
          let state: DomainTask;
          if (input.state === 'active') {
            await readyDependencies(tx, id);
            state = advanceTask(asDomain(t), 'active', BigInt(version));
          } else if (input.state === 'blocked')
            state = blockTask(asDomain(t), BigInt(version), input.reason ?? '');
          else if (input.state === 'resume') {
            await readyDependencies(tx, id);
            state = resumeTask(asDomain(t), BigInt(version));
          } else
            state = terminateTask(asDomain(t), {
              expectedVersion: BigInt(version),
              status: 'failed',
              reason: input.reason ?? '',
            });
          const next = await save(tx, t, state);
          if (terminal(next.status)) await supersede(tx, auth, id);
          await event(tx, auth, next, 'task.state_changed');
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async cancelTask(
      auth: AuthContext,
      id: string,
      input: C['TaskReasonInput'],
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.cancel', key, { id, input, version }, async () => {
          const t = await locked(tx, auth, id);
          await access(tx, auth, t);
          if (![t.owner_principal_id, t.accountable_principal_id].includes(auth.principalId))
            fail('FORBIDDEN', 403);
          const next = await save(
            tx,
            t,
            terminateTask(asDomain(t), {
              expectedVersion: BigInt(version),
              status: 'cancelled',
              reason: input.reason,
            }),
          );
          await supersede(tx, auth, id);
          await event(tx, auth, next, 'task.cancelled');
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async reopenTask(
      auth: AuthContext,
      id: string,
      input: C['ReopenTaskInput'],
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.reopen', key, { id, input, version }, async () => {
          const t = await locked(tx, auth, id, true);
          await access(tx, auth, t);
          own(auth, t);
          const next = await save(
            tx,
            t,
            domainReopen(asDomain(t), {
              expectedVersion: BigInt(version),
              reason: input.reason,
              acceptanceBaseline: n(t.goal_version),
            }),
          );
          await sql`update tasks set goal_version=goal_version+1,acceptance_criteria=${json(input.acceptance_criteria)}::jsonb where id=${id}`.execute(
            tx,
          );
          await supersede(tx, auth, id);
          await event(tx, auth, next, 'task.reopened');
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async takeover(
      auth: AuthContext,
      id: string,
      input: C['TaskReasonInput'],
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.takeover', key, { id, input, version }, async () => {
          const pre = await row(tx, id);
          const m = await member(tx, auth, pre.workspace_id!);
          if (m.role !== 'admin') fail('FORBIDDEN', 403);
          const t = await locked(tx, auth, id);
          const next = await save(
            tx,
            t,
            acceptTaskHandoff(asDomain(t), {
              expectedVersion: BigInt(version),
              expectedOwnerPrincipalId: t.owner_principal_id,
              newOwnerPrincipalId: auth.principalId,
            }),
          );
          await grantParticipant(tx, auth, id, t.owner_principal_id, 'observer');
          await grantParticipant(tx, auth, id, auth.principalId, 'owner');
          await sql`update tasks set authz_generation=authz_generation+1,state_reason=${input.reason} where id=${id}`.execute(
            tx,
          );
          await supersede(tx, auth, id);
          await event(tx, auth, next, 'task.taken_over', {
            reason: input.reason,
            previous_owner: t.owner_principal_id,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async addDependency(
      auth: AuthContext,
      id: string,
      input: C['TaskDependencyInput'],
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'task.dependency', key, { id, input, version }, async () => {
          const pre = await row(tx, id);
          const prerequisite = await row(tx, input.prerequisite_task_id);
          await lockDependencyGraph(tx, auth.tenantId);
          await lockTaskRoots(tx, auth.tenantId, [pre.root_task_id, prerequisite.root_task_id]);
          const t = await locked(tx, auth, id);
          await access(tx, auth, t);
          await access(tx, auth, prerequisite);
          own(auth, t);
          expectedVersion(t.version, version);
          await putDependency(tx, auth, id, prerequisite.id);
          await event(tx, auth, await touch(tx, id), 'task.dependency_added', {
            prerequisite_id: prerequisite.id,
          });
          return id;
        });
        return dto(tx, auth, id);
      });
    },
    async createRequest(
      auth: AuthContext,
      id: string,
      input: C['CreateTaskRequestInput'],
      version: string,
      key: string,
    ) {
      assertContract('CreateTaskRequestInput', input);
      return transaction(auth, async (tx) => {
        const requestId = await command(
          tx,
          auth,
          'request.create',
          key,
          { id, input, version },
          async () => {
            const pre = await row(tx, id);
            if (pre.owner_principal_id !== auth.principalId) fail('NOT_FOUND', 404);
            await members(tx, auth, pre.workspace_id!, [
              input.recipient_principal_id,
              ...input.proposal.acceptance.reviewer_principal_ids,
              input.proposal.escalation_principal_id,
            ]);
            await lockInputRoots(tx, auth, pre, input.proposal.inputs, input.proposal.dependencies);
            const t = await locked(tx, auth, id);
            await access(tx, auth, t);
            own(auth, t);
            expectedVersion(t.version, version);
            await validateProposal(
              tx,
              auth,
              t,
              input.proposal,
              input.kind,
              input.recipient_principal_id,
            );
            if (input.recipient_principal_id === auth.principalId) fail('VALIDATION_FAILED', 400);
            const rid = randomUUID();
            newDomainRequest({
              id: rid,
              taskId: id,
              kind: input.kind,
              proposerPrincipalId: auth.principalId,
              recipientPrincipalId: input.recipient_principal_id,
              expiresAtMs: Date.parse(input.request_expires_at),
              nowMs: Date.now(),
            });
            await sql`insert into collaboration_requests(tenant_id,id,task_id,kind,requester_principal_id,recipient_principal_id,proposal,expected_task_version,task_epoch,goal_version,expires_at,ancestor_fences) values(${auth.tenantId},${rid},${id},${input.kind},${auth.principalId},${input.recipient_principal_id},${json(input.proposal)}::jsonb,${version},${t.execution_epoch},${t.goal_version},${input.request_expires_at},${json(await fences(tx, id))}::jsonb)`.execute(
              tx,
            );
            const r = await getRequestRow(tx, rid);
            await proposalHistory(tx, auth, r);
            await requestEvent(tx, auth, r, 'request.created');
            return rid;
          },
        );
        return requestDto(tx, auth, requestId);
      });
    },
    async acknowledgeRequest(auth: AuthContext, id: string, proposalVersion: string, key: string) {
      assertContract('Identifier', id);
      assertContract('Version', proposalVersion);
      return transaction(auth, async (tx) => {
        const r = await getRequestRow(tx, id);
        await requestAccess(tx, auth, r);
        if (auth.kind !== 'agent' || auth.principalId !== r.recipient_principal_id)
          fail('FORBIDDEN', 403);
        expectedVersion(r.proposal_version, proposalVersion);
        await command(tx, auth, 'request.delivery', key, { id, proposalVersion }, async () => {
          const result = (
            await sql<{
              id: string;
            }>`insert into agent_request_deliveries(tenant_id,id,request_id,proposal_version,recipient_id) values(${auth.tenantId},${randomUUID()},${id},${proposalVersion},${auth.principalId}) on conflict do nothing returning id`.execute(
              tx,
            )
          ).rows[0];
          if (result)
            await appendEvent(tx, auth, {
              aggregateType: 'request_delivery',
              aggregateId: result.id,
              version: '1',
              type: 'request.received',
              payload: { request_id: id, proposal_version: proposalVersion },
              target: `request:${id}`,
            });
          return id;
        });
        const receipt = (
          await sql<{
            received_at: Date;
          }>`select received_at from agent_request_deliveries where request_id=${id} and proposal_version=${proposalVersion} and recipient_id=${auth.principalId}`.execute(
            tx,
          )
        ).rows[0]!;
        return {
          request_id: id,
          proposal_version: proposalVersion,
          received_at: receipt.received_at.toISOString(),
        };
      });
    },
    async getRequest(auth: AuthContext, id: string) {
      return transaction(auth, (tx) => requestDto(tx, auth, id));
    },
    async listRequests(auth: AuthContext, query: PageQuery = {}) {
      return transaction(auth, async (tx) => {
        const limit = Math.min(200, Math.max(1, query.limit ?? 50));
        const binding = `${auth.tenantId}:${auth.principalId}:${auth.authzRevision}:requests`;
        const after = query.cursor
          ? cursors.decode(query.cursor, binding)
          : '00000000-0000-0000-0000-000000000000';
        const rows = (
          await sql<{
            id: string;
          }>`select r.id from collaboration_requests r join tasks t on t.id=r.task_id and t.tenant_id=r.tenant_id join memberships m on m.tenant_id=t.tenant_id and m.workspace_id=t.workspace_id and m.principal_id=${auth.principalId} where (r.recipient_principal_id=${auth.principalId} or r.requester_principal_id=${auth.principalId}) and m.status='active' and r.id>${after}::uuid order by r.id limit ${limit + 1}`.execute(
            tx,
          )
        ).rows;
        const items = [];
        for (const r of rows.slice(0, limit)) items.push(await requestDto(tx, auth, r.id));
        return assertContract('CollaborationRequestPage', {
          items,
          ...(rows.length > limit
            ? { next_cursor: cursors.encode(binding, rows[limit - 1]!.id) }
            : {}),
        });
      });
    },
    async reviseRequest(
      auth: AuthContext,
      id: string,
      input: C['ReviseTaskRequestInput'],
      version: string,
      key: string,
    ) {
      assertContract('ReviseTaskRequestInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'request.revise', key, { id, input, version }, async () => {
          const pre = await getRequestRow(tx, id);
          const before = await row(tx, pre.task_id);
          if (
            pre.requester_principal_id !== auth.principalId ||
            before.owner_principal_id !== auth.principalId
          )
            fail('NOT_FOUND', 404);
          await members(tx, auth, before.workspace_id!, [
            pre.recipient_principal_id,
            ...input.proposal.acceptance.reviewer_principal_ids,
            input.proposal.escalation_principal_id,
          ]);
          await lockInputRoots(
            tx,
            auth,
            before,
            input.proposal.inputs,
            input.proposal.dependencies,
          );
          const t = await locked(tx, auth, pre.task_id);
          await access(tx, auth, t);
          own(auth, t);
          expectedVersion(t.version, input.expected_task_version);
          await validateProposal(tx, auth, t, input.proposal, pre.kind, pre.recipient_principal_id);
          const r = (
            await sql<RequestRow>`select * from collaboration_requests where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          if (r.requester_principal_id !== auth.principalId) fail('FORBIDDEN', 403);
          const next = reviseRequestProposal(asRequest(r), {
            expectedVersion: BigInt(version),
            nowMs: Date.now(),
            expiresAtMs: Date.parse(input.request_expires_at),
          });
          await sql`update collaboration_requests set proposal=${json(input.proposal)}::jsonb,proposal_version=${next.proposalVersion.toString()},version=${next.version.toString()},status='pending',expected_task_version=${t.version},task_epoch=${t.execution_epoch},goal_version=${t.goal_version},ancestor_fences=${json(await fences(tx, t.id))}::jsonb,expires_at=${input.request_expires_at},updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          const updated = await getRequestRow(tx, id);
          await proposalHistory(tx, auth, updated);
          await requestEvent(tx, auth, updated, 'request.revised');
          return id;
        });
        return requestDto(tx, auth, id);
      });
    },
    async decideRequest(
      auth: AuthContext,
      id: string,
      input: C['RequestDecisionInput'],
      version: string,
      key: string,
    ) {
      assertContract('RequestDecisionInput', input);
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'request.decision', key, { id, input, version }, async () => {
          const pre = await getRequestRow(tx, id);
          const preliminary = await requestAccess(tx, auth, pre);
          if (pre.recipient_principal_id !== auth.principalId) fail('FORBIDDEN', 403);
          await members(tx, auth, preliminary.workspace_id!, [
            pre.requester_principal_id,
            ...pre.proposal.acceptance.reviewer_principal_ids,
            pre.proposal.escalation_principal_id,
          ]);
          if (pre.kind === 'delegate') await lockDependencyGraph(tx, auth.tenantId);
          await lockInputRoots(
            tx,
            auth,
            preliminary,
            pre.proposal.inputs,
            pre.proposal.dependencies,
          );
          const t = await locked(tx, auth, pre.task_id);
          const r = (
            await sql<RequestRow>`select * from collaboration_requests where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          expectedVersion(r.version, pre.version);
          await verifyFences(tx, t.id, r.ancestor_fences);
          expectedVersion(r.version, version);
          expectedVersion(t.version, input.expected_task_version);
          expectedVersion(t.version, r.expected_task_version);
          expectedVersion(t.execution_epoch, r.task_epoch);
          expectedVersion(t.goal_version, r.goal_version);
          if (t.owner_principal_id !== r.requester_principal_id) fail('OWNER_CONFLICT', 409);
          const next = transitionRequest(
            asRequest(r),
            input.decision === 'accept'
              ? 'accepted'
              : input.decision === 'reject'
                ? 'rejected'
                : 'needs_clarification',
            {
              expectedVersion: BigInt(version),
              expectedProposalVersion: BigInt(input.proposal_version),
              nowMs: Date.now(),
            },
          );
          let childId: string | undefined;
          if (input.decision === 'accept') {
            // Both proposer and recipient must still have access to every named source/dependency.
            await evidence(tx, auth, r.proposal.inputs, t.id);
            for (const dep of r.proposal.dependencies) await access(tx, auth, await row(tx, dep));
            if (r.kind === 'handoff') {
              await validateHandoffActions(tx, t.id, r.proposal.handoff!.pending_action_ids);
              const updated = await save(
                tx,
                t,
                acceptTaskHandoff(asDomain(t), {
                  expectedVersion: BigInt(t.version),
                  expectedOwnerPrincipalId: r.requester_principal_id,
                  newOwnerPrincipalId: auth.principalId,
                }),
              );
              await grantParticipant(
                tx,
                auth,
                t.id,
                t.owner_principal_id,
                t.reviewer_ids.includes(t.owner_principal_id) ? 'reviewer' : 'observer',
              );
              await grantParticipant(tx, auth, t.id, auth.principalId, 'owner');
              await sql`update tasks set authz_generation=authz_generation+1 where id=${t.id}`.execute(
                tx,
              );
              await supersede(tx, auth, t.id, id);
              await event(tx, auth, updated, 'task.handoff_accepted');
            } else if (r.kind === 'delegate') {
              const p = r.proposal;
              const child = await insertTask(
                tx,
                auth,
                {
                  workspace_id: t.workspace_id!,
                  title: p.title,
                  goal: p.goal,
                  acceptance_criteria: p.acceptance.criteria,
                  reviewer_principal_ids: p.acceptance.reviewer_principal_ids,
                  budget: p.budget,
                  ...(p.due_at ? { due_at: p.due_at } : {}),
                  ...(p.execution_deadline ? { execution_deadline: p.execution_deadline } : {}),
                },
                auth.principalId,
                t,
                r.requester_principal_id,
              );
              childId = child.id;
              for (const dep of p.dependencies) await putDependency(tx, auth, child.id, dep);
              await event(tx, auth, await touch(tx, t.id), 'task.child_delegated', {
                child_task_id: child.id,
              });
            } else {
              if (auth.principalId !== t.owner_principal_id)
                await grantParticipant(
                  tx,
                  auth,
                  t.id,
                  auth.principalId,
                  r.kind === 'review' ? 'reviewer' : 'contributor',
                );
              await event(tx, auth, await touch(tx, t.id, true), 'task.collaboration_accepted');
            }
            await sql`insert into agreements(tenant_id,id,request_id,task_id,accepted_by,accepted_version,terms,child_task_id) values(${auth.tenantId},${randomUUID()},${id},${t.id},${auth.principalId},${r.proposal_version},${json(r.proposal)}::jsonb,${childId ?? null})`.execute(
              tx,
            );
          }
          await sql`update collaboration_requests set status=${databaseStatus(next.status)},version=${next.version.toString()},updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await sql`insert into request_decisions(tenant_id,id,request_id,proposal_version,actor_principal_id,decision,comment) values(${auth.tenantId},${randomUUID()},${id},${r.proposal_version},${auth.principalId},${input.decision},${input.comment ?? ''})`.execute(
            tx,
          );
          await requestEvent(
            tx,
            auth,
            { ...r, version: next.version.toString() },
            `request.${databaseStatus(next.status)}`,
          );
          return id;
        });
        const request = await requestDto(tx, auth, id);
        const agreement = await agreementDto(tx, id);
        return assertContract('RequestDecisionResult', {
          request,
          ...(agreement ? { agreement } : {}),
        });
      });
    },
    async withdrawRequest(
      auth: AuthContext,
      id: string,
      input: C['TaskReasonInput'],
      version: string,
      key: string,
    ) {
      return transaction(auth, async (tx) => {
        await command(tx, auth, 'request.withdraw', key, { id, input, version }, async () => {
          const pre = await getRequestRow(tx, id);
          await requestAccess(tx, auth, pre);
          await locked(tx, auth, pre.task_id, true);
          const r = (
            await sql<RequestRow>`select * from collaboration_requests where id=${id} for update`.execute(
              tx,
            )
          ).rows[0]!;
          if (r.requester_principal_id !== auth.principalId) fail('FORBIDDEN', 403);
          const next = transitionRequest(asRequest(r), 'withdrawn', {
            expectedVersion: BigInt(version),
            expectedProposalVersion: BigInt(r.proposal_version),
            nowMs: Date.now(),
          });
          await sql`update collaboration_requests set status='cancelled',version=${next.version.toString()},updated_at=clock_timestamp() where id=${id}`.execute(
            tx,
          );
          await sql`insert into request_decisions(tenant_id,id,request_id,proposal_version,actor_principal_id,decision,comment) values(${auth.tenantId},${randomUUID()},${id},${r.proposal_version},${auth.principalId},'withdraw',${input.reason})`.execute(
            tx,
          );
          await requestEvent(
            tx,
            auth,
            { ...r, version: next.version.toString() },
            'request.cancelled',
          );
          return id;
        });
        return requestDto(tx, auth, id);
      });
    },
    async submit(
      auth: AuthContext,
      id: string,
      input: C['SubmissionInput'],
      version: string,
      key: string,
    ) {
      assertContract('SubmissionInput', input);
      return transaction(auth, async (tx) => {
        const sid = await command(
          tx,
          auth,
          'task.submit',
          key,
          { id, input, version },
          async () => {
            const pre = await row(tx, id);
            await lockInputRoots(tx, auth, pre, input.evidence);
            const t = await locked(tx, auth, id);
            const p = await access(tx, auth, t);
            if (!['owner', 'contributor'].includes(p.role)) fail('FORBIDDEN', 403);
            expectedVersion(t.version, version);
            expectedVersion(t.goal_version, input.goal_version);
            await readyDependencies(tx, id);
            const fixed = await evidence(tx, auth, input.evidence, id);
            const sid = randomUUID();
            const next = advanceTask(asDomain(t), 'in_review', BigInt(version));
            await sql`insert into task_submissions(tenant_id,id,task_id,submitted_by,goal_version,task_epoch,evidence,summary,ancestor_fences) values(${auth.tenantId},${sid},${id},${auth.principalId},${t.goal_version},${t.execution_epoch},${json(fixed)}::jsonb,${input.summary},${json(await fences(tx, id))}::jsonb)`.execute(
              tx,
            );
            await event(tx, auth, await save(tx, t, next), 'task.submitted', {
              submission_id: sid,
            });
            return sid;
          },
        );
        await access(tx, auth, await row(tx, id));
        const submitted = (
          await sql<SubmissionRow>`select * from task_submissions where id=${sid}`.execute(tx)
        ).rows[0]!;
        await verifyStoredArtifacts(tx, auth, id, submitted.evidence);
        return submissionDto(submitted);
      });
    },
    async submissions(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        const task = await row(tx, id);
        await lockTaskRoots(tx, auth.tenantId, [task.root_task_id]);
        await access(tx, auth, task);
        const stored = (
          await sql<SubmissionRow>`select * from task_submissions where task_id=${id} order by created_at,id limit 200`.execute(
            tx,
          )
        ).rows;
        for (const entry of stored) await verifyStoredArtifacts(tx, auth, id, entry.evidence);
        return assertContract('SubmissionPage', { items: stored.map(submissionDto) });
      });
    },
    async review(
      auth: AuthContext,
      id: string,
      input: C['TaskReviewInput'],
      version: string,
      key: string,
    ) {
      assertContract('TaskReviewInput', input);
      return transaction(auth, async (tx) => {
        const rid = await command(
          tx,
          auth,
          'task.review',
          key,
          { id, input, version },
          async () => {
            const t = await locked(tx, auth, id);
            const p = await access(tx, auth, t);
            if (
              !t.reviewer_ids.includes(auth.principalId) ||
              !['owner', 'reviewer'].includes(p.role)
            )
              fail('FORBIDDEN', 403);
            expectedVersion(t.version, version);
            const submission =
              (
                await sql<SubmissionRow>`select * from task_submissions where id=${input.submission_id} and task_id=${id} for update`.execute(
                  tx,
                )
              ).rows[0] ?? fail('NOT_FOUND', 404);
            await verifyFences(tx, id, submission.ancestor_fences);
            expectedVersion(t.goal_version, submission.goal_version);
            expectedVersion(t.execution_epoch, submission.task_epoch);
            const exists = (
              await sql<{
                id: string;
              }>`select id from task_reviews where submission_id=${submission.id}`.execute(tx)
            ).rows[0];
            if (exists) fail('VERSION_CONFLICT', 409);
            let state: DomainTask;
            if (input.decision === 'return')
              state = advanceTask(asDomain(t), 'active', BigInt(version));
            else {
              await verifyStoredArtifacts(tx, auth, id, submission.evidence);
              await readyDependencies(tx, id);
              const children = (
                await sql<{
                  n: string;
                }>`select count(*)::text as n from tasks where parent_task_id=${id} and status not in ('completed','failed','cancelled')`.execute(
                  tx,
                )
              ).rows[0]!;
              state = terminateTask(asDomain(t), {
                expectedVersion: BigInt(version),
                status: 'completed',
                reason: input.comment,
                completion: {
                  acceptanceConfirmed: true,
                  requiredChildrenClosed: children.n === '0',
                  requiredActionsClosed: await actionsClosed(tx, id),
                  evidenceRefs: submission.evidence.map((e) =>
                    e.type === 'text' ? e.id : e.version_id,
                  ),
                },
              });
            }
            const rid = randomUUID();
            await sql`insert into task_reviews(tenant_id,id,task_id,submission_id,reviewer_id,decision,comment,goal_version,task_epoch) values(${auth.tenantId},${rid},${id},${submission.id},${auth.principalId},${input.decision},${input.comment},${t.goal_version},${t.execution_epoch})`.execute(
              tx,
            );
            const updated = await save(tx, t, state);
            if (terminal(updated.status)) await supersede(tx, auth, id);
            await event(tx, auth, updated, 'task.reviewed', {
              review_id: rid,
              submission_id: submission.id,
              decision: input.decision,
            });
            return rid;
          },
        );
        await access(tx, auth, await row(tx, id));
        return reviewDto(
          (await sql<ReviewRow>`select * from task_reviews where id=${rid}`.execute(tx)).rows[0]!,
        );
      });
    },
    async reviews(auth: AuthContext, id: string) {
      return transaction(auth, async (tx) => {
        await access(tx, auth, await row(tx, id));
        return assertContract('TaskReviewPage', {
          items: (
            await sql<ReviewRow>`select * from task_reviews where task_id=${id} order by created_at,id limit 200`.execute(
              tx,
            )
          ).rows.map(reviewDto),
        });
      });
    },
  };
}
type ReviewRow = {
  id: string;
  task_id: string;
  submission_id: string;
  reviewer_id: string;
  decision: 'accept' | 'return';
  comment: string;
  goal_version: string;
  task_epoch: string;
  created_at: Date;
};
const submissionDto = (s: SubmissionRow) =>
  assertContract('Submission', {
    id: s.id,
    task_id: s.task_id,
    submitted_by: s.submitted_by,
    goal_version: s.goal_version,
    execution_epoch: s.task_epoch,
    summary: s.summary,
    evidence: s.evidence,
    created_at: s.created_at.toISOString(),
  });
const reviewDto = (r: ReviewRow) =>
  assertContract('TaskReview', {
    id: r.id,
    task_id: r.task_id,
    submission_id: r.submission_id,
    reviewer_id: r.reviewer_id,
    decision: r.decision,
    comment: r.comment,
    goal_version: r.goal_version,
    execution_epoch: r.task_epoch,
    created_at: r.created_at.toISOString(),
  });
export type TaskService = ReturnType<typeof createTaskService>;
