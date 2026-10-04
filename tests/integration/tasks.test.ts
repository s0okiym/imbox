import { randomUUID } from 'node:crypto';
import { createIdentityService } from '@imbox/auth';
import { createApp } from '../../apps/api/src/app.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTaskService,
  createMessagingService,
  type TaskService,
  type MessagingService,
} from '@imbox/application';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import { sql, withTenant } from '@imbox/db';
import { tenantFixture, testDatabases } from '../helpers/database.js';
import { requiredActionsClosed } from '@imbox/actions';
import { runtimeCompletionGate } from '@imbox/runtime';

let databases: Awaited<ReturnType<typeof testDatabases>>;
let fixture: Awaited<ReturnType<typeof tenantFixture>>;
let tasks: TaskService;
let messaging: MessagingService;
const secret = 'a-task-cursor-secret-longer-than-thirty-two-characters';
const key = () => randomUUID();
function nonempty<T>(values:T[]):[T,...T[]] { if (!values.length) throw new Error('Expected nonempty test fixture'); return [values[0]!,...values.slice(1)]; }
beforeAll(async () => {
  databases = await testDatabases();
  tasks = createTaskService(databases.db, secret, {requiredActionsClosed:async(tx,id)=>await runtimeCompletionGate(tx,id)&&await requiredActionsClosed(tx,id)});
  messaging = createMessagingService(databases.db, secret);
});
afterAll(async () => {
  await databases?.close();
});
beforeEach(async () => {
  fixture = await tenantFixture(databases.owner);
});
const create = (auth = fixture.alice) =>
  tasks.createTask(
    auth,
    {
      workspace_id: fixture.workspaceId,
      title: 'Private task',
      goal: 'Deliver a verified report',
      acceptance_criteria: ['Evidence identifies its sources'],
      reviewer_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '1000000' },
    },
    key(),
  );
