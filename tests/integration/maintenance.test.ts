import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  createTaskService,
  createTaskMaintenance,
  MAINTENANCE_PRINCIPAL_ID,
  taskOwnerAvailable,
} from '@imbox/application';
import { sql, withTenant } from '@imbox/db';
import { assertContract, type ContractTypes as C } from '@imbox/contracts';
import { testDatabases, tenantFixture } from '../helpers/database.js';
let db: Awaited<ReturnType<typeof testDatabases>>;
let f: Awaited<ReturnType<typeof tenantFixture>>;
const secret = 'maintenance-test-cursor-key-more-than-thirty-two-characters';
const key = () => randomUUID();
const tasks = () => createTaskService(db.db, secret);
const maintenance = () => createTaskMaintenance(db.db, secret);
beforeAll(async () => {
  db = await testDatabases();
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  f = await tenantFixture(db.owner);
});
async function create() {
  return tasks().createTask(
    f.alice,
    {
      workspace_id: f.workspaceId,
      title: 'Private task title',
      goal: 'Private task goal',
      acceptance_criteria: ['Check evidence'],
      reviewer_principal_ids: [f.alice.principalId],
      budget: { currency: 'USD', limit_microunits: '100' },
    },
    key(),
  );
}
function proposal(t: C['Task']): C['WorkProposal'] {
  return {
    title: t.title,
    goal: t.goal,
    inputs: [],
    deliverable_schema: 'imbox.text-evidence.v1',
    acceptance: { criteria: ['Check evidence'], reviewer_principal_ids: [f.alice.principalId] },
    budget: { currency: 'USD', limit_microunits: '100' },
    allowed_actions: [],
    disclosure: { scope: 'request_recipients', summary: 'Explicitly disclosed terms' },
    dependencies: [],
    cancellation_rule: 'owner_or_accountable',
    escalation_principal_id: f.alice.principalId,
    handoff: { completed_summary: '', pending_summary: 'All work remains', pending_action_ids: [] },
  };
}
async function handoff(t: C['Task']) {
  const request = await tasks().createRequest(
    f.alice,
    t.id,
    {
      kind: 'handoff',
      recipient_principal_id: f.bob.principalId,
      proposal: proposal(t),
      request_expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    t.version,
    key(),
  );
  await tasks().decideRequest(
    f.bob,
    request.id,
    {
      decision: 'accept',
      proposal_version: request.proposal_version,
      expected_task_version: request.expected_task_version,
    },
    request.version,
    key(),
  );
  return tasks().getTask(f.alice, t.id);
}
describe('durable task maintenance and escalation', () => {
  it('blocks an unavailable owner once under concurrent scans and audits the service identity', async () => {
    let t = await handoff(await create());
    t = await tasks().changeState(f.bob, t.id, { state: 'active' }, t.version, key());
    await db.identityDb
      .updateTable('principals')
      .set({ status: 'disabled', version: sql`version+1` })
      .where('id', '=', f.bob.principalId)
      .execute();
    await withTenant(db.db, f.tenantId, async (tx) =>
      expect(
        await taskOwnerAvailable(tx, {
          id: t.id,
          workspace_id: f.workspaceId,
          owner_principal_id: f.bob.principalId,
        }),
      ).toBe(false),
    );
    const results = await Promise.all([
      maintenance().process(f.tenantId),
      maintenance().process(f.tenantId),
    ]);
    expect(results.reduce((sum, r) => sum + r.blocked, 0)).toBe(1);
    const updated = await tasks().getTask(f.alice, t.id);
    expect(updated.status).toBe('blocked');
    expect(BigInt(updated.execution_epoch)).toBe(BigInt(t.execution_epoch) + 1n);
    const list = await maintenance().listEscalations(f.alice);
    assertContract('TaskEscalationPage', list);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      task_id: t.id,
      reason: 'owner_unavailable',
      assigned_to: f.alice.principalId,
    });
    expect(JSON.stringify(list)).not.toContain(t.goal);
    expect((await maintenance().listEscalations(f.charlie)).items).toEqual([]);
    await withTenant(db.db, f.tenantId, async (tx) => {
      const events = (
        await sql<{
          actor_principal_id: string;
        }>`select actor_principal_id from domain_events where event_type='task.escalated'`.execute(
          tx,
        )
      ).rows;
      expect(events).toEqual([{ actor_principal_id: MAINTENANCE_PRINCIPAL_ID }]);
    });
    await tasks().takeover(
      f.alice,
      t.id,
      { reason: 'Recover responsibility' },
      updated.version,
      key(),
    );
    await maintenance().process(f.tenantId);
    expect((await maintenance().listEscalations(f.alice)).items).toEqual([]);
  });
  it('detects loss of the owner participant independently of global identity or workspace membership', async () => {
    const t = await create();
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update task_participants set status='removed' where task_id=${t.id} and principal_id=${f.alice.principalId}`.execute(
        tx,
      );
    });
    expect((await maintenance().process(f.tenantId)).blocked).toBe(1);
    expect((await maintenance().listEscalations(f.alice)).items[0]?.reason).toBe(
      'owner_unavailable',
    );
  });
  it('blocks an execution deadline using database time and does not execute or complete work', async () => {
    const t = await create();
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update tasks set execution_deadline=clock_timestamp()-interval '1 second' where id=${t.id}`.execute(
        tx,
      );
    });
    expect(await maintenance().process(f.tenantId)).toMatchObject({
      blocked: 1,
      expired_requests: 0,
    });
    expect((await maintenance().listEscalations(f.alice)).items[0]?.reason).toBe(
      'execution_deadline',
    );
    expect((await tasks().getTask(f.alice, t.id)).status).toBe('blocked');
  });
  it('expires requests durably without implying acceptance or changing the owner', async () => {
    const t = await create();
    const request = await tasks().createRequest(
      f.alice,
      t.id,
      {
        kind: 'handoff',
        recipient_principal_id: f.bob.principalId,
        proposal: proposal(t),
        request_expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      t.version,
      key(),
    );
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await sql`update collaboration_requests set expires_at=clock_timestamp()-interval '1 second' where id=${request.id}`.execute(
        tx,
      );
    });
    expect((await maintenance().process(f.tenantId)).expired_requests).toBe(1);
    expect((await maintenance().process(f.tenantId)).expired_requests).toBe(0);
    expect((await tasks().getRequest(f.alice, request.id)).status).toBe('expired');
    expect((await tasks().getTask(f.alice, t.id)).owner_principal_id).toBe(f.alice.principalId);
  });
  it('routes unresolved escalation to active workspace administrators after the assignee leaves', async () => {
    const t = await handoff(await create());
    await db.identityDb
      .updateTable('principals')
      .set({ status: 'disabled' })
      .where('id', '=', f.bob.principalId)
      .execute();
    await maintenance().process(f.tenantId);
    await withTenant(db.owner, f.tenantId, async (tx) => {
      await tx
        .updateTable('memberships')
        .set({ status: 'disabled' })
        .where('principal_id', '=', f.alice.principalId)
        .execute();
      await tx
        .updateTable('memberships')
        .set({ role: 'admin' })
        .where('principal_id', '=', f.charlie.principalId)
        .execute();
    });
    await maintenance().process(f.tenantId);
    expect((await maintenance().listEscalations(f.alice)).items).toEqual([]);
    expect((await maintenance().listEscalations(f.charlie)).items).toEqual([
      expect.objectContaining({ task_id: t.id, assigned_to: null }),
    ]);
    await expect(tasks().getTask(f.charlie, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