function proposal(
  t: C['Task'],
  kind: 'consult' | 'review' | 'delegate' | 'handoff' = 'handoff',
): C['WorkProposal'] {
  return {
    title: t.title,
    goal: t.goal,
    inputs: [],
    deliverable_schema: 'imbox.text-evidence.v1',
    acceptance: {
      criteria: nonempty(t.acceptance_criteria),
      reviewer_principal_ids: nonempty(t.reviewer_principal_ids),
    },
    budget: { currency: t.budget.currency, limit_microunits: t.budget.limit_microunits },
    allowed_actions: [],
    disclosure: { scope: 'request_recipients', summary: 'Explicitly disclosed work terms' },
    dependencies: [],
    cancellation_rule: 'owner_or_accountable',
    escalation_principal_id: fixture.alice.principalId,
    ...(kind === 'handoff'
      ? {
          handoff: {
            completed_summary: '',
            pending_summary: 'All work remains',
            pending_action_ids: [],
          },
        }
      : {}),
  };
}
const request = (
  t: C['Task'],
  kind: 'consult' | 'review' | 'delegate' | 'handoff' = 'handoff',
  recipient = fixture.bob.principalId,
  auth = fixture.alice,
) =>
  tasks.createRequest(
    auth,
    t.id,
    {
      kind,
      recipient_principal_id: recipient,
      proposal: proposal(t, kind),
      request_expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    t.version,
    key(),
  );
const decide = (
  r: C['CollaborationRequest'],
  auth = fixture.bob,
  decision: 'accept' | 'reject' | 'clarify' = 'accept',
  token = key(),
) =>
  tasks.decideRequest(
    auth,
    r.id,
    {
      decision,
      proposal_version: r.proposal_version,
      expected_task_version: r.expected_task_version,
    },
    r.version,
    token,
  );
const activate = (t: C['Task'], auth = fixture.alice) =>
  tasks.changeState(auth, t.id, { state: 'active' }, t.version, key());
const submit = (t: C['Task'], auth = fixture.alice) =>
  tasks.submit(
    auth,
    t.id,
    {
      goal_version: t.goal_version,
      summary: 'A frozen text deliverable',
      evidence: [
        { type: 'text', text: 'Verifiable result, including limitations.', source_refs: [] },
      ],
    },
    t.version,
    key(),
  );

describe('real PostgreSQL M2 collaboration and task fences', () => {
  it('creates one independent task with self owner, exact bigint budget and one durable event', async () => {
    const input: C['CreateTaskInput'] = {
      workspace_id: fixture.workspaceId,
      title: 'One task',
      goal: 'Bounded work',
      acceptance_criteria: ['Check result'],
      reviewer_principal_ids: [fixture.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '9007199254740993' },
    };
    const token = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tasks.createTask(fixture.alice, input, token)),
    );
    expect(new Set(results.map((t) => t.id)).size).toBe(1);
    const t = results[0]!;
    expect(t.owner_principal_id).toBe(fixture.alice.principalId);
    expect(t.budget.limit_microunits).toBe(input.budget.limit_microunits);
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect((await sql`select * from tasks`.execute(tx)).rows).toHaveLength(1);
      expect(
        (await sql`select * from domain_events where aggregate_type='task'`.execute(tx)).rows,
      ).toHaveLength(1);
    });
    expect(() =>
      assertContract('CreateTaskInput', { ...input, owner_principal_id: fixture.bob.principalId }),
    ).toThrow();
  });
  it('conversation summary discloses only its explicit text and never grants task ACL, including another tenant', async () => {
    const t = await create();
    const c = await messaging.createConversation(
      fixture.alice,
      { workspace_id: fixture.workspaceId, kind: 'group', member_ids: [fixture.bob.principalId] },
      key(),
    );
    await tasks.linkConversation(
      fixture.alice,
      t.id,
      { conversation_id: c.id, public_summary: 'A report is planned' },
      t.version,
      key(),
    );
    expect((await tasks.conversationSummaries(fixture.bob, c.id)).items).toEqual([
      { task_id: t.id, conversation_id: c.id, public_summary: 'A report is planned', version: '1' },
    ]);
    await expect(tasks.getTask(fixture.bob, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await tasks.listTasks(fixture.bob)).items).toEqual([]);
    const other = await tenantFixture(databases.owner);
    await expect(tasks.getTask(other.alice, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(tasks.conversationSummaries(fixture.charlie, c.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('revoked task and workspace membership defeat existing task references and idempotent replays', async () => {
    let t = await create();
    t = await tasks.changeParticipant(
      fixture.alice,
      t.id,
      fixture.bob.principalId,
      'observer',
      t.version,
      key(),
    );
    expect((await tasks.getTask(fixture.bob, t.id)).id).toBe(t.id);
    t = await tasks.changeParticipant(
      fixture.alice,
      t.id,
      fixture.bob.principalId,
      null,
      t.version,
      key(),
    );
    await expect(tasks.getTask(fixture.bob, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update memberships set status='disabled' where principal_id=${fixture.alice.principalId}`.execute(
        tx,
      ),
    );
    await expect(tasks.getTask(fixture.alice, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await tasks.listTasks(fixture.alice)).items).toEqual([]);
  });
  it('only the actual recipient accepts; concurrent competing handoffs yield one owner and fixed agreement', async () => {
    const t = await create();
    const bob = await request(t);
    const charlie = await request(t, 'handoff', fixture.charlie.principalId);
    await expect(decide(bob, fixture.alice)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const results = await Promise.allSettled([
      decide(bob, fixture.bob),
      decide(charlie, fixture.charlie),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const current = await tasks.getTask(fixture.alice, t.id);
    expect([fixture.bob.principalId, fixture.charlie.principalId]).toContain(
      current.owner_principal_id,
    );
    expect(current.execution_epoch).toBe('2');
    expect(current.version).toBe('2');
    await withTenant(databases.db, fixture.tenantId, async (tx) => {
      expect((await sql`select * from agreements`.execute(tx)).rows).toHaveLength(1);
      expect(
        (
          await sql`select * from task_participants where role='owner' and status='active'`.execute(
            tx,
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (await sql`select * from request_decisions where decision='accept'`.execute(tx)).rows,
      ).toHaveLength(1);
    });
  });
  it('same acceptance idempotency key returns exactly one accepted version and never a second handoff', async () => {
    const t = await create();
    const r = await request(t);
    const token = key();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => decide(r, fixture.bob, 'accept', token)),
    );
    expect(new Set(results.map((v) => v.agreement!.id)).size).toBe(1);
    expect(results[0]!.agreement!.accepted_version).toBe('1');
    expect((await tasks.getTask(fixture.bob, t.id)).execution_epoch).toBe('2');
    await expect(
      tasks.withdrawRequest(
        fixture.alice,
        r.id,
        { reason: 'undo' },
        results[0]!.request.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
  it('clarification and revision retain immutable proposals and reject a stale proposal number', async () => {
    const t = await create();
    const original = await request(t, 'consult');
    const clarification = await decide(original, fixture.bob, 'clarify');
    expect(clarification.request.status).toBe('clarification_requested');
    const revised = await tasks.reviseRequest(
      fixture.alice,
      original.id,
      {
        proposal: { ...proposal(t, 'consult'), goal: 'Clarified scope' },
        request_expires_at: new Date(Date.now() + 7200000).toISOString(),
        expected_task_version: t.version,
      },
      clarification.request.version,
      key(),
    );
    expect(revised.proposal_version).toBe('2');
    await expect(
      tasks.decideRequest(
        fixture.bob,
        revised.id,
        { decision: 'accept', proposal_version: '1', expected_task_version: t.version },
        revised.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_CONFLICT' });
    const accepted = await decide(revised);
    expect(accepted.agreement!.terms.goal).toBe('Clarified scope');
    expect(accepted.agreement!.accepted_version).toBe('2');
    await withTenant(databases.db, fixture.tenantId, async (tx) =>
      expect(
        (await sql`select * from request_proposals order by proposal_version`.execute(tx)).rows,
      ).toHaveLength(2),
    );
  });
  it('rejection and expiry never create a child or transfer ownership', async () => {
    const t = await create();
    const rejected = await request(t, 'delegate');
    expect((await decide(rejected, fixture.bob, 'reject')).request.status).toBe('rejected');
    const expiring = await request(t, 'delegate', fixture.charlie.principalId);
    await withTenant(databases.owner, fixture.tenantId, (tx) =>
      sql`update collaboration_requests set expires_at=now()-interval '1 second' where id=${expiring.id}`.execute(
        tx,
      ),
    );
    await expect(decide(expiring, fixture.charlie)).rejects.toMatchObject({
      code: 'REQUEST_EXPIRED',
    });
    await withTenant(databases.db, fixture.tenantId, async (tx) =>
      expect((await sql`select * from tasks`.execute(tx)).rows).toHaveLength(1),
    );
  });
  it('delegation creates one child only after acceptance and preserves parent ownership', async () => {
    const t = await create();
    const r = await request(t, 'delegate');
    await withTenant(databases.db, fixture.tenantId, async (tx) =>
      expect((await sql`select * from tasks`.execute(tx)).rows).toHaveLength(1),
    );
    const token = key();
    const accepted = await Promise.all(
      Array.from({ length: 4 }, () => decide(r, fixture.bob, 'accept', token)),
    );
    const childId = accepted[0]!.agreement!.child_task_id!;
    expect(new Set(accepted.map((a) => a.agreement!.child_task_id)).size).toBe(1);
    const child = await tasks.getTask(fixture.bob, childId);
    expect(child.parent_task_id).toBe(t.id);
    expect(child.root_task_id).toBe(t.id);
    expect(child.owner_principal_id).toBe(fixture.bob.principalId);
    expect(child.accountable_principal_id).toBe(fixture.alice.principalId);
    expect((await tasks.getTask(fixture.alice, t.id)).owner_principal_id).toBe(
      fixture.alice.principalId,
    );
    await expect(tasks.getTask(fixture.bob, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('terminal and reopen advance epochs and make old pending proposals permanently unusable', async () => {
    const t = await create();
    const r = await request(t);
    const cancelled = await tasks.cancelTask(
      fixture.alice,
      t.id,
      { reason: 'Scope withdrawn' },
      t.version,
      key(),
    );
    expect(cancelled.execution_epoch).toBe('2');
    const reopened = await tasks.reopenTask(
      fixture.alice,
      t.id,
      { reason: 'New baseline', acceptance_criteria: ['Fresh evidence'] },
      cancelled.version,
      key(),
    );
    expect(reopened.execution_epoch).toBe('3');
    expect(reopened.goal_version).toBe('2');
    await expect(decide(r)).rejects.toBeDefined();
    expect((await tasks.getRequest(fixture.bob, r.id)).status).toBe('superseded');
  });
  it('a parent close/reopen invalidates a previously issued child proposal through complete ancestor fences', async () => {
    let parent = await create();
    const delegated = await decide(await request(parent, 'delegate'));
    const child = await tasks.getTask(fixture.bob, delegated.agreement!.child_task_id!);
    const childRequest = await request(child, 'consult', fixture.charlie.principalId, fixture.bob);
    parent = await tasks.getTask(fixture.alice, parent.id);
    parent = await tasks.cancelTask(
      fixture.alice,
      parent.id,
      { reason: 'Stop tree' },
      parent.version,
      key(),
    );
    await tasks.reopenTask(
      fixture.alice,
      parent.id,
      { reason: 'New execution', acceptance_criteria: nonempty(parent.acceptance_criteria) },
      parent.version,
      key(),
    );
    await expect(decide(childRequest, fixture.charlie)).rejects.toMatchObject({
      code: 'EXECUTION_FENCE_CONFLICT',
    });
  });
  it('serializes cross-root dependency mutation before sorted root locks and rejects the combined cycle', async () => {
    const a = await create();
    const b = await create();
    const outcomes = await Promise.allSettled([
      tasks.addDependency(fixture.alice, a.id, { prerequisite_task_id: b.id }, a.version, key()),
      tasks.addDependency(fixture.alice, b.id, { prerequisite_task_id: a.id }, b.version, key()),
    ]);
    expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((v) => v.status === 'rejected')).toMatchObject({
      reason: { code: 'DEPENDENCY_CYCLE' },
    });
    const dependent = outcomes[0]!.status === 'fulfilled' ? a : b;
    const current = await tasks.getTask(fixture.alice, dependent.id);
    await expect(activate(current)).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
  });
  it('pins submission text/hash/goal version, restricts acceptance to designated reviewers and completes separately', async () => {
    let t = await create();
    t = await tasks.changeParticipant(
      fixture.alice,
      t.id,
      fixture.bob.principalId,
      'contributor',
      t.version,
      key(),
    );
    t = await activate(t);
    const s = await submit(t, fixture.bob);
    expect(s.evidence[0]).toMatchObject({
      type: 'text',
      text: 'Verifiable result, including limitations.',
    });
    expect(s.evidence[0]).toHaveProperty('sha256');
    t = await tasks.getTask(fixture.alice, t.id);
    expect(t.status).toBe('in_review');
    await expect(
      tasks.review(
        fixture.bob,
        t.id,
        { submission_id: s.id, decision: 'accept', comment: 'I finished it' },
        t.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const review = await tasks.review(
      fixture.alice,
      t.id,
      { submission_id: s.id, decision: 'accept', comment: 'Evidence verified' },
      t.version,
      key(),
    );
    expect(review.submission_id).toBe(s.id);
    const done = await tasks.getTask(fixture.alice, t.id);
    expect(done.status).toBe('completed');
    expect(done.execution_epoch).toBe('2');
  });
  it('does not complete a parent while an accepted child remains open', async () => {
    let t = await create();
    await decide(await request(t, 'delegate'));
    t = await tasks.getTask(fixture.alice, t.id);
    t = await activate(t);
    const s = await submit(t);
    t = await tasks.getTask(fixture.alice, t.id);
    await expect(
      tasks.review(
        fixture.alice,
        t.id,
        { submission_id: s.id, decision: 'accept', comment: 'Cannot skip child' },
        t.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'ACCEPTANCE_REQUIRED' });
    expect((await tasks.reviews(fixture.alice, t.id)).items).toEqual([]);
  });
  it('rejects old goal submissions and artifact refs until their storage/authorization implementation exists', async () => {
    let t = await activate(await create());
    const old = await submit(t);
    t = await tasks.getTask(fixture.alice, t.id);
    t = await tasks.updateTask(fixture.alice, t.id, { goal: 'New goal' }, t.version, key());
    expect(t.status).toBe('active');
    expect(t.goal_version).toBe('2');
    await expect(
      tasks.review(
        fixture.alice,
        t.id,
        { submission_id: old.id, decision: 'accept', comment: 'Wrong goal' },
        t.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'EXECUTION_FENCE_CONFLICT' });
    await expect(
      tasks.submit(
        fixture.alice,
        t.id,
        {
          goal_version: t.goal_version,
          summary: 'Unverified artifact',
          evidence: [
            {
              type: 'artifact_version',
              artifact_id: key(),
              version_id: key(),
              sha256: 'a'.repeat(64),
            },
          ],
        },
        t.version,
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('takeover is an explicit admin command with a reason, new owner and epoch', async () => {
    let t = await create(fixture.bob);
    await expect(
      tasks.takeover(fixture.charlie, t.id, { reason: 'No authority' }, t.version, key()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    t = await tasks.takeover(
      fixture.alice,
      t.id,
      { reason: 'Owner unavailable; human intervention' },
      t.version,
      key(),
    );
    expect(t.owner_principal_id).toBe(fixture.alice.principalId);
    expect(t.execution_epoch).toBe('2');
  });
});

describe('M2 HTTP commands with real cookie authentication and contracts', () => {
  it('creates, reads, proposes and accepts with authoritative identity, version headers and CSRF', async () => {
    const origin = 'http://localhost:5173';
    const identity = createIdentityService({
      db: databases.db,
      identityDb: databases.identityDb,
      publicOrigin: origin,
      sessionSecret: secret,
      environment: 'test',
      enableDevAuth: true,
      devPrincipalIds: [fixture.alice.principalId, fixture.bob.principalId],
    });
    const app = createApp({ readiness: async () => {}, identity, messaging, tasks });
    try {
      await app.ready();
      async function login(principalId: string) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/auth/dev-login',
          headers: { origin },
          payload: { principal_id: principalId },
        });
        expect(response.statusCode).toBe(200);
        return {
          origin,
          cookie: `imbox_session=${response.cookies.find((c) => c.name === 'imbox_session')!.value}`,
          'x-csrf-token': response.json<{ csrf_token: string }>().csrf_token,
          'x-imbox-tenant-id': fixture.tenantId,
        };
      }
      const alice = await login(fixture.alice.principalId);
      const bob = await login(fixture.bob.principalId);
      const input = {
        workspace_id: fixture.workspaceId,
        title: 'HTTP task',
        goal: 'A verified handoff',
        acceptance_criteria: ['Explicit acceptance'],
        reviewer_principal_ids: [fixture.alice.principalId],
        budget: { currency: 'USD', limit_microunits: '1000000' },
      };
      const forged = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { ...alice, 'idempotency-key': key() },
        payload: { ...input, owner_principal_id: fixture.bob.principalId },
      });
      expect(forged.statusCode).toBe(400);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { ...alice, 'idempotency-key': key() },
        payload: input,
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers.etag).toBe('"1"');
      const task = created.json<C['Task']>();
      const get = await app.inject({ url: `/v1/tasks/${task.id}`, headers: alice });
      expect(get.statusCode).toBe(200);
      expect(get.json<C['Task']>().id).toBe(task.id);
      const denied = await app.inject({ url: `/v1/tasks/${task.id}`, headers: bob });
      expect(denied.statusCode).toBe(404);
      const noVersion = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/requests`,
        headers: { ...alice, 'idempotency-key': key() },
        payload: {
          kind: 'handoff',
          recipient_principal_id: fixture.bob.principalId,
          proposal: proposal(task),
          request_expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(noVersion.statusCode).toBe(400);
      const proposed = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/requests`,
        headers: { ...alice, 'idempotency-key': key(), 'if-match': '"1"' },
        payload: {
          kind: 'handoff',
          recipient_principal_id: fixture.bob.principalId,
          proposal: proposal(task),
          request_expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      expect(proposed.statusCode).toBe(201);
      const request = proposed.json<C['CollaborationRequest']>();
      const wrongActor = await app.inject({
        method: 'POST',
        url: `/v1/requests/${request.id}/decisions`,
        headers: { ...alice, 'idempotency-key': key(), 'if-match': '"1"' },
        payload: { decision: 'accept', proposal_version: '1', expected_task_version: '1' },
      });
      expect(wrongActor.statusCode).toBe(403);
      const accepted = await app.inject({
        method: 'POST',
        url: `/v1/requests/${request.id}/decisions`,
        headers: { ...bob, 'idempotency-key': key(), 'if-match': '"1"' },
        payload: { decision: 'accept', proposal_version: '1', expected_task_version: '1' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<C['RequestDecisionResult']>().agreement!.accepted_by).toBe(
        fixture.bob.principalId,
      );
      const owned = await app.inject({ url: `/v1/tasks/${task.id}`, headers: bob });
      expect(owned.statusCode).toBe(200);
      expect(owned.json<C['Task']>().owner_principal_id).toBe(fixture.bob.principalId);
      const missingCsrf = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/cancel`,
        headers: { ...bob, 'x-csrf-token': '', 'idempotency-key': key(), 'if-match': '"2"' },
        payload: { reason: 'Not authorized without CSRF' },
      });
      expect(missingCsrf.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
